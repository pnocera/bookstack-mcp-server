/**
 * Live integration tests for the five BookStack image tools.
 *
 * These drive the real `MCPTool` handlers through a real `BookStackClient`
 * against a live BookStack, because the bug they exist to catch - GitHub issue
 * #8 - lives in the *wire format*, not in the tool layer: the client used to
 * serialise gallery uploads as `application/json`, which BookStack answers with
 * 500/422. A mocked client cannot tell you that multipart works; only a real
 * response and real PNG bytes read back out of the gallery can.
 *
 * How a status code is observed here: the client's axios instance rejects every
 * non-2xx response (the interceptor turns it into an `McpError`), so a handler
 * that *resolves* is itself proof of a 2xx. The issue-#8 failure mode would
 * surface as a thrown error, not as a passing test with a wrong body. Where it
 * is cheap, a status code is also asserted directly via `apiFetch`.
 *
 * Isolation: this suite shares its BookStack with other suites. It therefore
 * asserts only on entities it created - located by ids captured at creation and
 * by unique names - and never on global counts or list completeness.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { ImageTools } from '../../src/tools/images';
import type { Image, ImageDetail, ListResponse, MCPTool } from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  apiFetch,
  apiJson,
  type BookStackHarness,
  CleanupTracker,
  ensureBookStack,
  shouldRunIntegration,
} from './helpers/bookstack';

/** PNG magic bytes. Real image content starts with these; base64 text and JSON do not. */
const PNG_SIGNATURE = '89504e470d0a1a0a';

/** A 1x1 red PNG (70 bytes) and a 1x1 transparent PNG (68 bytes). */
const PNG_RED_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_TRANSPARENT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const PNG_RED = Buffer.from(PNG_RED_BASE64, 'base64');
const PNG_TRANSPARENT = Buffer.from(PNG_TRANSPARENT_BASE64, 'base64');

/**
 * Live payloads recorded verbatim from v26.05.2, checked against the exported types at
 * compile time.
 *
 * This suite used to declare its own `ImagePayload`, which let the exported image types
 * stay wrong while every test passed green. The types are the contract this server
 * publishes, so they are what the tests assert against now, and `satisfies` pins them to
 * reality from both sides: a field BookStack sends that the type does not declare is an
 * excess-property error, and a field the type requires that BookStack does not send is a
 * missing-property error.
 */

/** `GET /image-gallery`: the bare exposed columns, with plain user IDs. */
const LIVE_IMAGE = {
  id: 549,
  name: 'itest-img.png',
  url: 'http://localhost:6875/uploads/images/gallery/2026-07/itest.png',
  path: '/uploads/images/gallery/2026-07/itest.png',
  type: 'gallery',
  uploaded_to: 2229,
  created_by: 1,
  updated_by: 1,
  created_at: '2026-07-16T12:26:29.000000Z',
  updated_at: '2026-07-16T12:26:29.000000Z',
} satisfies Image;

/**
 * Every single-image endpoint - `GET`, `POST` and `PUT` on /image-gallery - runs
 * `formatForSingleResponse()`, which expands the creator relations and appends `thumbs`
 * and `content`.
 */
const LIVE_IMAGE_DETAIL = {
  id: 547,
  name: 'itest-img.png',
  url: 'http://localhost:6875/uploads/images/gallery/2026-07/itest.png',
  path: '/uploads/images/gallery/2026-07/itest.png',
  type: 'gallery',
  uploaded_to: 2227,
  created_by: { id: 1, name: 'Admin', slug: 'admin' },
  updated_by: { id: 1, name: 'Admin', slug: 'admin' },
  created_at: '2026-07-16T12:26:12.000000Z',
  updated_at: '2026-07-16T12:26:12.000000Z',
  thumbs: {
    gallery: 'http://localhost:6875/uploads/images/gallery/2026-07/thumbs-150-150/itest.png',
    display: 'http://localhost:6875/uploads/images/gallery/2026-07/scaled-1680-/itest.png',
  },
  content: {
    html: '<a href="http://localhost:6875/uploads/images/gallery/2026-07/itest.png" target="_blank"><img src="http://localhost:6875/uploads/images/gallery/2026-07/scaled-1680-/itest.png" alt="itest-img.png"></a>',
    markdown:
      '![itest-img.png](http://localhost:6875/uploads/images/gallery/2026-07/scaled-1680-/itest.png)',
  },
} satisfies ImageDetail;

/**
 * BookStack throttles its API *per user*, and the harness hands every suite the
 * same admin token, so a suite can be throttled purely because a sibling suite
 * was busy - an artefact of the shared fixture, not a behaviour under test. So
 * 429s, and only 429s, are waited out and retried; every other error propagates
 * untouched and still fails the test. The budget refills over a 60s window,
 * which is what bounds the backoff.
 *
 * The test instance is configured well above the 180/min default
 * (`X-RateLimit-Limit: 5000`), so this should now essentially never fire. It is
 * kept because the default still applies to a real deployment, and because a
 * retry that never triggers costs nothing.
 */
const RATE_LIMIT_ATTEMPTS = 10;
const RATE_LIMIT_BACKOFF_MS = 8000;

/** Did BookStack reject this with 429? `ErrorHandler` puts the status on `data`. */
function isRateLimited(error: unknown): boolean {
  const data = (error as { data?: { status?: number } } | null)?.data;
  return data?.status === 429;
}

/** Run `operation`, waiting out the shared instance's rate limiter if it bites. */
async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RATE_LIMIT_ATTEMPTS || !isRateLimited(error)) {
        throw error;
      }
      await Bun.sleep(RATE_LIMIT_BACKOFF_MS);
    }
  }
}

/** `apiFetch()` that likewise waits out a 429 rather than reporting it as failure. */
async function apiFetchRetrying(
  harness: BookStackHarness,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await apiFetch(harness, path, init);
    if (response.status !== 429 || attempt >= RATE_LIMIT_ATTEMPTS) {
      return response;
    }
    await Bun.sleep(RATE_LIMIT_BACKOFF_MS);
  }
}

/** Env vars `readGuardedUploadFile()` consults; saved and restored around each test. */
const GUARD_ENV = ['MCP_TRANSPORT', 'BOOKSTACK_UPLOAD_ROOT'] as const;
type GuardEnvKey = (typeof GUARD_ENV)[number];

function setGuardEnv(key: GuardEnvKey, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** A name no other suite (or run) can collide with. */
function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generous, because a contended instance can make any call sit out a 429 window. */
const TEST_TIMEOUT_MS = 180_000;

const runIntegration = await shouldRunIntegration();

describe.skipIf(!runIntegration)('BookStack image tools (live)', () => {
  let harness: BookStackHarness;
  let imageTools: ImageTools;

  /** Fixtures hosting the images: `uploaded_to` is required and takes a page id. */
  let bookId: number;
  let pageId: number;
  /**
   * A second page in the same book, hosting an image the `uploaded_to` filter must
   * *exclude*. Without a row the filter has to drop, an inclusion-only assertion
   * passes just as well against an unfiltered gallery.
   */
  let otherPageId: number;

  /** Temp dir backing the `file_path` tests: `<tmpBase>/uploads` is the allowed root. */
  let tmpBase: string;
  let uploadRoot: string;

  const savedEnv = new Map<GuardEnvKey, string | undefined>();
  /**
   * Everything this file created, so a failed assertion still gets cleaned up - and so
   * teardown fails loudly rather than dropping an id whose delete BookStack refused.
   */
  const cleanup = new CleanupTracker();

  const findTool = (name: string): MCPTool => {
    const tool = imageTools.getTools().find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool;
  };

  /** Invoke a tool handler for real, tolerating only the shared instance's 429s. */
  const runTool = async (name: string, params: Record<string, unknown>): Promise<unknown> =>
    await withRateLimitRetry(async () => await findTool(name).handler(params));

  /**
   * Narrow a handler result to the image shape asserted on below.
   *
   * `MCPTool.handler` is declared `Promise<unknown>`, so every result needs narrowing.
   * Like `apiJson()`, this is an assertion rather than validation - the `expect`s in each
   * test are what actually check the payload. Every single-image endpoint returns
   * `ImageDetail`; only the listing returns the barer `Image`.
   */
  const asImage = (result: unknown): ImageDetail => result as ImageDetail;

  /** Create a gallery image through the tool, tracking it for cleanup. */
  const createImage = async (params: Record<string, unknown>): Promise<ImageDetail> => {
    const image = asImage(
      await runTool('bookstack_images_create', { uploaded_to: pageId, ...params })
    );
    cleanup.track('image', image.id);
    return image;
  };

  /**
   * Download the stored image. The URL is stable across content replacement, so
   * a cache-buster keeps an updated body from being served from any cache.
   *
   * Takes just the `url` so it serves an `Image` and an `ImageDetail` alike.
   */
  const downloadImage = async (image: Pick<Image, 'url'>): Promise<Response> =>
    await fetch(`${image.url}?cache-bust=${Date.now()}-${Math.random()}`);

  beforeAll(async () => {
    harness = await ensureBookStack();

    for (const key of GUARD_ENV) {
      savedEnv.set(key, process.env[key]);
    }

    const logger = Logger.getInstance();
    const config: Config = {
      bookstack: { baseUrl: harness.baseUrl, apiToken: harness.token, timeout: 30_000 },
      server: { name: 'bookstack-mcp-server-itest', version: '1.0.0', port: 3000 },
      // Left well below the instance's budget so the client's own limiter is
      // genuinely exercised on the upload path rather than being a no-op.
      rateLimit: { requestsPerMinute: 120, burstLimit: 12 },
      // strictMode makes a schema violation throw rather than warn-and-continue,
      // which is what lets the rejection tests assert on a real failure.
      validation: { enabled: true, strictMode: true },
      logging: { level: 'error', format: 'json' },
      development: { nodeEnv: 'test', debug: false },
    };
    const client = new BookStackClient(config, logger, new ErrorHandler(logger));
    imageTools = new ImageTools(
      client,
      new ValidationHandler({ enabled: true, strictMode: true }),
      logger
    );

    // Fixtures are built with the raw API, not with the book/page tools: this
    // suite is about images, and a fixture failure should not read as one.
    const bookRes = await apiFetchRetrying(harness, '/books', {
      method: 'POST',
      body: JSON.stringify({ name: uniqueName('itest-img-book') }),
    });
    expect(bookRes.status).toBe(200);
    bookId = (await apiJson<{ id: number }>(bookRes)).id;
    cleanup.track('book', bookId);

    const pageRes = await apiFetchRetrying(harness, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        book_id: bookId,
        name: uniqueName('itest-img-page'),
        markdown: 'Host page for the MCP image integration suite.',
      }),
    });
    expect(pageRes.status).toBe(200);
    pageId = (await apiJson<{ id: number }>(pageRes)).id;

    // The page the `uploaded_to` filter must leave out. It lives in the same book, so
    // the book's teardown carries it away.
    const otherPageRes = await apiFetchRetrying(harness, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        book_id: bookId,
        name: uniqueName('itest-img-other-page'),
        markdown: 'Second host page, so uploaded_to has something to exclude.',
      }),
    });
    expect(otherPageRes.status).toBe(200);
    otherPageId = (await apiJson<{ id: number }>(otherPageRes)).id;

    tmpBase = await mkdtemp(join(tmpdir(), 'bookstack-itest-img-'));
    uploadRoot = join(tmpBase, 'uploads');
    await mkdir(uploadRoot);
    // A readable, perfectly valid PNG that lives *outside* uploadRoot.
    await writeFile(join(tmpBase, 'outside-secret.png'), PNG_RED);
  }, TEST_TIMEOUT_MS);

  afterEach(() => {
    for (const key of GUARD_ENV) {
      setGuardEnv(key, savedEnv.get(key));
    }
  });

  afterAll(async () => {
    // The temp dir is local and unconditional: it must go even if the remote
    // teardown below throws, so it runs first.
    if (tmpBase) {
      await rm(tmpBase, { recursive: true, force: true });
    }
    if (!harness) return;

    // Images are hard-deleted; the book is soft-deleted and its own bin entry purged
    // (only ours - the shared bin is never emptied). This was a
    // `.catch(() => {})` loop, which suppressed nothing: `fetch` resolves for 4xx/5xx,
    // so a refused delete dropped its id exactly like a successful one. `cleanup.run()`
    // checks each status, re-reads each id, and throws listing whatever survived.
    await cleanup.run(harness);
  }, TEST_TIMEOUT_MS);

  it('registers all five image tools', () => {
    const names = imageTools.getTools().map((tool) => tool.name);

    expect(names).toEqual([
      'bookstack_images_list',
      'bookstack_images_create',
      'bookstack_images_read',
      'bookstack_images_update',
      'bookstack_images_delete',
    ]);
  });

  /**
   * The exported types are the contract, so they get asserted rather than paraphrased.
   *
   * The gallery listing and the single-image endpoints disagree on purpose:
   * `$fieldsToExpose` restricts the listing to bare columns, while
   * `formatForSingleResponse()` expands the creator relations and appends `thumbs` and
   * `content`. The `ImagePayload` this suite used to declare described neither
   * faithfully, so a drift in either could not fail a test.
   */
  it(
    'returns exactly the fields Image and ImageDetail declare, and no others',
    async () => {
      const name = `${uniqueName('itest-img-shape')}.png`;
      const created = await createImage({ name, image: PNG_RED_BASE64 });

      // create: the single-response shape, with expanded users, thumbs and content.
      expect(Object.keys(created).sort()).toEqual(Object.keys(LIVE_IMAGE_DETAIL).sort());
      expect(Object.keys(created.created_by).sort()).toEqual(['id', 'name', 'slug']);
      expect(Object.keys(created.updated_by).sort()).toEqual(['id', 'name', 'slug']);
      expect(Object.keys(created.thumbs).sort()).toEqual(['display', 'gallery']);
      expect(Object.keys(created.content).sort()).toEqual(['html', 'markdown']);

      // read and update return that same single-response shape.
      const read = asImage(await runTool('bookstack_images_read', { id: created.id }));
      expect(Object.keys(read).sort()).toEqual(Object.keys(LIVE_IMAGE_DETAIL).sort());

      const updated = asImage(
        await runTool('bookstack_images_update', {
          id: created.id,
          name: `${uniqueName('itest-img-shape-renamed')}.png`,
        })
      );
      expect(Object.keys(updated).sort()).toEqual(Object.keys(LIVE_IMAGE_DETAIL).sort());

      // list: the bare columns - plain user IDs, and no thumbs/content.
      const listed = (await runTool('bookstack_images_list', {
        filter: { uploaded_to: pageId, type: 'gallery' },
        count: 100,
      })) as ListResponse<Image>;
      const entry = listed.data.find((image) => image.id === created.id);
      expect(entry).toBeDefined();
      expect(Object.keys(entry as Image).sort()).toEqual(Object.keys(LIVE_IMAGE).sort());
      expect(typeof (entry as Image).created_by).toBe('number');
      expect(entry).not.toHaveProperty('thumbs');
      expect(entry).not.toHaveProperty('content');
    },
    TEST_TIMEOUT_MS
  );

  /**
   * The crux of issue #8. A JSON-serialised upload never gets this far: it fails
   * upstream with 500/422, so reaching a stored, byte-exact PNG is the proof
   * that the request left as real multipart/form-data.
   */
  it(
    'creates an image from base64 and stores real binary PNG bytes',
    async () => {
      const name = `${uniqueName('itest-img')}.png`;

      const created = await createImage({ name, image: PNG_RED_BASE64 });

      expect(typeof created.id).toBe('number');
      expect(created.name).toBe(name);
      expect(created.type).toBe('gallery');
      expect(created.uploaded_to).toBe(pageId);
      expect(created.url).toContain('/uploads/images/gallery/');

      // The entity really exists server-side - an observed 200 from BookStack.
      const stored = await apiFetchRetrying(harness, `/image-gallery/${created.id}`);
      expect(stored.status).toBe(200);

      // ...and what got stored is a real image, not a JSON blob or base64 text.
      const download = await downloadImage(created);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toContain('image/png');

      const bytes = Buffer.from(await download.arrayBuffer());
      expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
      expect(bytes.byteLength).toBe(PNG_RED.byteLength);
      expect(bytes.equals(PNG_RED)).toBe(true);
      // Explicitly the issue-#8 regression: the base64 *text* must not be the body.
      expect(bytes.toString('latin1')).not.toContain(PNG_RED_BASE64.slice(0, 24));
    },
    TEST_TIMEOUT_MS
  );

  it(
    'reads a created image back by id',
    async () => {
      const name = `${uniqueName('itest-img-read')}.png`;
      const created = await createImage({ name, image: PNG_RED_BASE64 });

      const read = asImage(await runTool('bookstack_images_read', { id: created.id }));

      expect(read.id).toBe(created.id);
      expect(read.name).toBe(name);
      expect(read.type).toBe('gallery');
      expect(read.uploaded_to).toBe(pageId);
      expect(read.url).toBe(created.url);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'lists a created image via a name filter',
    async () => {
      const name = `${uniqueName('itest-img-list')}.png`;
      const created = await createImage({ name, image: PNG_RED_BASE64 });

      const listed = (await runTool('bookstack_images_list', {
        filter: { name, type: 'gallery' },
        count: 50,
      })) as ListResponse<Image>;

      // Only ever assert on our own row: other suites are writing to this gallery.
      const match = listed.data.find((image) => image.id === created.id);
      expect(match).toBeDefined();
      expect(match?.name).toBe(name);
      expect(match?.uploaded_to).toBe(pageId);
    },
    TEST_TIMEOUT_MS
  );

  /**
   * The `uploaded_to` filter reaches BookStack and really filters.
   *
   * THE SHAPE THIS TEST MUST HAVE, and why. Creating one image on the wanted page and
   * asserting it comes back proves nothing: an *unfiltered* gallery contains that image
   * too, so the assertion passes just as well if `uploaded_to` were dropped from the
   * query string entirely. The only version that can fail is one with a row the filter
   * is obliged to leave out - hence a second page with its own image, and an assertion
   * that it is absent.
   *
   * Asserted as a MIRRORED PAIR rather than against an unfiltered listing. Each image
   * must appear under its own page's filter and be absent under the other's, which pins
   * down three distinct failures at once: a filter that is dropped (both images appear in
   * both lists, so both exclusions fail), a filter whose value is ignored or hardcoded
   * (one direction fails), and an image that simply is not there (its inclusion fails).
   * An unfiltered read could not stand in for this - the gallery is shared state that
   * other suites are filling, `count` caps at 500 and the default sort is `name`
   * ascending, so our rows are not guaranteed to be on the page that comes back.
   */
  it(
    'filters the gallery by uploaded_to, excluding an image on another page',
    async () => {
      const wantedName = `${uniqueName('itest-img-filter-wanted')}.png`;
      const otherName = `${uniqueName('itest-img-filter-other')}.png`;

      const wanted = await createImage({ name: wantedName, image: PNG_RED_BASE64 });
      const other = await createImage({
        name: otherName,
        image: PNG_TRANSPARENT_BASE64,
        uploaded_to: otherPageId,
      });

      // Sanity: the two really are on different pages, or the exclusions are vacuous.
      expect(wanted.uploaded_to).toBe(pageId);
      expect(other.uploaded_to).toBe(otherPageId);
      expect(otherPageId).not.toBe(pageId);

      const listFor = async (uploadedTo: number): Promise<ListResponse<Image>> =>
        (await runTool('bookstack_images_list', {
          filter: { uploaded_to: uploadedTo },
          count: 500,
        })) as ListResponse<Image>;

      const onWantedPage = await listFor(pageId);
      const onWantedIds = onWantedPage.data.map((image) => image.id);
      expect(onWantedIds).toContain(wanted.id);
      // The half that fails if the filter never reaches BookStack.
      expect(onWantedIds).not.toContain(other.id);
      // Every row really is from the page asked for - not merely most of them.
      for (const image of onWantedPage.data) {
        expect(image.uploaded_to).toBe(pageId);
      }

      // The mirror: the excluded image is present under its own page's filter, so its
      // absence above is the filter working rather than the image being missing.
      const onOtherPage = await listFor(otherPageId);
      const onOtherIds = onOtherPage.data.map((image) => image.id);
      expect(onOtherIds).toContain(other.id);
      expect(onOtherIds).not.toContain(wanted.id);
      for (const image of onOtherPage.data) {
        expect(image.uploaded_to).toBe(otherPageId);
      }
    },
    TEST_TIMEOUT_MS
  );

  /**
   * `name` is optional, exactly as it is upstream - and this is what proves it.
   *
   * The regression guarded here (prior W3) is a `name` that was wrongly *required*: every
   * other create test in this file passes one, so all of them would keep passing if the
   * field went back to being mandatory. Only a create that omits it can fail.
   *
   * The derived name is asserted, not just its presence. With no `name`, the client names
   * the multipart part from the content: base64 has no filename to borrow, so it falls
   * back to `upload` plus an extension sniffed from the magic bytes, and BookStack names
   * the image after the part's filename verbatim - `upload.png`, confirmed live on
   * v26.05.2.
   */
  it(
    'creates an image from base64 with no name, taking the filename BookStack derives',
    async () => {
      const created = await createImage({ image: PNG_RED_BASE64 });

      expect(created.name).toBe('upload.png');
      expect(created.uploaded_to).toBe(pageId);

      // A real stored entity with real bytes, not just an echoed body.
      const read = asImage(await runTool('bookstack_images_read', { id: created.id }));
      expect(read.name).toBe('upload.png');

      const bytes = Buffer.from(await (await downloadImage(created)).arrayBuffer());
      expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
      expect(bytes.equals(PNG_RED)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  /**
   * The `file_path` half of the same rule. Here there *is* a filename to borrow, so the
   * derived name is the file's basename rather than the `upload.png` fallback - which is
   * also why both halves are tested: one passing does not imply the other.
   */
  it(
    'creates an image from file_path with no name, taking the file basename',
    async () => {
      setGuardEnv('MCP_TRANSPORT', 'stdio');
      setGuardEnv('BOOKSTACK_UPLOAD_ROOT', undefined);

      const basename = `${uniqueName('itest-img-unnamed-file')}.png`;
      const filePath = join(uploadRoot, basename);
      await writeFile(filePath, PNG_TRANSPARENT);

      const created = await createImage({ file_path: filePath });

      expect(created.name).toBe(basename);
      expect(created.uploaded_to).toBe(pageId);

      const read = asImage(await runTool('bookstack_images_read', { id: created.id }));
      expect(read.name).toBe(basename);

      const bytes = Buffer.from(await (await downloadImage(created)).arrayBuffer());
      expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
      expect(bytes.equals(PNG_TRANSPARENT)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  /**
   * The multipart update path: BookStack/PHP only parses form data on POST, so
   * the client sends `POST` + `_method=PUT`. A literal multipart PUT arrives
   * upstream as an empty request, which would leave the old bytes in place -
   * exactly what the byte comparison below would catch.
   */
  it(
    'replaces image content on update and persists the new bytes',
    async () => {
      const name = `${uniqueName('itest-img-update')}.png`;
      const created = await createImage({ name, image: PNG_RED_BASE64 });

      const before = Buffer.from(await (await downloadImage(created)).arrayBuffer());
      expect(before.equals(PNG_RED)).toBe(true);

      const updated = asImage(
        await runTool('bookstack_images_update', { id: created.id, image: PNG_TRANSPARENT_BASE64 })
      );
      expect(updated.id).toBe(created.id);

      const download = await downloadImage(updated);
      expect(download.status).toBe(200);

      const after = Buffer.from(await download.arrayBuffer());
      expect(after.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
      expect(after.equals(PNG_TRANSPARENT)).toBe(true);
      // The replacement really happened rather than silently no-op'ing.
      expect(after.equals(before)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  /** A rename carries no file part, so it takes the plain JSON `PUT` path. */
  it(
    'renames an image with a metadata-only update, keeping the content',
    async () => {
      const name = `${uniqueName('itest-img-rename')}.png`;
      const renamed = `${uniqueName('itest-img-renamed')}.png`;
      const created = await createImage({ name, image: PNG_RED_BASE64 });

      const updated = asImage(
        await runTool('bookstack_images_update', { id: created.id, name: renamed })
      );
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe(renamed);

      // The new name persisted...
      const read = asImage(await runTool('bookstack_images_read', { id: created.id }));
      expect(read.name).toBe(renamed);

      // ...and the image content survived the metadata-only update untouched.
      const bytes = Buffer.from(await (await downloadImage(read)).arrayBuffer());
      expect(bytes.equals(PNG_RED)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  /**
   * The name boundary, asserted from both sides.
   *
   * BookStack's `ImageGalleryApiController` enforces `max:180`, and the
   * validator's cap now matches it exactly. Verified against this live instance:
   * a 180-character name answers 200 and round-trips the name unchanged, while
   * 181 answers 422 "The name may not be greater than 180 characters."
   *
   * Both halves matter. 180 must really be accepted upstream - proving the local
   * cap is not needlessly strict - and 181 must be refused *locally*, before a
   * doomed request is sent. The rejection is matched on zod's wording rather
   * than on the number alone: BookStack's own 422 also says "180", so only the
   * local phrasing distinguishes "never sent" from "sent and refused".
   *
   * Deliberately no byte round-trip here, unlike every other upload test. That
   * is not a gap in the issue-#8 guard - it is BookStack's own quirk, and
   * asserting it would test upstream rather than this client: BookStack caps the
   * `url` field at 191 characters, so once `<host>/uploads/images/gallery/<ym>/`
   * plus the name crosses 191 the URL is truncated mid-name, loses its `.png`
   * and serves the HTML app page instead of the image. Measured on this
   * instance: a 130-character name yields a 191-char-safe URL that serves the
   * PNG; 140 and up truncate. `path` keeps the full name either way, and the
   * upload itself is unaffected. The byte-exact PNG guard therefore lives in the
   * create/update tests above, at a realistic name length.
   */
  it(
    'accepts a 180-character name and rejects 181 without calling the API',
    async () => {
      const extension = '.png';
      const stem = uniqueName('itest-img-max');
      // Exactly at the cap, and still unique to this run.
      const maxName = `${stem}${'a'.repeat(180 - extension.length - stem.length)}${extension}`;
      expect(maxName).toHaveLength(180);

      const created = await createImage({ name: maxName, image: PNG_RED_BASE64 });
      // The name survives the cap intact - not silently truncated by either side.
      expect(created.name).toBe(maxName);
      expect(created.name).toHaveLength(180);
      expect(created.uploaded_to).toBe(pageId);

      // It is a real stored entity, not just an echoed response body.
      const read = asImage(await runTool('bookstack_images_read', { id: created.id }));
      expect(read.name).toBe(maxName);

      // One character over: refused by the validator, so nothing leaves the client.
      await expect(
        runTool('bookstack_images_create', {
          name: `a${maxName}`,
          image: PNG_RED_BASE64,
          uploaded_to: pageId,
        })
      ).rejects.toThrow(/expected string to have <=180 characters/);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'deletes an image',
    async () => {
      const name = `${uniqueName('itest-img-delete')}.png`;
      const created = await createImage({ name, image: PNG_RED_BASE64 });

      const result = await runTool('bookstack_images_delete', { id: created.id });
      expect(result).toEqual({
        success: true,
        message: `Image ${created.id} deleted successfully`,
      });

      // Image deletion is permanent - it never reaches the recycle bin.
      const gone = await apiFetchRetrying(harness, `/image-gallery/${created.id}`);
      expect(gone.status).toBe(404);

      await expect(runTool('bookstack_images_read', { id: created.id })).rejects.toThrow(
        /not found/i
      );

      // Deliberately left tracked: teardown's DELETE 404s and its read-back confirms
      // 404, so the tracker independently re-checks the claim this test just made.
    },
    TEST_TIMEOUT_MS
  );

  describe('file_path uploads', () => {
    it(
      'uploads a file from disk under the stdio transport',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'stdio');
        setGuardEnv('BOOKSTACK_UPLOAD_ROOT', undefined);

        const name = `${uniqueName('itest-img-stdio')}.png`;
        const filePath = join(uploadRoot, name);
        await writeFile(filePath, PNG_TRANSPARENT);

        const created = await createImage({ name, file_path: filePath });

        expect(created.name).toBe(name);
        expect(created.uploaded_to).toBe(pageId);

        // The bytes that landed in BookStack are the bytes that were on disk.
        const download = await downloadImage(created);
        expect(download.status).toBe(200);

        const bytes = Buffer.from(await download.arrayBuffer());
        expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
        expect(bytes.equals(PNG_TRANSPARENT)).toBe(true);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'refuses file_path over a remote-capable transport without BOOKSTACK_UPLOAD_ROOT',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'http');
        setGuardEnv('BOOKSTACK_UPLOAD_ROOT', undefined);

        const name = `${uniqueName('itest-img-refused')}.png`;
        const filePath = join(uploadRoot, name);
        await writeFile(filePath, PNG_RED);

        await expect(
          runTool('bookstack_images_create', { name, file_path: filePath, uploaded_to: pageId })
        ).rejects.toThrow(/'file_path' is refused under the 'http' transport/);

        // Refusal is real, not cosmetic: nothing reached the gallery.
        const listed = (await runTool('bookstack_images_list', {
          filter: { name },
        })) as ListResponse<Image>;
        expect(listed.data).toEqual([]);
      },
      TEST_TIMEOUT_MS
    );

    /**
     * The traversal target is a readable, valid PNG: if the guard let it
     * through, the upload would *succeed*. So an empty gallery here is evidence
     * the file was never read, not merely that BookStack rejected it.
     */
    it(
      'refuses a file_path that escapes BOOKSTACK_UPLOAD_ROOT via ../',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'http');
        setGuardEnv('BOOKSTACK_UPLOAD_ROOT', uploadRoot);

        const name = `${uniqueName('itest-img-traversal')}.png`;
        const traversal = join(uploadRoot, '..', 'outside-secret.png');

        await expect(
          runTool('bookstack_images_create', { name, file_path: traversal, uploaded_to: pageId })
        ).rejects.toThrow(/which is outside BOOKSTACK_UPLOAD_ROOT/);

        const listed = (await runTool('bookstack_images_list', {
          filter: { name },
        })) as ListResponse<Image>;
        expect(listed.data).toEqual([]);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'accepts a file_path inside BOOKSTACK_UPLOAD_ROOT over the http transport',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'http');
        setGuardEnv('BOOKSTACK_UPLOAD_ROOT', uploadRoot);

        const name = `${uniqueName('itest-img-rooted')}.png`;
        const filePath = join(uploadRoot, name);
        await writeFile(filePath, PNG_RED);

        const created = await createImage({ name, file_path: filePath });

        const bytes = Buffer.from(await (await downloadImage(created)).arrayBuffer());
        expect(bytes.equals(PNG_RED)).toBe(true);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'rejects image and file_path supplied together',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'stdio');

        const name = `${uniqueName('itest-img-both')}.png`;
        const filePath = join(uploadRoot, name);
        await writeFile(filePath, PNG_RED);

        await expect(
          runTool('bookstack_images_create', {
            name,
            image: PNG_RED_BASE64,
            file_path: filePath,
            uploaded_to: pageId,
          })
        ).rejects.toThrow(/not both/);
      },
      TEST_TIMEOUT_MS
    );
  });
});

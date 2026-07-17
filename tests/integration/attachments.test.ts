/**
 * Live integration tests for the five BookStack attachment tools.
 *
 * These drive the real `MCPTool` handlers through a real `BookStackClient`
 * against a live BookStack, because the bug they exist to catch - GitHub issue
 * #8 - lives in the *wire format*, not in the tool layer: the client used to
 * serialise uploads as `application/json`, which BookStack answers with
 * 500/422. A mocked client cannot tell you that multipart works; only a real
 * response and the stored bytes read back can.
 *
 * How a status code is observed here: the client's axios instance rejects every
 * non-2xx response (the interceptor turns it into an `McpError`), so a handler
 * that *resolves* is itself proof of a 2xx. The issue-#8 failure mode would
 * surface as a thrown error, not as a passing test with a wrong body. Where it
 * is cheap, a status code is also asserted directly via `apiFetch`.
 *
 * Isolation: this suite shares its BookStack with other suites. It therefore
 * asserts only on entities it created - located by ids captured at creation and
 * by its own fixture page - and never on global counts or list completeness.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { AttachmentTools } from '../../src/tools/attachments';
import type { Attachment, AttachmentDetail, ListResponse, MCPTool } from '../../src/types';
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

/**
 * Payload bytes deliberately containing NUL and high bytes: anything that
 * mangled the upload into text (base64, JSON) would not survive a byte-exact
 * round trip through BookStack's storage.
 */
function payloadBytes(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from(`itest-attachment:${marker}:`, 'utf8'),
    Buffer.from([0x00, 0x1f, 0x80, 0xff, 0x0a]),
    Buffer.from('end', 'utf8'),
  ]);
}

/**
 * Live payloads recorded verbatim from v26.05.2, checked against the exported types at
 * compile time.
 *
 * This suite used to declare its own `AttachmentPayload`/`AttachmentDetail`, which let
 * the exported types stay wrong while every test passed green - `Attachment` once
 * required a `links` that three of the four endpoints never send. The types are the
 * contract this server publishes, so they are what the tests assert against now, and
 * `satisfies` pins them to reality from both sides: a field BookStack sends that the type
 * does not declare is an excess-property error, and a field the type requires that
 * BookStack does not send is a missing-property error.
 */

/** `GET /attachments`, `POST /attachments` and `PUT /attachments/{id}`: the bare model. */
const LIVE_ATTACHMENT = {
  id: 305,
  name: 'itest-att.txt',
  extension: 'txt',
  uploaded_to: 2227,
  external: false,
  order: 1,
  created_by: 1,
  updated_by: 1,
  created_at: '2026-07-16T12:26:12.000000Z',
  updated_at: '2026-07-16T12:26:12.000000Z',
} satisfies Attachment;

/**
 * `GET /attachments/{id}` alone: it expands `created_by`/`updated_by` into objects and
 * is the only endpoint to send `links` and `content`.
 *
 * `content` is base64 of the stored file for uploads, and the target URL itself for link
 * attachments. It is the ground truth for "what actually landed".
 */
const LIVE_ATTACHMENT_DETAIL = {
  id: 305,
  name: 'itest-att.txt',
  extension: 'txt',
  uploaded_to: 2227,
  external: false,
  order: 1,
  created_by: { id: 1, name: 'Admin', slug: 'admin' },
  updated_by: { id: 1, name: 'Admin', slug: 'admin' },
  created_at: '2026-07-16T12:26:12.000000Z',
  updated_at: '2026-07-16T12:26:12.000000Z',
  links: {
    html: '<a href="http://localhost:6875/attachments/305">itest-att.txt</a>',
    markdown: '[itest-att.txt](http://localhost:6875/attachments/305)',
  },
  content: 'aXRlc3QtYXR0YWNobWVudA==',
} satisfies AttachmentDetail;

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

describe.skipIf(!runIntegration)('BookStack attachment tools (live)', () => {
  let harness: BookStackHarness;
  let attachmentTools: AttachmentTools;

  /** Fixtures hosting the attachments: `uploaded_to` takes a page id. */
  let bookId: number;
  let pageId: number;

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
    const tool = attachmentTools.getTools().find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool;
  };

  /** Invoke a tool handler for real, tolerating only the shared instance's 429s. */
  const runTool = async (name: string, params: Record<string, unknown>): Promise<unknown> =>
    await withRateLimitRetry(async () => await findTool(name).handler(params));

  /**
   * Narrow a handler result to the attachment shape asserted on below.
   *
   * `MCPTool.handler` is declared `Promise<unknown>`. Like `apiJson()`, this is
   * an assertion rather than validation - the `expect`s are the real check.
   * Defaults to `Attachment` (create/update/list); a read needs `AttachmentDetail`,
   * which is a different shape rather than a superset - hence the explicit argument.
   */
  const asAttachment = <T extends { id: number } = Attachment>(result: unknown): T => result as T;

  /** Create an attachment through the tool, tracking it for cleanup. */
  const createAttachment = async (params: Record<string, unknown>): Promise<Attachment> => {
    const attachment = asAttachment(
      await runTool('bookstack_attachments_create', { uploaded_to: pageId, ...params })
    );
    cleanup.track('attachment', attachment.id);
    return attachment;
  };

  /** Read an attachment back, including its stored content. */
  const readAttachment = async (id: number): Promise<AttachmentDetail> =>
    asAttachment<AttachmentDetail>(await runTool('bookstack_attachments_read', { id }));

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
    attachmentTools = new AttachmentTools(
      client,
      new ValidationHandler({ enabled: true, strictMode: true }),
      logger
    );

    // Fixtures are built with the raw API, not with the book/page tools: this
    // suite is about attachments, and a fixture failure should not read as one.
    const bookRes = await apiFetchRetrying(harness, '/books', {
      method: 'POST',
      body: JSON.stringify({ name: uniqueName('itest-att-book') }),
    });
    expect(bookRes.status).toBe(200);
    bookId = (await apiJson<{ id: number }>(bookRes)).id;
    cleanup.track('book', bookId);

    const pageRes = await apiFetchRetrying(harness, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        book_id: bookId,
        name: uniqueName('itest-att-page'),
        markdown: 'Host page for the MCP attachment integration suite.',
      }),
    });
    expect(pageRes.status).toBe(200);
    pageId = (await apiJson<{ id: number }>(pageRes)).id;

    tmpBase = await mkdtemp(join(tmpdir(), 'bookstack-itest-att-'));
    uploadRoot = join(tmpBase, 'uploads');
    await mkdir(uploadRoot);
    // A readable, perfectly uploadable file that lives *outside* uploadRoot.
    await writeFile(join(tmpBase, 'outside-secret.txt'), payloadBytes('outside-secret'));
  }, TEST_TIMEOUT_MS);

  afterEach(() => {
    for (const key of GUARD_ENV) {
      setGuardEnv(key, savedEnv.get(key));
    }
  });

  afterAll(async () => {
    // The temp dir is local and unconditional: it must go even if the remote teardown
    // below throws, so it runs first.
    if (tmpBase) {
      await rm(tmpBase, { recursive: true, force: true });
    }
    if (!harness) return;

    // Attachments are hard-deleted; the book is soft-deleted and its own bin entry
    // purged (only ours - the shared bin is never emptied). This was a
    // `.catch(() => {})` loop, which suppressed nothing: `fetch` resolves for 4xx/5xx,
    // so a refused delete dropped its id exactly like a successful one. `cleanup.run()`
    // checks each status, re-reads each id, and throws listing whatever survived.
    await cleanup.run(harness);
  }, TEST_TIMEOUT_MS);

  it('registers all five attachment tools', () => {
    const names = attachmentTools.getTools().map((tool) => tool.name);

    expect(names).toEqual([
      'bookstack_attachments_list',
      'bookstack_attachments_create',
      'bookstack_attachments_read',
      'bookstack_attachments_update',
      'bookstack_attachments_delete',
    ]);
  });

  /**
   * The crux of issue #8. A JSON-serialised upload never gets this far: it fails
   * upstream with 500/422, so a byte-exact round trip is the proof that the
   * request left as real multipart/form-data.
   */
  it(
    'creates an attachment from base64 and stores the exact file bytes',
    async () => {
      const name = `${uniqueName('itest-att')}.txt`;
      const bytes = payloadBytes('create');

      const created = await createAttachment({ name, file: bytes.toString('base64') });

      expect(typeof created.id).toBe('number');
      expect(created.name).toBe(name);
      expect(created.extension).toBe('txt');
      expect(created.uploaded_to).toBe(pageId);
      expect(created.external).toBe(false);

      // The entity really exists server-side - an observed 200 from BookStack.
      const stored = await apiFetchRetrying(harness, `/attachments/${created.id}`);
      expect(stored.status).toBe(200);

      // ...and the stored file is byte-for-byte what was sent, NUL and 0xff intact.
      const read = await readAttachment(created.id);
      const roundTripped = Buffer.from(read.content, 'base64');
      expect(roundTripped.byteLength).toBe(bytes.byteLength);
      expect(roundTripped.equals(bytes)).toBe(true);
      expect(read.links.html).toContain(`/attachments/${created.id}`);
    },
    TEST_TIMEOUT_MS
  );

  /** A link carries no file part, so this must travel as JSON, not multipart. */
  it(
    'creates a link attachment through the JSON path',
    async () => {
      const name = uniqueName('itest-att-link');
      const link = `https://example.com/${name}`;

      const created = await createAttachment({ name, link });

      expect(created.name).toBe(name);
      expect(created.external).toBe(true);
      expect(created.extension).toBe('');
      expect(created.uploaded_to).toBe(pageId);

      // For a link attachment BookStack echoes the target URL back as `content`.
      const read = await readAttachment(created.id);
      expect(read.content).toBe(link);
      expect(read.external).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'reads a created attachment back by id',
    async () => {
      const name = `${uniqueName('itest-att-read')}.txt`;
      const bytes = payloadBytes('read');
      const created = await createAttachment({ name, file: bytes.toString('base64') });

      const read = await readAttachment(created.id);

      expect(read.id).toBe(created.id);
      expect(read.name).toBe(name);
      expect(read.extension).toBe('txt');
      expect(read.uploaded_to).toBe(pageId);
      expect(read.links.markdown).toContain(`/attachments/${created.id}`);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'lists attachments of its own page',
    async () => {
      const name = `${uniqueName('itest-att-list')}.txt`;
      const created = await createAttachment({
        name,
        file: payloadBytes('list').toString('base64'),
      });

      const listed = (await runTool('bookstack_attachments_list', {
        filter: { uploaded_to: pageId },
        count: 100,
      })) as ListResponse<Attachment>;

      // Only ever assert on our own row: other suites are writing to this instance.
      const match = listed.data.find((attachment) => attachment.id === created.id);
      expect(match).toBeDefined();
      expect(match?.name).toBe(name);
      expect(match?.uploaded_to).toBe(pageId);
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
    'replaces attachment content on update and persists the new bytes',
    async () => {
      const name = `${uniqueName('itest-att-update')}.txt`;
      const original = payloadBytes('update-v1');
      const replacement = payloadBytes('update-v2-which-is-longer');
      const created = await createAttachment({ name, file: original.toString('base64') });

      const before = Buffer.from((await readAttachment(created.id)).content, 'base64');
      expect(before.equals(original)).toBe(true);

      const renamed = `${uniqueName('itest-att-updated')}.txt`;
      const updated = asAttachment(
        await runTool('bookstack_attachments_update', {
          id: created.id,
          name: renamed,
          file: replacement.toString('base64'),
        })
      );
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe(renamed);

      const read = await readAttachment(created.id);
      const stored = Buffer.from(read.content, 'base64');
      expect(read.name).toBe(renamed);
      expect(stored.equals(replacement)).toBe(true);
      // The replacement really happened rather than silently no-op'ing.
      expect(stored.equals(original)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  /** A rename carries no file part, so it takes the plain JSON `PUT` path. */
  it(
    'renames an attachment with a metadata-only update, keeping the content',
    async () => {
      const name = `${uniqueName('itest-att-rename')}.txt`;
      const renamed = `${uniqueName('itest-att-renamed')}.txt`;
      const bytes = payloadBytes('rename');
      const created = await createAttachment({ name, file: bytes.toString('base64') });

      const updated = asAttachment(
        await runTool('bookstack_attachments_update', { id: created.id, name: renamed })
      );
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe(renamed);

      const read = await readAttachment(created.id);
      expect(read.name).toBe(renamed);
      // The file survived the metadata-only update untouched.
      expect(Buffer.from(read.content, 'base64').equals(bytes)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'updates a link attachment through the JSON path',
    async () => {
      const name = uniqueName('itest-att-relink');
      const created = await createAttachment({ name, link: `https://example.com/${name}` });

      const next = `https://example.com/${name}-v2`;
      const updated = asAttachment(
        await runTool('bookstack_attachments_update', { id: created.id, link: next })
      );
      expect(updated.id).toBe(created.id);
      expect(updated.external).toBe(true);

      const read = await readAttachment(created.id);
      expect(read.content).toBe(next);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'deletes an attachment',
    async () => {
      const name = `${uniqueName('itest-att-delete')}.txt`;
      const created = await createAttachment({
        name,
        file: payloadBytes('delete').toString('base64'),
      });

      const result = await runTool('bookstack_attachments_delete', { id: created.id });
      expect(result).toEqual({
        success: true,
        message: `Attachment ${created.id} deleted successfully`,
      });

      // Attachment deletion is permanent - it never reaches the recycle bin.
      const gone = await apiFetchRetrying(harness, `/attachments/${created.id}`);
      expect(gone.status).toBe(404);

      await expect(runTool('bookstack_attachments_read', { id: created.id })).rejects.toThrow(
        /not found/i
      );

      // Deliberately left tracked: teardown's DELETE 404s and its read-back confirms
      // 404, so the tracker independently re-checks the claim this test just made.
    },
    TEST_TIMEOUT_MS
  );

  describe('file_path uploads', () => {
    it(
      'accepts a file_path inside BOOKSTACK_UPLOAD_ROOT over the http transport',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'http');
        setGuardEnv('BOOKSTACK_UPLOAD_ROOT', uploadRoot);

        const name = `${uniqueName('itest-att-rooted')}.txt`;
        const bytes = payloadBytes('rooted-upload');
        const filePath = join(uploadRoot, name);
        await writeFile(filePath, bytes);

        const created = await createAttachment({ name, file_path: filePath });

        expect(created.name).toBe(name);
        expect(created.external).toBe(false);

        // The bytes that landed in BookStack are the bytes that were on disk.
        const read = await readAttachment(created.id);
        expect(Buffer.from(read.content, 'base64').equals(bytes)).toBe(true);
      },
      TEST_TIMEOUT_MS
    );

    /** file_path over the multipart-update path (`POST` + `_method=PUT`). */
    it(
      'replaces content from a file_path under the stdio transport',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'stdio');
        setGuardEnv('BOOKSTACK_UPLOAD_ROOT', undefined);

        const name = `${uniqueName('itest-att-stdio')}.txt`;
        const original = payloadBytes('stdio-v1');
        const replacement = payloadBytes('stdio-v2-from-disk');
        const created = await createAttachment({ name, file: original.toString('base64') });

        const filePath = join(uploadRoot, `${name}.replacement`);
        await writeFile(filePath, replacement);

        const updated = asAttachment(
          await runTool('bookstack_attachments_update', { id: created.id, file_path: filePath })
        );
        expect(updated.id).toBe(created.id);

        const read = await readAttachment(created.id);
        expect(Buffer.from(read.content, 'base64').equals(replacement)).toBe(true);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'refuses file_path over a remote-capable transport without BOOKSTACK_UPLOAD_ROOT',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'http');
        setGuardEnv('BOOKSTACK_UPLOAD_ROOT', undefined);

        const name = `${uniqueName('itest-att-refused')}.txt`;
        const filePath = join(uploadRoot, name);
        await writeFile(filePath, payloadBytes('refused'));

        await expect(
          runTool('bookstack_attachments_create', {
            uploaded_to: pageId,
            name,
            file_path: filePath,
          })
        ).rejects.toThrow(/'file_path' is refused under the 'http' transport/);

        // Refusal is real, not cosmetic: nothing reached the page.
        const listed = (await runTool('bookstack_attachments_list', {
          filter: { uploaded_to: pageId, name },
        })) as ListResponse<Attachment>;
        expect(listed.data).toEqual([]);
      },
      TEST_TIMEOUT_MS
    );

    /**
     * The traversal target is a readable, perfectly uploadable file: if the
     * guard let it through, the upload would *succeed*. So the absence of any
     * attachment here is evidence the file was never read, not merely that
     * BookStack rejected it.
     */
    it(
      'refuses a file_path that escapes BOOKSTACK_UPLOAD_ROOT via ../',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'http');
        setGuardEnv('BOOKSTACK_UPLOAD_ROOT', uploadRoot);

        const name = `${uniqueName('itest-att-traversal')}.txt`;
        const traversal = join(uploadRoot, '..', 'outside-secret.txt');

        await expect(
          runTool('bookstack_attachments_create', {
            uploaded_to: pageId,
            name,
            file_path: traversal,
          })
        ).rejects.toThrow(/which is outside BOOKSTACK_UPLOAD_ROOT/);

        const listed = (await runTool('bookstack_attachments_list', {
          filter: { uploaded_to: pageId, name },
        })) as ListResponse<Attachment>;
        expect(listed.data).toEqual([]);
      },
      TEST_TIMEOUT_MS
    );
  });

  /**
   * The content sources are exactly-one on create, at-most-one on update.
   *
   * This is a data-loss guard, not a tidiness rule. BookStack applies `link` AFTER
   * storing the upload: it deletes the file it just saved, flips the attachment to
   * external, and keeps only the link. So a call carrying both does not "prefer" one -
   * it silently destroys the file and returns something else entirely. Reproduced live
   * against v26.05.2: a create with `file` + `link` came back `external: true` with
   * `content: "https://example.com/evil"`, and the uploaded bytes were gone.
   *
   * The validator used to reject only `file` + `file_path` - the one *harmless* pair,
   * since both are uploads and neither destroys anything - while accepting both pairs
   * that actually lose data. Every combination is therefore covered here, on both create
   * and update, rather than only the pair that used to be caught.
   *
   * These are rejected at our own boundary, so nothing reaches BookStack; the tests below
   * assert that too, since a rejection that still wrote would be no rejection at all.
   */
  describe('content source exclusivity', () => {
    /** The three sources, and the label the error uses for each. */
    const SOURCE_LABELS = {
      file: 'file \\(base64 content\\)',
      file_path: 'file_path \\(a server-local path\\)',
      link: 'link \\(an external URL\\)',
    } as const;

    type Source = keyof typeof SOURCE_LABELS;

    /** Every rejectable combination: all three pairs, plus all three at once. */
    const COMBINATIONS: readonly (readonly Source[])[] = [
      ['file', 'file_path'],
      ['file', 'link'],
      ['file_path', 'link'],
      ['file', 'file_path', 'link'],
    ];

    /** The message names every source that collided, in `file, file_path, link` order. */
    const conflictPattern = (sources: readonly Source[]): RegExp =>
      new RegExp(
        `Provide only one of file, file_path or link - received ${sources
          .map((source) => SOURCE_LABELS[source])
          .join(' and ')}\\.`
      );

    /** Build the params for a combination, writing a real file for `file_path`. */
    const sourceParams = async (
      sources: readonly Source[],
      marker: string
    ): Promise<Record<string, unknown>> => {
      const params: Record<string, unknown> = {};
      for (const source of sources) {
        if (source === 'file') {
          params.file = payloadBytes(marker).toString('base64');
        } else if (source === 'file_path') {
          // A real, readable, perfectly uploadable file: the rejection must come from
          // the exclusivity rule, not from a path that happens not to exist.
          const filePath = join(uploadRoot, `${uniqueName(marker)}.txt`);
          await writeFile(filePath, payloadBytes(marker));
          params.file_path = filePath;
        } else {
          params.link = 'https://example.com/evil';
        }
      }
      return params;
    };

    /** Nothing this suite created under `name` exists on the fixture page. */
    const expectNothingCreated = async (name: string): Promise<void> => {
      const listed = (await runTool('bookstack_attachments_list', {
        filter: { uploaded_to: pageId, name },
      })) as ListResponse<Attachment>;
      expect(listed.data).toEqual([]);
    };

    for (const sources of COMBINATIONS) {
      it(
        `rejects create with ${sources.join(' + ')}, naming what collided`,
        async () => {
          // stdio, so file_path is an allowed source and cannot be what fails.
          setGuardEnv('MCP_TRANSPORT', 'stdio');

          const name = `${uniqueName('itest-att-excl-create')}.txt`;
          const params = await sourceParams(sources, 'excl-create');

          const failure = await runTool('bookstack_attachments_create', {
            uploaded_to: pageId,
            name,
            ...params,
          }).then(
            () => null,
            (error: unknown) => error
          );

          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toMatch(conflictPattern(sources));
          // The error explains why this is a conflict rather than a preference.
          expect((failure as Error).message).toMatch(/deletes the file it just saved/);

          // The rejection is real: nothing was written to BookStack.
          await expectNothingCreated(name);
        },
        TEST_TIMEOUT_MS
      );
    }

    it(
      'rejects a create with no content source at all',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'stdio');

        const name = `${uniqueName('itest-att-excl-none')}.txt`;

        await expect(
          runTool('bookstack_attachments_create', { uploaded_to: pageId, name })
        ).rejects.toThrow(
          /One of file \(base64 content\), file_path \(a server-local path\), or link \(an external URL\) is required/
        );

        await expectNothingCreated(name);
      },
      TEST_TIMEOUT_MS
    );

    for (const sources of COMBINATIONS) {
      it(
        `rejects update with ${sources.join(' + ')}, leaving the stored file intact`,
        async () => {
          setGuardEnv('MCP_TRANSPORT', 'stdio');

          const name = `${uniqueName('itest-att-excl-update')}.txt`;
          const original = payloadBytes('excl-update-original');
          const created = await createAttachment({ name, file: original.toString('base64') });
          const params = await sourceParams(sources, 'excl-update');

          const failure = await runTool('bookstack_attachments_update', {
            id: created.id,
            ...params,
          }).then(
            () => null,
            (error: unknown) => error
          );

          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toMatch(conflictPattern(sources));

          // The heart of it: the file that a `link` would have destroyed is still there,
          // byte for byte, and the attachment is still an upload rather than a link.
          const read = await readAttachment(created.id);
          expect(read.external).toBe(false);
          expect(Buffer.from(read.content, 'base64').equals(original)).toBe(true);
          expect(read.name).toBe(name);
        },
        TEST_TIMEOUT_MS
      );
    }

    /** At-most-one, not exactly-one: an update may legitimately carry no source. */
    it(
      'still allows a metadata-only update, which carries no content source',
      async () => {
        setGuardEnv('MCP_TRANSPORT', 'stdio');

        const name = `${uniqueName('itest-att-excl-meta')}.txt`;
        const bytes = payloadBytes('excl-meta');
        const created = await createAttachment({ name, file: bytes.toString('base64') });

        const renamed = `${uniqueName('itest-att-excl-meta-renamed')}.txt`;
        const updated = asAttachment(
          await runTool('bookstack_attachments_update', { id: created.id, name: renamed })
        );

        expect(updated.id).toBe(created.id);
        expect(updated.name).toBe(renamed);

        const read = await readAttachment(created.id);
        expect(read.name).toBe(renamed);
        expect(Buffer.from(read.content, 'base64').equals(bytes)).toBe(true);
      },
      TEST_TIMEOUT_MS
    );
  });

  /**
   * The exported types are the contract, so they get asserted rather than paraphrased.
   *
   * Read is the odd endpoint out: it alone expands `created_by`/`updated_by` and sends
   * `links`/`content`. `Attachment` once required `links`, promising a property that
   * three of the four endpoints never send - which the suite's own local interface hid.
   */
  it(
    'returns exactly the fields Attachment and AttachmentDetail declare, and no others',
    async () => {
      const name = `${uniqueName('itest-att-shape')}.txt`;
      const bytes = payloadBytes('shape');
      const created = await createAttachment({ name, file: bytes.toString('base64') });

      // create: the bare model - plain user IDs, no links/content.
      expect(Object.keys(created).sort()).toEqual(Object.keys(LIVE_ATTACHMENT).sort());
      expect(typeof created.created_by).toBe('number');
      expect(created).not.toHaveProperty('links');
      expect(created).not.toHaveProperty('content');

      // update: same shape as create.
      const updated = asAttachment(
        await runTool('bookstack_attachments_update', {
          id: created.id,
          name: `${uniqueName('itest-att-shape-renamed')}.txt`,
        })
      );
      expect(Object.keys(updated).sort()).toEqual(Object.keys(LIVE_ATTACHMENT).sort());

      // list: same shape again.
      const listed = (await runTool('bookstack_attachments_list', {
        filter: { uploaded_to: pageId },
        count: 100,
      })) as ListResponse<Attachment>;
      const entry = listed.data.find((attachment) => attachment.id === created.id);
      expect(entry).toBeDefined();
      expect(Object.keys(entry as Attachment).sort()).toEqual(Object.keys(LIVE_ATTACHMENT).sort());

      // read: the only one with links/content, and expanded user objects.
      const read = await readAttachment(created.id);
      expect(Object.keys(read).sort()).toEqual(Object.keys(LIVE_ATTACHMENT_DETAIL).sort());
      expect(Object.keys(read.created_by).sort()).toEqual(['id', 'name', 'slug']);
      expect(Object.keys(read.updated_by).sort()).toEqual(['id', 'name', 'slug']);
      expect(Object.keys(read.links).sort()).toEqual(['html', 'markdown']);
    },
    TEST_TIMEOUT_MS
  );
});

/**
 * Integration tests for the six `bookstack_chapters_*` MCP tools against a live
 * BookStack.
 *
 * Drives the tools themselves - a real `BookStackClient`, `ValidationHandler`
 * and `Logger` wired into `ChapterTools` the way `server.ts` wires them - rather
 * than the REST API directly, so what is proven is the advertised tool surface.
 * `BookTools` and `PageTools` appear only as fixtures: a chapter is meaningless
 * without a parent book, and `chapters_read` / `chapters_export` are only
 * interesting once the chapter holds a page.
 *
 * ## Isolation
 *
 * The instance is shared with concurrently-running suites, so every entity gets
 * a unique name, every assertion is scoped to entities this file created, and
 * nothing asserts on `total` or list completeness. Everything created is deleted
 * *and* purged from the recycle bin (DELETE is only a soft delete) - our own
 * entries only, never the whole bin.
 *
 * ## Exports
 *
 * `bookstack_chapters_export` answers with an `ExportResult`:
 * `{content, encoding, byte_length, filename, mime_type}`. `encoding` is what
 * makes `content` usable - `utf8` means it is the document itself, `base64` (pdf)
 * means it must be decoded to recover the bytes, and `content.length` is then a
 * character count rather than the file size (`byte_length`). The pdf case decodes
 * and structurally validates the file: it guards a corruption bug in which PDF
 * bytes were text-decoded into U+FFFD mojibake.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { BookTools } from '../../src/tools/books';
import { ChapterTools } from '../../src/tools/chapters';
import { PageTools } from '../../src/tools/pages';
import type {
  Book,
  Chapter,
  ChapterWithPages,
  ExportFormat,
  ExportResult,
  ListResponse,
  MCPTool,
  Page,
  UserRef,
} from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  apiUrl,
  type BookStackHarness,
  CleanupTracker,
  ensureBookStack,
  shouldRunIntegration,
  tokenString,
} from './helpers/bookstack';

const runIntegration = await shouldRunIntegration();

/**
 * Response shapes.
 *
 * `Chapter`, `ChapterWithPages`, `Book` and `Page` from `src/types` model the
 * real payloads, so they are used directly: `created_by`/`updated_by`/`owned_by`
 * are `UserRef`, covering both renderings BookStack uses for the same entity (a
 * bare user id in list responses, an expanded `{id,name,slug}` on a single read).
 *
 * Only a book's `contents` needs a local shape - `BookWithContents` types it as
 * `(Chapter | Page)[]`, which carries no `type` discriminator.
 */
interface BookReadResponse extends Book {
  contents: { id: number; type: 'chapter' | 'page'; name: string }[];
}

interface DeleteResult {
  success: boolean;
  message: string;
}

interface ToolProvider {
  getTools(): MCPTool[];
}

/**
 * BookStack rate-limits its API **per user**, and every suite authenticates as
 * the same admin token, so that budget is shared with whatever else runs against
 * this instance - a 429 here is an environmental condition, not a defect in the
 * tool.
 *
 * This test instance raises the limit to 5000/min (`X-RateLimit-Limit: 5000`),
 * well clear of what these suites use, so the wait below should never actually
 * sleep. It is kept because the default is 180/min: anyone pointing this suite at
 * a stock instance needs it, and a 429 must never read as a tool failure.
 *
 * Polls with the real token until the window has room again, honouring
 * `Retry-After`. Any non-429 answer (including 401 on a not-yet-provisioned
 * token) means the limiter is not what is blocking us, so it returns and lets
 * the caller proceed and surface the real error.
 */
async function waitForApiBudget(attempts = 10, fallbackDelayMs = 6000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch(`${apiUrl()}/books?count=1`, {
      headers: { Authorization: `Token ${tokenString()}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);

    // Also covers a network failure (`res` undefined): not a rate-limit stall,
    // so return and let the caller surface the real error.
    if (res?.status !== 429) return;

    const retryAfter = Number(res.headers.get('Retry-After') ?? 0);
    await Bun.sleep(retryAfter > 0 ? retryAfter * 1000 + 500 : fallbackDelayMs);
  }
}

/** Did BookStack reject this call with 429? `ErrorHandler` maps it to this message. */
function isRateLimited(error: unknown): boolean {
  return error instanceof Error && /rate limit exceeded/i.test(error.message);
}

/**
 * Invoke a tool by name and narrow its `unknown` result. `MCPTool.handler`
 * returns `Promise<unknown>`, so the cast has to live somewhere; centralising it
 * mirrors `apiJson<T>()` in the harness. Tests still assert real field values,
 * which is what would catch a genuinely wrong shape.
 *
 * Retries only on 429, and only after the budget poll says the window reopened.
 * That is safe for every verb: a rate-limited request was rejected, never
 * executed, so replaying it cannot double-create. Every other error - including
 * the 404s and validation failures these tests assert on - propagates
 * immediately and unchanged.
 */
async function callTool<T>(provider: ToolProvider, name: string, params: unknown): Promise<T> {
  const tool = provider.getTools().find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered`);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return (await tool.handler(params)) as T;
    } catch (error) {
      if (attempt >= 4 || !isRateLimited(error)) throw error;
      await waitForApiBudget();
    }
  }
}

function uniqueName(label: string): string {
  return `itest-chapters-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Read the id out of a `UserRef`.
 *
 * BookStack renders the same `created_by` field two ways: a bare id in a list
 * response, an expanded `{id,name,slug}` on a single read (verified on v26.05.2),
 * which is exactly what `UserRef` models.
 */
function userRefId(ref: UserRef): number {
  return typeof ref === 'number' ? ref : ref.id;
}

/** Every export format whose payload is text rather than binary. */
type TextExportFormat = Exclude<ExportFormat, 'pdf'>;

/**
 * What the client must report per text format. BookStack labels every export
 * `application/octet-stream`, so `mime_type` is derived from the requested
 * format; the extension is the one in the `filename*=UTF-8''<slug>.<ext>`
 * disposition it sends. Keyed off `ExportFormat`, so a new format cannot be
 * added upstream without this failing to compile.
 */
const TEXT_EXPORTS: Record<TextExportFormat, { mime_type: string; extension: string }> = {
  markdown: { mime_type: 'text/markdown', extension: 'md' },
  plaintext: { mime_type: 'text/plain', extension: 'txt' },
  html: { mime_type: 'text/html', extension: 'html' },
};

/**
 * Assert the invariants of a text export, and hand back `content` so the caller
 * can make its format-specific checks on the document itself.
 */
function expectTextExport(result: ExportResult, format: TextExportFormat, slug: string): string {
  const expected = TEXT_EXPORTS[format];

  expect(result.encoding).toBe('utf8');
  expect(result.mime_type).toBe(expected.mime_type);
  expect(result.filename).toBe(`${slug}.${expected.extension}`);

  // utf8: `content` IS the document, so its utf8 length is the file's size.
  expect(typeof result.content).toBe('string');
  expect(result.byte_length).toBe(Buffer.byteLength(result.content, 'utf8'));
  expect(result.byte_length).toBeGreaterThan(0);

  return result.content;
}

/**
 * Assert that a pdf export round-trips to a structurally valid PDF file.
 *
 * This is the regression guard for the corruption bug: the PDF's bytes were once
 * decoded as text, which replaces every invalid utf8 sequence with U+FFFD and
 * inflates the payload irreversibly. Checking `%PDF-` on a decoded string would
 * NOT have caught that - the magic number is ascii and survives mojibake
 * untouched - so this decodes the base64 and checks the file's own internal byte
 * offsets still resolve, which a corrupted payload cannot fake.
 */
function expectPdfExport(result: ExportResult, slug: string): void {
  expect(result.encoding).toBe('base64');
  expect(result.mime_type).toBe('application/pdf');
  expect(result.filename).toBe(`${slug}.pdf`);

  const decoded = Buffer.from(result.content, 'base64');

  // `byte_length` is the file's real size. `content.length` counts base64
  // characters - about 4/3 of the byte count - and is never the size to report.
  expect(decoded.byteLength).toBe(result.byte_length);
  expect(result.byte_length).toBeGreaterThan(1024);
  expect(result.content.length).toBeGreaterThan(result.byte_length);
  // Canonical base64: re-encoding the decoded bytes reproduces `content` exactly.
  expect(decoded.toString('base64')).toBe(result.content);

  // A real PDF: header magic, and the %%EOF trailer that closes every file.
  expect(decoded.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(decoded.subarray(-32).toString('latin1')).toContain('%%EOF');

  // The structural proof. A PDF trailer ends `startxref\n<offset>\n%%EOF`, where
  // <offset> is a byte position into the file itself. Byte-level corruption
  // shifts every position after the first mangled sequence, so an offset that
  // still lands on the cross-reference table means the bytes survived intact.
  const trailer = decoded.subarray(-2048).toString('latin1');
  const startxref = /startxref\s+(\d+)\s+%%EOF/.exec(trailer);
  expect(startxref).not.toBeNull();

  const offset = Number(startxref?.[1]);
  expect(offset).toBeGreaterThan(0);
  expect(offset).toBeLessThan(result.byte_length);
  // `xref` for a classic table, `<n> <n> obj` for a PDF 1.5+ cross-reference stream.
  expect(decoded.subarray(offset, offset + 24).toString('latin1')).toMatch(
    /^(xref|\d+\s+\d+\s+obj)/
  );
}

/** What a tracked entity is - only books drive teardown; see afterAll. */
type EntityType = 'book' | 'chapter' | 'page';

describe.skipIf(!runIntegration)('bookstack_chapters_* tools (live BookStack)', () => {
  let harness: BookStackHarness;
  let bookTools: BookTools;
  let chapterTools: ChapterTools;
  let pageTools: PageTools;

  /** A book to hang chapters off; created once for the whole suite. */
  let parentBook: Book;

  /**
   * Everything this file created, in creation order. Only the books drive
   * teardown (see afterAll) - chapters and pages are recorded to document
   * ownership at the call site, and every one of them lives inside a book
   * recorded here, so purging those books removes them too.
   */
  const created: { type: EntityType; id: number }[] = [];

  const cleanup = new CleanupTracker();

  const track = <T extends { id: number }>(type: EntityType, entity: T): T => {
    created.push({ type, id: entity.id });
    // Only books are handed to the tracker - the deliberate design documented on
    // afterAll. Chapters and pages are recorded above to document ownership at the
    // call site; each lives inside a book recorded here, and purging that book
    // destroys them with it.
    if (type === 'book') {
      cleanup.track('book', entity.id);
    }
    return entity;
  };

  beforeAll(async () => {
    // Harness gap worked around: `ensureBookStack()` decides the token is bad
    // whenever its probe is not HTTP 200 - a 429 included - and then reports a
    // misleading "token still fails to authenticate" error. Draining the
    // rate-limit window first keeps that misdiagnosis from firing.
    await waitForApiBudget();
    harness = await ensureBookStack();

    // The same wiring server.ts uses - only the values are test-shaped:
    // strictMode surfaces schema violations instead of silently passing raw
    // params through, and the client-side limiter stays well inside the budget
    // this instance allows (5000/min), which it shares with every other suite.
    const config: Config = {
      bookstack: { baseUrl: harness.baseUrl, apiToken: harness.token, timeout: 30_000 },
      server: { name: 'bookstack-mcp-server-itest', version: '1.0.0', port: 3000 },
      rateLimit: { requestsPerMinute: 120, burstLimit: 20 },
      validation: { enabled: true, strictMode: true },
      logging: { level: 'error', format: 'pretty' },
      development: { nodeEnv: 'test', debug: false },
    };

    const logger = Logger.getInstance();
    const client = new BookStackClient(config, logger, new ErrorHandler(logger));
    const validator = new ValidationHandler(config.validation);

    bookTools = new BookTools(client, validator, logger);
    chapterTools = new ChapterTools(client, validator, logger);
    pageTools = new PageTools(client, validator, logger);

    parentBook = track(
      'book',
      await callTool<Book>(bookTools, 'bookstack_books_create', {
        name: uniqueName('parent-book'),
        description: 'Parent book for the chapters integration suite.',
      })
    );
  }, 120_000);

  // Teardown deletes and purges only the root *books*, which is sufficient and
  // deliberate. Deleting a book cascades over its chapters and pages, and
  // purging the book's recycle-bin entry destroys their entries with it -
  // including the separate entry that an individually-deleted page leaves
  // behind (verified against this BookStack; a cascaded child gets no entry of
  // its own at all). Every chapter and page this file creates lives inside a
  // book it created, so tearing down the books cleans everything.
  //
  // Doing it per-entity instead would cost ~3x the requests for no gain, and
  // cheap teardown is resilient teardown: it shares this instance's API budget
  // with every other suite, and a sweep that gets throttled part-way leaks the
  // tail it never reached.
  //
  // Teardown is failure-tolerant only where that is honest: a DELETE 404s for
  // anything a test already deleted, and the tracker treats that as success. A
  // 429 is retried on the response's own schedule rather than swallowed. What is
  // NOT tolerated any more is a delete BookStack refused - that used to be
  // indistinguishable from success, because `fetch` resolves for 4xx/5xx and
  // `purgeFromRecycleBin` folded every error into an ignored `false`. Each book
  // is now re-read by id after its purge, and anything still there fails this
  // hook.
  afterAll(async () => {
    if (!harness) return;
    await cleanup.run(harness);
  }, 180_000);

  it('registers all six chapter tools', () => {
    const names = chapterTools.getTools().map((tool) => tool.name);

    expect(names).toEqual([
      'bookstack_chapters_list',
      'bookstack_chapters_create',
      'bookstack_chapters_read',
      'bookstack_chapters_update',
      'bookstack_chapters_delete',
      'bookstack_chapters_export',
    ]);
  });

  describe('bookstack_chapters_create', () => {
    it('creates a chapter inside a book and round-trips its fields', async () => {
      const name = uniqueName('create');

      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name,
          description: 'A chapter of the parent book.',
          priority: 7,
          tags: [{ name: 'Suite', value: 'chapters' }],
        })
      );

      expect(typeof chapter.id).toBe('number');
      expect(chapter.name).toBe(name);
      expect(chapter.slug).toBe(name.toLowerCase());
      expect(chapter.description).toBe('A chapter of the parent book.');
      expect(chapter.priority).toBe(7);
      // The nesting that makes BookStack meaningful: it belongs to the book.
      expect(chapter.book_id).toBe(parentBook.id);
      expect(chapter.tags).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Suite', value: 'chapters' })])
      );
    }, 120_000);

    it('surfaces the new chapter in the contents of the parent book', async () => {
      const name = uniqueName('create-nested');
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name,
        })
      );

      const book = await callTool<BookReadResponse>(bookTools, 'bookstack_books_read', {
        id: parentBook.id,
      });

      const entry = book.contents.find((candidate) => candidate.id === chapter.id);
      expect(entry).toBeDefined();
      expect(entry?.type).toBe('chapter');
      expect(entry?.name).toBe(name);
    }, 120_000);

    it('requires a parent book_id', async () => {
      // strictMode: the zod `chapterCreate` schema rejects it before the API.
      await expect(
        callTool(chapterTools, 'bookstack_chapters_create', { name: uniqueName('orphan') })
      ).rejects.toThrow(/book_id/i);
    }, 120_000);
  });

  describe('bookstack_chapters_read', () => {
    it('reads a chapter and lists the pages it contains', async () => {
      const chapterName = uniqueName('read');
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name: chapterName,
          description: 'Holds a page.',
        })
      );

      const pageName = uniqueName('read-page');
      const page = track(
        'page',
        await callTool<Page>(pageTools, 'bookstack_pages_create', {
          chapter_id: chapter.id,
          name: pageName,
          markdown: '# In chapter\n\nContent.',
        })
      );

      const read = await callTool<ChapterWithPages>(chapterTools, 'bookstack_chapters_read', {
        id: chapter.id,
      });

      expect(read.id).toBe(chapter.id);
      expect(read.name).toBe(chapterName);
      expect(read.description).toBe('Holds a page.');
      expect(read.book_id).toBe(parentBook.id);

      const nested = read.pages.find((candidate) => candidate.id === page.id);
      expect(nested).toBeDefined();
      expect(nested?.name).toBe(pageName);
      expect(nested?.chapter_id).toBe(chapter.id);
    }, 120_000);

    it('rejects a non-positive id and reports a missing chapter', async () => {
      await expect(callTool(chapterTools, 'bookstack_chapters_read', { id: 0 })).rejects.toThrow(
        />0|too_small/i
      );

      await expect(
        callTool(chapterTools, 'bookstack_chapters_read', { id: 99_999_999 })
      ).rejects.toThrow(/not found/i);
    }, 120_000);
  });

  describe('bookstack_chapters_list', () => {
    it('finds a created chapter by book_id filter and honours count', async () => {
      const name = uniqueName('list');
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name,
        })
      );

      const list = await callTool<ListResponse<Chapter>>(chapterTools, 'bookstack_chapters_list', {
        count: 500,
        filter: { book_id: parentBook.id },
      });

      expect(Array.isArray(list.data)).toBe(true);
      expect(typeof list.total).toBe('number');

      // Present *among* results, and every result belongs to our own book -
      // an assertion that stays true no matter what other suites create.
      const mine = list.data.find((candidate) => candidate.id === chapter.id);
      expect(mine).toBeDefined();
      expect(mine?.name).toBe(name);
      expect(list.data.every((candidate) => candidate.book_id === parentBook.id)).toBe(true);

      const capped = await callTool<ListResponse<Chapter>>(
        chapterTools,
        'bookstack_chapters_list',
        { count: 1 }
      );
      expect(capped.data.length).toBeLessThanOrEqual(1);
    }, 120_000);

    it('filters by name and applies sort', async () => {
      const name = uniqueName('list-by-name');
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name,
        })
      );

      const byName = await callTool<ListResponse<Chapter>>(
        chapterTools,
        'bookstack_chapters_list',
        { count: 500, filter: { name } }
      );
      expect(byName.data.some((candidate) => candidate.id === chapter.id)).toBe(true);

      const sorted = await callTool<ListResponse<Chapter>>(
        chapterTools,
        'bookstack_chapters_list',
        { count: 20, sort: 'created_at' }
      );
      // Ordering within this response only - independent of other suites.
      const timestamps = sorted.data.map((entry) => entry.created_at);
      expect(timestamps).toEqual([...timestamps].sort());
    }, 120_000);

    /**
     * `filter.created_by` is advertised by the tool but was silently dropped before
     * the request went out, so the filter did nothing while still answering 200.
     *
     * Both halves are needed to prove it works, and the second is the one that can
     * fail: BookStack ignores a filter key it does not recognise (verified live on
     * v26.05.2 - `filter[nonsense]=zzz` returns every chapter), so a filter that
     * never reaches the API is indistinguishable from a working one when the only
     * assertion is "my chapter is in the results". A creator who cannot exist is
     * what separates them: filtered means nothing comes back, dropped means
     * everything does - including the chapter created two lines above.
     */
    it('filters by created_by, and an unmatched creator returns no rows', async () => {
      const name = uniqueName('list-by-creator');
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name,
        })
      );

      // Who BookStack recorded as the creator: the user this token belongs to.
      const read = await callTool<ChapterWithPages>(chapterTools, 'bookstack_chapters_read', {
        id: chapter.id,
      });
      const creatorId = userRefId(read.created_by);
      expect(creatorId).toBeGreaterThan(0);

      const byCreator = await callTool<ListResponse<Chapter>>(
        chapterTools,
        'bookstack_chapters_list',
        { count: 500, filter: { book_id: parentBook.id, created_by: creatorId } }
      );
      expect(byCreator.data.some((candidate) => candidate.id === chapter.id)).toBe(true);
      // Every row really was created by that user - not merely ours among them.
      expect(
        byCreator.data.every((candidate) => userRefId(candidate.created_by) === creatorId)
      ).toBe(true);

      // Deliberately unscoped by book: if the filter were dropped this would answer
      // with every chapter on the instance, ours included.
      const noSuchCreator = await callTool<ListResponse<Chapter>>(
        chapterTools,
        'bookstack_chapters_list',
        { count: 500, filter: { created_by: 99_999_999 } }
      );
      expect(noSuchCreator.data).toEqual([]);
      // Safe to assert exactly: a user who does not exist created nothing, whatever
      // else is on this shared instance.
      expect(noSuchCreator.total).toBe(0);
    }, 120_000);
  });

  describe('bookstack_chapters_update', () => {
    it('renames a chapter and persists the change', async () => {
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name: uniqueName('update'),
          description: 'Before.',
        })
      );

      const renamed = uniqueName('update-renamed');
      const updated = await callTool<Chapter>(chapterTools, 'bookstack_chapters_update', {
        id: chapter.id,
        name: renamed,
        description: 'After.',
      });

      expect(updated.id).toBe(chapter.id);
      expect(updated.name).toBe(renamed);
      expect(updated.description).toBe('After.');

      const read = await callTool<ChapterWithPages>(chapterTools, 'bookstack_chapters_read', {
        id: chapter.id,
      });
      expect(read.name).toBe(renamed);
      expect(read.description).toBe('After.');
    }, 120_000);

    it('moves a chapter to a different book', async () => {
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name: uniqueName('move'),
        })
      );

      const destination = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', {
          name: uniqueName('move-destination-book'),
        })
      );

      const moved = await callTool<Chapter>(chapterTools, 'bookstack_chapters_update', {
        id: chapter.id,
        book_id: destination.id,
      });

      expect(moved.book_id).toBe(destination.id);

      // It really left the old book and arrived in the new one.
      const destinationRead = await callTool<BookReadResponse>(bookTools, 'bookstack_books_read', {
        id: destination.id,
      });
      expect(destinationRead.contents.some((entry) => entry.id === chapter.id)).toBe(true);

      const originRead = await callTool<BookReadResponse>(bookTools, 'bookstack_books_read', {
        id: parentBook.id,
      });
      expect(originRead.contents.some((entry) => entry.id === chapter.id)).toBe(false);
    }, 120_000);

    it('replaces tags wholesale rather than merging them', async () => {
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name: uniqueName('update-tags'),
          tags: [
            { name: 'Keep', value: 'no' },
            { name: 'Drop', value: 'yes' },
          ],
        })
      );

      const updated = await callTool<Chapter>(chapterTools, 'bookstack_chapters_update', {
        id: chapter.id,
        tags: [{ name: 'Only', value: 'this' }],
      });

      // `tags` is optional on the type (absent from list responses); a single read
      // like this always carries it, and toHaveLength(1) fails first if it ever does not.
      expect(updated.tags).toHaveLength(1);
      expect(updated.tags?.[0]).toMatchObject({ name: 'Only', value: 'this' });
    }, 120_000);
  });

  describe('bookstack_chapters_delete', () => {
    it('soft-deletes a chapter and its pages', async () => {
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name: uniqueName('delete'),
        })
      );

      const page = track(
        'page',
        await callTool<Page>(pageTools, 'bookstack_pages_create', {
          chapter_id: chapter.id,
          name: uniqueName('delete-child-page'),
          markdown: '# Child\n\nGoes with the chapter.',
        })
      );

      const result = await callTool<DeleteResult>(chapterTools, 'bookstack_chapters_delete', {
        id: chapter.id,
      });

      expect(result).toEqual({
        success: true,
        message: `Chapter ${chapter.id} deleted successfully`,
      });

      await expect(
        callTool(chapterTools, 'bookstack_chapters_read', { id: chapter.id })
      ).rejects.toThrow(/not found/i);

      // The tool warns that deleting a chapter takes its pages with it.
      await expect(callTool(pageTools, 'bookstack_pages_read', { id: page.id })).rejects.toThrow(
        /not found/i
      );

      const book = await callTool<BookReadResponse>(bookTools, 'bookstack_books_read', {
        id: parentBook.id,
      });
      expect(book.contents.some((entry) => entry.id === chapter.id)).toBe(false);
    }, 120_000);
  });

  describe('bookstack_chapters_export', () => {
    it('exports chapter content, including its pages, in text formats', async () => {
      const chapterName = uniqueName('export');
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name: chapterName,
          description: 'Exportable chapter.',
        })
      );

      const pageName = uniqueName('export-page');
      track(
        'page',
        await callTool<Page>(pageTools, 'bookstack_pages_create', {
          chapter_id: chapter.id,
          name: pageName,
          markdown: '# Heading\n\nChapter export body text.',
        })
      );

      // Each format: a populated ExportResult whose metadata is right, and whose
      // `content` really is the document - not an empty envelope, and not the
      // raw body handed back as a bare string (which left `.content` undefined).
      const markdown = await callTool<ExportResult>(chapterTools, 'bookstack_chapters_export', {
        id: chapter.id,
        format: 'markdown',
      });
      const markdownText = expectTextExport(markdown, 'markdown', chapter.slug);
      expect(markdownText).toContain(chapterName);
      expect(markdownText).toContain('Chapter export body text.');

      const plaintext = await callTool<ExportResult>(chapterTools, 'bookstack_chapters_export', {
        id: chapter.id,
        format: 'plaintext',
      });
      const plaintextText = expectTextExport(plaintext, 'plaintext', chapter.slug);
      expect(plaintextText).toContain(pageName);
      expect(plaintextText).toContain('Chapter export body text.');

      const html = await callTool<ExportResult>(chapterTools, 'bookstack_chapters_export', {
        id: chapter.id,
        format: 'html',
      });
      const htmlText = expectTextExport(html, 'html', chapter.slug);
      expect(htmlText).toContain(chapterName);
      expect(htmlText).toContain('Chapter export body text.');
    }, 120_000);

    it('exports a chapter as a base64-encoded, structurally valid pdf', async () => {
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name: uniqueName('export-pdf'),
        })
      );
      track(
        'page',
        await callTool<Page>(pageTools, 'bookstack_pages_create', {
          chapter_id: chapter.id,
          name: uniqueName('export-pdf-page'),
          markdown: '# Pdf\n\nBody.',
        })
      );

      const pdf = await callTool<ExportResult>(chapterTools, 'bookstack_chapters_export', {
        id: chapter.id,
        format: 'pdf',
      });

      expectPdfExport(pdf, chapter.slug);
    }, 120_000);

    it('reports a missing chapter on export', async () => {
      await expect(
        callTool(chapterTools, 'bookstack_chapters_export', { id: 99_999_999, format: 'markdown' })
      ).rejects.toThrow(/not found/i);
    }, 120_000);
  });
});

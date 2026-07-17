/**
 * Integration tests for the six `bookstack_pages_*` MCP tools against a live
 * BookStack.
 *
 * Drives the tools themselves - a real `BookStackClient`, `ValidationHandler`
 * and `Logger` wired into `PageTools` the way `server.ts` wires them - rather
 * than the REST API directly. `BookTools` and `ChapterTools` appear only as
 * fixtures: pages are leaf nodes, so both parent shapes have to exist to test
 * them properly (a page inside a chapter, and a page directly in a book).
 *
 * ## Isolation
 *
 * The instance is shared with concurrently-running suites, so every entity gets
 * a unique name, every assertion is scoped to entities this file created, and
 * nothing asserts on `total` or list completeness. Everything created is deleted
 * *and* purged from the recycle bin (DELETE is only a soft delete) - our own
 * entries only, never the whole bin.
 *
 * ## Moving a page to its book root
 *
 * There is no "no chapter" value: `chapter_id: 0` makes BookStack answer 404, and
 * `chapter_id: null` is rejected 422 ("The chapter id must be an integer"), so it
 * cannot be expressed through the tool's `z.number().optional()` schema either.
 * Sending `book_id` on its own is the real mechanism - the page lands at the book
 * root and its `chapter_id` becomes null. All three are asserted below.
 *
 * ## Exports
 *
 * `bookstack_pages_export` answers with an `ExportResult`:
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
  ExportFormat,
  ExportResult,
  ListResponse,
  MCPTool,
  Page,
  PageWithContent,
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
 * Response shapes, taken straight from `src/types` - they model the real
 * payloads now, so there is nothing left to work around:
 *
 *  - `created_by`/`updated_by`/`owned_by` are `UserRef`, covering both
 *    renderings BookStack uses for the same entity (a bare user id in list
 *    responses, an expanded `{id,name,slug}` on a single read).
 *  - `Page.chapter_id` is `number | null` and always present - `null` is exactly
 *    what a page sitting straight in a book reports.
 *  - `PageWithContent` adds the `html`/`raw_html`/`markdown` that create, read
 *    and update all return.
 */
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
  return `itest-pages-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

describe.skipIf(!runIntegration)('bookstack_pages_* tools (live BookStack)', () => {
  let harness: BookStackHarness;
  let bookTools: BookTools;
  let chapterTools: ChapterTools;
  let pageTools: PageTools;

  /** Parents for the pages under test; created once for the whole suite. */
  let parentBook: Book;
  let parentChapter: Chapter;

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
        description: 'Parent book for the pages integration suite.',
      })
    );

    parentChapter = track(
      'chapter',
      await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
        book_id: parentBook.id,
        name: uniqueName('parent-chapter'),
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

  it('registers all six page tools', () => {
    const names = pageTools.getTools().map((tool) => tool.name);

    expect(names).toEqual([
      'bookstack_pages_list',
      'bookstack_pages_create',
      'bookstack_pages_read',
      'bookstack_pages_update',
      'bookstack_pages_delete',
      'bookstack_pages_export',
    ]);
  });

  describe('bookstack_pages_create', () => {
    it('creates a markdown page inside a chapter', async () => {
      const name = uniqueName('create-in-chapter');
      const markdown = '# Heading\n\nMarkdown body text.';

      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name,
          markdown,
          tags: [{ name: 'Format', value: 'markdown' }],
        })
      );

      expect(typeof page.id).toBe('number');
      expect(page.name).toBe(name);
      expect(page.slug).toBe(name.toLowerCase());
      // Nesting: inside the chapter, and the book is inferred from it.
      expect(page.chapter_id).toBe(parentChapter.id);
      expect(page.book_id).toBe(parentBook.id);

      // Markdown is stored verbatim and rendered to HTML by BookStack.
      expect(page.editor).toBe('markdown');
      expect(page.markdown).toBe(markdown);
      expect(page.html).toContain('Heading');
      expect(page.html).toContain('Markdown body text.');
      expect(page.draft).toBe(false);
      expect(page.template).toBe(false);
      expect(page.tags).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Format', value: 'markdown' })])
      );
    }, 120_000);

    it('creates an html page directly in a book, with no chapter', async () => {
      const name = uniqueName('create-in-book');

      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          book_id: parentBook.id,
          name,
          html: '<p>Html body text.</p>',
        })
      );

      expect(page.name).toBe(name);
      expect(page.book_id).toBe(parentBook.id);
      // A page straight in a book has no chapter - BookStack sends null here.
      expect(page.chapter_id).toBeNull();
      expect(page.editor).toBe('wysiwyg');
      expect(page.html).toContain('Html body text.');
    }, 120_000);

    it('requires content and a parent', async () => {
      // strictMode: the zod `pageCreate` refinements reject these before the API.
      await expect(
        callTool(pageTools, 'bookstack_pages_create', {
          book_id: parentBook.id,
          name: uniqueName('no-content'),
        })
      ).rejects.toThrow(/html or markdown/i);

      await expect(
        callTool(pageTools, 'bookstack_pages_create', {
          name: uniqueName('no-parent'),
          markdown: '# Orphan',
        })
      ).rejects.toThrow(/book_id or chapter_id/i);
    }, 120_000);
  });

  describe('bookstack_pages_read', () => {
    it('reads back full page content', async () => {
      const name = uniqueName('read');
      const markdown = '# Readable\n\nDistinctive read body.';
      const created = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name,
          markdown,
        })
      );

      const page = await callTool<PageWithContent>(pageTools, 'bookstack_pages_read', {
        id: created.id,
      });

      expect(page.id).toBe(created.id);
      expect(page.name).toBe(name);
      expect(page.chapter_id).toBe(parentChapter.id);
      expect(page.book_id).toBe(parentBook.id);
      // The tool promises "raw HTML and Markdown content" - check both arrive.
      expect(page.markdown).toBe(markdown);
      expect(page.html).toContain('Distinctive read body.');
      expect(page.raw_html).toContain('Distinctive read body.');
      expect(page.revision_count).toBeGreaterThanOrEqual(1);
    }, 120_000);

    it('rejects a non-positive id and reports a missing page', async () => {
      await expect(callTool(pageTools, 'bookstack_pages_read', { id: 0 })).rejects.toThrow(
        />0|too_small/i
      );

      await expect(callTool(pageTools, 'bookstack_pages_read', { id: 99_999_999 })).rejects.toThrow(
        /not found/i
      );
    }, 120_000);
  });

  describe('bookstack_pages_list', () => {
    it('finds a created page by chapter_id filter and honours count', async () => {
      const name = uniqueName('list-in-chapter');
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name,
          markdown: '# Listed',
        })
      );

      const list = await callTool<ListResponse<Page>>(pageTools, 'bookstack_pages_list', {
        count: 500,
        filter: { chapter_id: parentChapter.id },
      });

      expect(Array.isArray(list.data)).toBe(true);
      expect(typeof list.total).toBe('number');

      // Present *among* results, and every result belongs to our own chapter.
      const mine = list.data.find((candidate) => candidate.id === page.id);
      expect(mine).toBeDefined();
      expect(mine?.name).toBe(name);
      expect(list.data.every((candidate) => candidate.chapter_id === parentChapter.id)).toBe(true);

      const capped = await callTool<ListResponse<Page>>(pageTools, 'bookstack_pages_list', {
        count: 1,
      });
      expect(capped.data.length).toBeLessThanOrEqual(1);
    }, 120_000);

    it('filters by book_id, by name, and applies sort', async () => {
      const name = uniqueName('list-by-name');
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          book_id: parentBook.id,
          name,
          markdown: '# Filtered',
        })
      );

      const byBook = await callTool<ListResponse<Page>>(pageTools, 'bookstack_pages_list', {
        count: 500,
        filter: { book_id: parentBook.id },
      });
      expect(byBook.data.some((candidate) => candidate.id === page.id)).toBe(true);
      expect(byBook.data.every((candidate) => candidate.book_id === parentBook.id)).toBe(true);

      const byName = await callTool<ListResponse<Page>>(pageTools, 'bookstack_pages_list', {
        count: 500,
        filter: { name },
      });
      expect(byName.data.some((candidate) => candidate.id === page.id)).toBe(true);

      const sorted = await callTool<ListResponse<Page>>(pageTools, 'bookstack_pages_list', {
        count: 20,
        sort: 'created_at',
      });
      // Ordering within this response only - independent of other suites.
      const timestamps = sorted.data.map((entry) => entry.created_at);
      expect(timestamps).toEqual([...timestamps].sort());
    }, 120_000);
  });

  describe('bookstack_pages_update', () => {
    it('renames a page and replaces its content', async () => {
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name: uniqueName('update'),
          markdown: '# Before\n\nOriginal body.',
        })
      );

      const renamed = uniqueName('update-renamed');
      const updated = await callTool<PageWithContent>(pageTools, 'bookstack_pages_update', {
        id: page.id,
        name: renamed,
        markdown: '# After\n\nReplacement body.',
      });

      expect(updated.id).toBe(page.id);
      expect(updated.name).toBe(renamed);
      // The tool documents that content is replaced entirely, not appended.
      expect(updated.markdown).toBe('# After\n\nReplacement body.');
      expect(updated.html).toContain('Replacement body.');
      expect(updated.html).not.toContain('Original body.');
      expect(updated.revision_count).toBeGreaterThan(page.revision_count);

      const read = await callTool<PageWithContent>(pageTools, 'bookstack_pages_read', {
        id: page.id,
      });
      expect(read.name).toBe(renamed);
      expect(read.markdown).toBe('# After\n\nReplacement body.');
    }, 120_000);

    it('moves a page out of its chapter to the book root, via book_id alone', async () => {
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name: uniqueName('move-to-root'),
          markdown: '# Movable',
        })
      );
      expect(page.chapter_id).toBe(parentChapter.id);

      // Sending `book_id` on its own is the mechanism BookStack implements for
      // detaching a page, and the one the tool documents.
      const moved = await callTool<PageWithContent>(pageTools, 'bookstack_pages_update', {
        id: page.id,
        book_id: parentBook.id,
      });

      expect(moved.book_id).toBe(parentBook.id);
      expect(moved.chapter_id).toBeNull();

      // It persisted, rather than merely being echoed back.
      const read = await callTool<PageWithContent>(pageTools, 'bookstack_pages_read', {
        id: page.id,
      });
      expect(read.chapter_id).toBeNull();
      expect(read.book_id).toBe(parentBook.id);

      // And it really left the chapter.
      const inChapter = await callTool<ListResponse<Page>>(pageTools, 'bookstack_pages_list', {
        count: 500,
        filter: { chapter_id: parentChapter.id },
      });
      expect(inChapter.data.some((candidate) => candidate.id === page.id)).toBe(false);
    }, 120_000);

    it('has no chapter_id value meaning "no chapter", and leaves the page put', async () => {
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name: uniqueName('no-detach-value'),
          markdown: '# Staying',
        })
      );

      // `0` is turned away at our own boundary: `chapter_id` is an entity id, which is
      // `.int().positive()`, so the request is never made. BookStack would only have
      // gone looking for chapter 0 and answered 404 anyway - rejecting it here says so
      // without the round trip, and without a 404 that reads like the *page* is missing.
      await expect(
        callTool(pageTools, 'bookstack_pages_update', { id: page.id, chapter_id: 0 })
      ).rejects.toThrow(/Too small: expected number to be >0/);

      // `null` is turned away by the same schema (BookStack would reject it 422, "The
      // chapter id must be an integer"): it is a number or absent, never null. Neither
      // value can express "no chapter" - so a page cannot be detached from a chapter
      // through this tool at all, which is what this test is really pinning.
      await expect(
        callTool(pageTools, 'bookstack_pages_update', { id: page.id, chapter_id: null })
      ).rejects.toThrow(/expected number, received null/i);

      // Both rejections were clean, and neither reached BookStack: the page is exactly
      // where it started.
      const read = await callTool<PageWithContent>(pageTools, 'bookstack_pages_read', {
        id: page.id,
      });
      expect(read.chapter_id).toBe(parentChapter.id);
      expect(read.book_id).toBe(parentBook.id);
    }, 120_000);

    it('moves a page into a chapter', async () => {
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          book_id: parentBook.id,
          name: uniqueName('move-into-chapter'),
          markdown: '# Movable',
        })
      );
      expect(page.chapter_id).toBeNull();

      const destination = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: parentBook.id,
          name: uniqueName('move-destination-chapter'),
        })
      );

      const moved = await callTool<PageWithContent>(pageTools, 'bookstack_pages_update', {
        id: page.id,
        chapter_id: destination.id,
      });

      expect(moved.chapter_id).toBe(destination.id);
      expect(moved.book_id).toBe(parentBook.id);
    }, 120_000);

    it('replaces tags wholesale rather than merging them', async () => {
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name: uniqueName('update-tags'),
          markdown: '# Tagged',
          tags: [
            { name: 'Keep', value: 'no' },
            { name: 'Drop', value: 'yes' },
          ],
        })
      );

      const updated = await callTool<PageWithContent>(pageTools, 'bookstack_pages_update', {
        id: page.id,
        tags: [{ name: 'Only', value: 'this' }],
      });

      // `tags` is optional on the type (absent from list responses); a single read
      // like this always carries it, and toHaveLength(1) fails first if it ever does not.
      expect(updated.tags).toHaveLength(1);
      expect(updated.tags?.[0]).toMatchObject({ name: 'Only', value: 'this' });
    }, 120_000);
  });

  describe('bookstack_pages_delete', () => {
    it('soft-deletes a page so it can no longer be read', async () => {
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name: uniqueName('delete'),
          markdown: '# Doomed',
        })
      );

      const result = await callTool<DeleteResult>(pageTools, 'bookstack_pages_delete', {
        id: page.id,
      });

      expect(result).toEqual({
        success: true,
        message: `Page ${page.id} deleted successfully`,
      });

      await expect(callTool(pageTools, 'bookstack_pages_read', { id: page.id })).rejects.toThrow(
        /not found/i
      );

      const list = await callTool<ListResponse<Page>>(pageTools, 'bookstack_pages_list', {
        count: 500,
        filter: { chapter_id: parentChapter.id },
      });
      expect(list.data.some((candidate) => candidate.id === page.id)).toBe(false);

      // The page is in the recycle bin, not gone; afterAll purges it for real.
    }, 120_000);
  });

  describe('bookstack_pages_export', () => {
    it('exports page content in every advertised text format', async () => {
      const name = uniqueName('export');
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name,
          markdown: '# Heading\n\nDistinctive page export body.',
        })
      );

      // Each format: a populated ExportResult whose metadata is right, and whose
      // `content` really is the document - not an empty envelope, and not the
      // raw body handed back as a bare string (which left `.content` undefined).
      const markdown = await callTool<ExportResult>(pageTools, 'bookstack_pages_export', {
        id: page.id,
        format: 'markdown',
      });
      const markdownText = expectTextExport(markdown, 'markdown', page.slug);
      expect(markdownText).toContain(name);
      expect(markdownText).toContain('Distinctive page export body.');

      const plaintext = await callTool<ExportResult>(pageTools, 'bookstack_pages_export', {
        id: page.id,
        format: 'plaintext',
      });
      const plaintextText = expectTextExport(plaintext, 'plaintext', page.slug);
      expect(plaintextText).toContain('Distinctive page export body.');

      const html = await callTool<ExportResult>(pageTools, 'bookstack_pages_export', {
        id: page.id,
        format: 'html',
      });
      const htmlText = expectTextExport(html, 'html', page.slug);
      expect(htmlText).toContain('Distinctive page export body.');
    }, 120_000);

    it('exports a page as a base64-encoded, structurally valid pdf', async () => {
      const page = track(
        'page',
        await callTool<PageWithContent>(pageTools, 'bookstack_pages_create', {
          chapter_id: parentChapter.id,
          name: uniqueName('export-pdf'),
          markdown: '# Pdf\n\nBody.',
        })
      );

      const pdf = await callTool<ExportResult>(pageTools, 'bookstack_pages_export', {
        id: page.id,
        format: 'pdf',
      });

      expectPdfExport(pdf, page.slug);
    }, 120_000);

    it('reports a missing page on export', async () => {
      await expect(
        callTool(pageTools, 'bookstack_pages_export', { id: 99_999_999, format: 'markdown' })
      ).rejects.toThrow(/not found/i);
    }, 120_000);
  });
});

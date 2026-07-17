/**
 * Integration tests for the six `bookstack_books_*` MCP tools against a live
 * BookStack.
 *
 * Unlike smoke.test.ts (which drives the REST API with raw `fetch`), this suite
 * drives the *tools themselves*: a real `BookStackClient`, `ValidationHandler`
 * and `Logger` are wired into `BookTools` exactly as `server.ts` does, and every
 * assertion goes through `tool.handler(params)`. That is the point - it proves
 * the advertised tool surface works end to end, not merely that BookStack works.
 *
 * ## Isolation
 *
 * This instance is shared with other suites running concurrently, so nothing
 * here may assume it is alone. Two rules follow, and both are load-bearing:
 *
 *  - Every entity gets a unique name, and every assertion is scoped to entities
 *    this file created (found by id/name). We never assert on `total`, on list
 *    completeness, or on ordering relative to entities we do not own.
 *  - Everything created is deleted *and purged* from the recycle bin, since
 *    BookStack's DELETE is only a soft delete. We purge exactly our own entries;
 *    emptying the bin wholesale would destroy other suites' fixtures.
 *
 * ## A note on `bookstack_books_export`
 *
 * `bookstack_books_export` answers with an `ExportResult`:
 * `{content, encoding, byte_length, filename, mime_type}`. Two BookStack quirks
 * shape it, both verified live: every export - markdown included - is labelled
 * `Content-Type: application/octet-stream`, so the real mime type is derived
 * from the requested format; and `Content-Disposition` only ever arrives in the
 * RFC 5987 `filename*=UTF-8''<slug>.<ext>` form.
 *
 * `encoding` is what makes `content` usable. `utf8` means `content` is the
 * document itself; `base64` (pdf) means it must be decoded to recover the bytes,
 * and `content.length` is then a character count, NOT the file size - that is
 * `byte_length`. The pdf cases decode `content` and check the file is
 * structurally intact rather than merely present: they are the regression guard
 * for a corruption bug in which PDF bytes were text-decoded, replacing every
 * invalid sequence with U+FFFD (a 455KB PDF inflating to 781KB of mojibake).
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

// Resolved at collection time so it can gate `describe.skipIf`; a plain
// `bun test` with no BookStack running must still exit 0.
const runIntegration = await shouldRunIntegration();

/**
 * Response shapes.
 *
 * `Book`, `Chapter` and `Page` from `src/types` model the real payloads, so they
 * are used directly: `created_by`/`updated_by`/`owned_by` are `UserRef`, which
 * covers both renderings BookStack uses for the same entity (a bare user id in
 * list responses, an expanded `{id,name,slug}` on a single read).
 *
 * Only `contents` still needs a local shape. `BookWithContents` types it as
 * `(Chapter | Page)[]`, which carries neither the `type` discriminator nor the
 * nested `pages` array BookStack actually sends on a book read.
 */
interface BookContentsEntry {
  id: number;
  name: string;
  type: 'chapter' | 'page';
  pages?: { id: number; name: string }[];
}

interface BookReadResponse extends Book {
  contents: BookContentsEntry[];
}

interface DeleteResult {
  success: boolean;
  message: string;
}

/** Anything exposing MCP tools - `BookTools`, `ChapterTools`, `PageTools`. */
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
 * Invoke a tool by name and narrow its `unknown` result.
 *
 * `MCPTool.handler` returns `Promise<unknown>`, so a cast has to happen
 * somewhere; centralising it here mirrors `apiJson<T>()` in the harness and
 * leaves exactly one place to audit. The assertion is only as good as the
 * declared shape - which is why the tests still assert on real field values.
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

/** Collision-proof across concurrent suites, repeat runs and same-ms creates. */
function uniqueName(label: string): string {
  return `itest-books-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
 * inflates the payload irreversibly (455KB -> 781KB against this instance).
 * Checking `%PDF-` on a decoded string would NOT have caught that - the magic
 * number is ascii and survives mojibake untouched - so this decodes the base64
 * and checks the file's own internal byte offsets still resolve, which a
 * corrupted payload cannot fake.
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

describe.skipIf(!runIntegration)('bookstack_books_* tools (live BookStack)', () => {
  let harness: BookStackHarness;
  let bookTools: BookTools;
  let chapterTools: ChapterTools;
  let pageTools: PageTools;

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

  it('registers all six book tools', () => {
    const names = bookTools.getTools().map((tool) => tool.name);

    expect(names).toEqual([
      'bookstack_books_list',
      'bookstack_books_create',
      'bookstack_books_read',
      'bookstack_books_update',
      'bookstack_books_delete',
      'bookstack_books_export',
    ]);
  });

  describe('bookstack_books_create', () => {
    it('creates a book and round-trips name, description and tags', async () => {
      const name = uniqueName('create');

      const book = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', {
          name,
          description: 'Created by the books integration suite.',
          tags: [
            { name: 'Suite', value: 'books' },
            { name: 'Kind', value: 'integration' },
          ],
        })
      );

      expect(typeof book.id).toBe('number');
      expect(book.id).toBeGreaterThan(0);
      expect(book.name).toBe(name);
      expect(book.slug).toBe(name.toLowerCase());
      expect(book.description).toBe('Created by the books integration suite.');
      expect(book.tags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Suite', value: 'books' }),
          expect.objectContaining({ name: 'Kind', value: 'integration' }),
        ])
      );
    }, 120_000);

    it('rejects an empty name before reaching BookStack', async () => {
      // strictMode is on, so the zod `bookCreate` schema throws rather than
      // letting an invalid payload through to the API.
      await expect(callTool(bookTools, 'bookstack_books_create', { name: '' })).rejects.toThrow(
        /at least 1|>=1|too_small/i
      );
    }, 120_000);
  });

  describe('bookstack_books_read', () => {
    it('reads back a created book by id', async () => {
      const name = uniqueName('read');
      const created = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', {
          name,
          description: 'Readable book.',
        })
      );

      const book = await callTool<BookReadResponse>(bookTools, 'bookstack_books_read', {
        id: created.id,
      });

      expect(book.id).toBe(created.id);
      expect(book.name).toBe(name);
      expect(book.description).toBe('Readable book.');
      // A fresh book has no chapters or pages yet.
      expect(book.contents).toEqual([]);
    }, 120_000);

    it('exposes the nested chapter/page hierarchy in `contents`', async () => {
      const bookName = uniqueName('hierarchy');
      const book = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', { name: bookName })
      );

      const chapterName = uniqueName('hierarchy-chapter');
      const chapter = track(
        'chapter',
        await callTool<Chapter>(chapterTools, 'bookstack_chapters_create', {
          book_id: book.id,
          name: chapterName,
        })
      );

      const nestedPageName = uniqueName('hierarchy-page-in-chapter');
      const nestedPage = track(
        'page',
        await callTool<Page>(pageTools, 'bookstack_pages_create', {
          chapter_id: chapter.id,
          name: nestedPageName,
          markdown: '# Nested\n\nA page inside a chapter.',
        })
      );

      const directPageName = uniqueName('hierarchy-page-in-book');
      const directPage = track(
        'page',
        await callTool<Page>(pageTools, 'bookstack_pages_create', {
          book_id: book.id,
          name: directPageName,
          html: '<p>A page straight in the book.</p>',
        })
      );

      const read = await callTool<BookReadResponse>(bookTools, 'bookstack_books_read', {
        id: book.id,
      });

      // Scoped strictly to this book, so concurrent suites cannot perturb it.
      const chapterEntry = read.contents.find((entry) => entry.id === chapter.id);
      expect(chapterEntry).toBeDefined();
      expect(chapterEntry?.type).toBe('chapter');
      expect(chapterEntry?.name).toBe(chapterName);

      // The chapter's page is nested under the chapter, not at book level.
      expect(chapterEntry?.pages?.map((page) => page.id)).toContain(nestedPage.id);

      const directEntry = read.contents.find((entry) => entry.id === directPage.id);
      expect(directEntry).toBeDefined();
      expect(directEntry?.type).toBe('page');
      expect(directEntry?.name).toBe(directPageName);
    }, 120_000);

    it('rejects a non-positive id and reports a missing book', async () => {
      await expect(callTool(bookTools, 'bookstack_books_read', { id: 0 })).rejects.toThrow(
        />0|too_small/i
      );

      await expect(callTool(bookTools, 'bookstack_books_read', { id: 99_999_999 })).rejects.toThrow(
        /not found/i
      );
    }, 120_000);
  });

  describe('bookstack_books_list', () => {
    it('finds a created book by name filter and honours count', async () => {
      const name = uniqueName('list');
      const book = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', { name })
      );

      const list = await callTool<ListResponse<Book>>(bookTools, 'bookstack_books_list', {
        count: 500,
        filter: { name },
      });

      expect(Array.isArray(list.data)).toBe(true);
      expect(typeof list.total).toBe('number');

      // Present *among* the results - never "is the only one" or "is first":
      // other suites create books against this same instance concurrently.
      const mine = list.data.find((candidate) => candidate.id === book.id);
      expect(mine).toBeDefined();
      expect(mine?.name).toBe(name);

      const capped = await callTool<ListResponse<Book>>(bookTools, 'bookstack_books_list', {
        count: 1,
      });
      expect(capped.data.length).toBeLessThanOrEqual(1);
    }, 120_000);

    it('applies sort and offset', async () => {
      const sorted = await callTool<ListResponse<Book>>(bookTools, 'bookstack_books_list', {
        count: 20,
        sort: 'created_at',
      });

      // Ordering *within the returned page* - a property of this response
      // alone, so it holds regardless of what other suites are creating.
      const timestamps = sorted.data.map((book) => book.created_at);
      const ascending = [...timestamps].sort();
      expect(timestamps).toEqual(ascending);

      const offset = await callTool<ListResponse<Book>>(bookTools, 'bookstack_books_list', {
        count: 5,
        offset: 1,
        sort: 'created_at',
      });
      expect(Array.isArray(offset.data)).toBe(true);
      expect(offset.data.length).toBeLessThanOrEqual(5);
    }, 120_000);
  });

  describe('bookstack_books_update', () => {
    it('updates name and description, and persists them', async () => {
      const name = uniqueName('update');
      const book = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', {
          name,
          description: 'Before.',
        })
      );

      const renamed = uniqueName('update-renamed');
      const updated = await callTool<Book>(bookTools, 'bookstack_books_update', {
        id: book.id,
        name: renamed,
        description: 'After.',
      });

      expect(updated.id).toBe(book.id);
      expect(updated.name).toBe(renamed);
      expect(updated.description).toBe('After.');

      // Re-read through the read tool: proves it persisted, not just echoed.
      const read = await callTool<BookReadResponse>(bookTools, 'bookstack_books_read', {
        id: book.id,
      });
      expect(read.name).toBe(renamed);
      expect(read.description).toBe('After.');
    }, 120_000);

    it('replaces tags wholesale rather than merging them', async () => {
      const name = uniqueName('update-tags');
      const book = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', {
          name,
          tags: [
            { name: 'Keep', value: 'no' },
            { name: 'Drop', value: 'yes' },
          ],
        })
      );

      const updated = await callTool<Book>(bookTools, 'bookstack_books_update', {
        id: book.id,
        tags: [{ name: 'Only', value: 'this' }],
      });

      // The tool documents "replaces existing tags" - verify that literally.
      // `tags` is optional on the type (absent from list responses); a single read
      // like this always carries it, and toHaveLength(1) fails first if it ever does not.
      expect(updated.tags).toHaveLength(1);
      expect(updated.tags?.[0]).toMatchObject({ name: 'Only', value: 'this' });
    }, 120_000);
  });

  describe('bookstack_books_delete', () => {
    it('soft-deletes a book so it can no longer be read', async () => {
      const name = uniqueName('delete');
      const book = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', { name })
      );

      const result = await callTool<DeleteResult>(bookTools, 'bookstack_books_delete', {
        id: book.id,
      });

      expect(result).toEqual({
        success: true,
        message: `Book ${book.id} deleted successfully`,
      });

      await expect(callTool(bookTools, 'bookstack_books_read', { id: book.id })).rejects.toThrow(
        /not found/i
      );

      // The book is in the recycle bin, not gone; afterAll purges it for real.
    }, 120_000);
  });

  describe('bookstack_books_export', () => {
    it('exports book content in every advertised text format', async () => {
      const bookName = uniqueName('export');
      const book = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', {
          name: bookName,
          description: 'Exportable book.',
        })
      );

      const pageName = uniqueName('export-page');
      track(
        'page',
        await callTool<Page>(pageTools, 'bookstack_pages_create', {
          book_id: book.id,
          name: pageName,
          markdown: '# Heading\n\nDistinctive export body text.',
        })
      );

      // Each format: a populated ExportResult whose metadata is right, and whose
      // `content` really is the document - not an empty envelope, and not the
      // raw body handed back as a bare string (which left `.content` undefined).
      const markdown = await callTool<ExportResult>(bookTools, 'bookstack_books_export', {
        id: book.id,
        format: 'markdown',
      });
      const markdownText = expectTextExport(markdown, 'markdown', book.slug);
      expect(markdownText).toContain(bookName);
      expect(markdownText).toContain('Distinctive export body text.');

      const plaintext = await callTool<ExportResult>(bookTools, 'bookstack_books_export', {
        id: book.id,
        format: 'plaintext',
      });
      const plaintextText = expectTextExport(plaintext, 'plaintext', book.slug);
      expect(plaintextText).toContain(pageName);
      expect(plaintextText).toContain('Distinctive export body text.');

      const html = await callTool<ExportResult>(bookTools, 'bookstack_books_export', {
        id: book.id,
        format: 'html',
      });
      const htmlText = expectTextExport(html, 'html', book.slug);
      expect(htmlText).toContain('<!doctype html>');
      expect(htmlText).toContain(bookName);
    }, 120_000);

    it('exports a book as a base64-encoded, structurally valid pdf', async () => {
      const bookName = uniqueName('export-pdf');
      const book = track(
        'book',
        await callTool<Book>(bookTools, 'bookstack_books_create', { name: bookName })
      );
      track(
        'page',
        await callTool<Page>(pageTools, 'bookstack_pages_create', {
          book_id: book.id,
          name: uniqueName('export-pdf-page'),
          markdown: '# Pdf\n\nBody.',
        })
      );

      const pdf = await callTool<ExportResult>(bookTools, 'bookstack_books_export', {
        id: book.id,
        format: 'pdf',
      });

      expectPdfExport(pdf, book.slug);
    }, 120_000);

    it('reports a missing book on export', async () => {
      await expect(
        callTool(bookTools, 'bookstack_books_export', { id: 99_999_999, format: 'markdown' })
      ).rejects.toThrow(/not found/i);
    }, 120_000);
  });
});

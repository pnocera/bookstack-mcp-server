/**
 * Integration tests for the recycle-bin MCP tools against a live BookStack.
 *
 * Tools covered here (3):
 *   - bookstack_recyclebin_list
 *   - bookstack_recyclebin_restore
 *   - bookstack_recyclebin_delete_permanently
 *
 * SHARED-INSTANCE SAFETY. The recycle bin is global state that other suites are
 * concurrently filling with their own fixtures. Two rules keep this suite from
 * destroying their work:
 *
 *   1. Every restore/purge targets a deletion id this suite located by matching
 *      its OWN freshly-created entity (unique name + id). Never "the first entry",
 *      never a sweep over the listing.
 *   2. No assertion depends on a global count or on list completeness — `total`
 *      moves under our feet. Membership of our own entry, and the relative order
 *      of two entries we own, are the only claims made.
 *
 * Gating: skipped automatically when BookStack is not reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ZodError } from 'zod';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { RecycleBinTools } from '../../src/tools/recyclebin';
import type { ListResponse, MCPTool, RecycleBinItem } from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  apiFetch,
  apiJson,
  apiUrl,
  type BookStackBook,
  type BookStackHarness,
  CleanupTracker,
  ensureBookStack,
  shouldRunIntegration,
  tokenString,
} from './helpers/bookstack';

const runIntegration = await shouldRunIntegration();

if (!runIntegration) {
  console.log(
    '[integration] BookStack unreachable and RUN_INTEGRATION unset - skipping recycle-bin tool suite.'
  );
}

/**
 * THE SHARED BUDGET. BookStack throttles the API per user over a 60s window, and
 * every integration suite on this instance authenticates as the same admin token —
 * so a *neighbouring* suite can exhaust the budget this one needs, and a 429 here
 * says nothing about the recycle-bin tools.
 *
 * This test instance is provisioned well above BookStack's 180/min default, so the
 * retries below should effectively never fire. They stay because the default is
 * what a real deployment runs. Only 429 is ever retried: every other status flows
 * straight through, so real failures still fail.
 */

/** Sleep until the window named by X-RateLimit-Reset reopens (bounded). */
const sleepUntilWindowReopens = async (res: Response): Promise<void> => {
  const resetAt = Number(res.headers.get('X-RateLimit-Reset')) * 1000;
  const waitMs = Number.isFinite(resetAt) ? resetAt - Date.now() : 15_000;
  await Bun.sleep(Math.min(Math.max(waitMs, 1_000), 65_000));
};

/** Probe the instance; if it is throttling, wait for the window to reopen. */
const waitForBudget = async (): Promise<void> => {
  const probe = await fetch(`${apiUrl()}/books?count=1`, {
    headers: { Authorization: `Token ${tokenString()}` },
  });
  if (probe.status === 429) await sleepUntilWindowReopens(probe);
};

/**
 * Wait out the shared budget, then connect.
 *
 * A throttled-but-perfectly-valid token must not be reported as an auth failure.
 * Laravel rejects a throttled request before incrementing its counter, so probing
 * costs nothing while we are over the limit.
 */
const connectWhenNotThrottled = async (): Promise<BookStackHarness> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const probe = await fetch(`${apiUrl()}/books?count=1`, {
      headers: { Authorization: `Token ${tokenString()}` },
    });
    if (probe.status !== 429) break;
    await sleepUntilWindowReopens(probe);
  }

  return await ensureBookStack();
};

/** apiFetch() for fixture work, retried while the instance is throttling us. */
const apiFetchWithinBudget = async (
  harness: BookStackHarness,
  path: string,
  init: RequestInit = {}
): Promise<Response> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await apiFetch(harness, path, init);
    if (res.status !== 429) return res;
    await sleepUntilWindowReopens(res);
  }

  return await apiFetch(harness, path, init);
};

/**
 * Every field a `GET /recycle-bin` row carries on BookStack v26 — no more, no less.
 *
 * `src/types.ts`'s `RecycleBinItem` now declares exactly these, so the suite types
 * responses as `RecycleBinItem` rather than a local stand-in. The interface once
 * declared a `deleted_at` the endpoint has never returned: a deletion's timestamp
 * arrives as `created_at` (the row *is* the deletion, so its creation is the
 * deletion). The client casts with an unchecked `as`, so asserting this key set is
 * the only thing that would catch a re-drift.
 */
const RECYCLE_BIN_FIELDS = [
  'created_at',
  'deletable',
  'deletable_id',
  'deletable_type',
  'deleted_by',
  'id',
  'updated_at',
] as const;

/** `RecycleBinItem.deletable` is `unknown` by design — narrow it where needed. */
const deletableName = (entry: RecycleBinItem): string | undefined => {
  const deletable = entry.deletable;
  if (deletable && typeof deletable === 'object' && 'name' in deletable) {
    const name = (deletable as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
};

/** A unique name so this suite can always find its own rows in shared state. */
const unique = (prefix: string): string =>
  `itest-bin-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!runIntegration)('recycle-bin tools (live BookStack)', () => {
  let harness: BookStackHarness;
  let tools: Map<string, MCPTool>;
  /**
   * The same tools wired to a validator in STRICT mode - the shipped default.
   *
   * The suite proper runs non-strict on purpose (see `config` below), but that mode
   * cannot show a boundary rejection: it logs the violation and passes the params
   * through. Both modes ship, so both are tested, and a test that claims a request was
   * never sent needs the mode where that is true.
   */
  let strictTools: Map<string, MCPTool>;
  /**
   * Everything this suite created, so a mid-test failure still gets cleaned up - and so
   * teardown fails loudly rather than dropping an id whose delete BookStack refused.
   * Two `itest-bin-restore-*` books and three `itest-bin-*` deletion rows survived an
   * all-green run of the old teardown.
   */
  const cleanup = new CleanupTracker();

  beforeAll(async () => {
    harness = await connectWhenNotThrottled();

    const config: Config = {
      bookstack: { baseUrl: harness.baseUrl, apiToken: harness.token, timeout: 30_000 },
      server: { name: 'bookstack-mcp-server', version: '1.0.0', port: 3000 },
      // The production defaults. Every suite here authenticates as the same admin
      // user, so pacing outbound calls keeps one suite from starving its
      // neighbours even where the instance itself would allow more.
      rateLimit: { requestsPerMinute: 60, burstLimit: 10 },
      validation: { enabled: true, strictMode: false },
      logging: { level: 'error', format: 'json' },
      development: { nodeEnv: 'test', debug: false },
    };

    const logger = Logger.getInstance();
    const client = new BookStackClient(config, logger, new ErrorHandler(logger));
    const validator = new ValidationHandler(config.validation);

    tools = new Map<string, MCPTool>();
    for (const tool of new RecycleBinTools(client, validator, logger).getTools()) {
      tools.set(tool.name, tool);
    }

    strictTools = new Map<string, MCPTool>();
    for (const tool of new RecycleBinTools(
      client,
      new ValidationHandler({ enabled: true, strictMode: true }),
      logger
    ).getTools()) {
      strictTools.set(tool.name, tool);
    }
    // Generous: connecting may have to sit out a full rate-limit window first.
  }, 240_000);

  // Cleanup can have to sit out a rate-limit window, which overruns bun's 5s default
  // hook timeout - and a timed-out afterAll leaks fixtures. The tracker deletes each
  // book, purges its own deletion row, and re-reads the id to confirm; anything left
  // fails this hook rather than passing quietly, which is what the old
  // `.catch(() => {})` + ignored-boolean pair did while leaking.
  afterAll(async () => {
    if (!harness) return;
    await cleanup.run(harness);
  }, 240_000);

  const findTool = (name: string): MCPTool => {
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool;
  };

  const findStrictTool = (name: string): MCPTool => {
    const tool = strictTools.get(name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool;
  };

  /**
   * Invoke a tool, retrying only while the *instance* is throttling us.
   *
   * A 429 surfaces to the caller as McpError "Rate limit exceeded" — a statement
   * about a neighbouring suite's traffic, not about the tool under test. Waiting
   * the window out and re-issuing is therefore noise reduction, not assertion
   * softening: every other error (404, 422, a zod rejection) propagates on the
   * first attempt and still fails the test, and the assertions all run against the
   * eventual real response.
   */
  const callTool = async (name: string, params: unknown): Promise<unknown> => {
    const tool = findTool(name);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await tool.handler(params);
      } catch (error) {
        if (!String(error).includes('Rate limit exceeded')) throw error;
        await waitForBudget();
      }
    }
    return await tool.handler(params);
  };

  const listBin = async (params: unknown): Promise<ListResponse<RecycleBinItem>> =>
    (await callTool('bookstack_recyclebin_list', params)) as ListResponse<RecycleBinItem>;

  /** Create a book we own outright, and remember it for cleanup. */
  const createBook = async (name: string): Promise<BookStackBook> => {
    const res = await apiFetchWithinBudget(harness, '/books', {
      method: 'POST',
      body: JSON.stringify({ name, description: 'Fixture for the recycle-bin tool suite.' }),
    });
    expect(res.status).toBe(200);

    const book = await apiJson<BookStackBook>(res);
    cleanup.track('book', book.id);
    return book;
  };

  /** Soft-delete one of our own books, landing it in the bin. */
  const softDeleteBook = async (id: number): Promise<void> => {
    const res = await apiFetchWithinBudget(harness, `/books/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  };

  /** Where OUR entry sits in a listing, by index. -1 when absent. */
  const indexOfOwn = (page: ListResponse<RecycleBinItem>, type: string, id: number): number =>
    page.data.findIndex((entry) => entry.deletable_type === type && entry.deletable_id === id);

  /**
   * Locate OUR deletion row through the list tool, paging until it turns up.
   *
   * Paging (rather than one big read) keeps this correct on an instance whose bin
   * holds more rows than a single page, and exercises `offset` as a side effect.
   * Matching on deletable_type + deletable_id is what keeps us off other suites'
   * fixtures.
   */
  const findOwnEntry = async (
    deletableType: string,
    deletableId: number
  ): Promise<RecycleBinItem> => {
    const pageSize = 500; // the schema's documented maximum
    for (let offset = 0; offset < pageSize * 10; offset += pageSize) {
      const page = await listBin({ count: pageSize, offset });

      const match = page.data.find(
        (entry) => entry.deletable_type === deletableType && entry.deletable_id === deletableId
      );
      if (match) return match;
      if (page.data.length < pageSize) break;
    }

    throw new Error(
      `Recycle bin has no entry for ${deletableType} ${deletableId} - the deletion never landed`
    );
  };

  describe('bookstack_recyclebin_list', () => {
    it('registers the three recycle-bin tools', () => {
      expect([...tools.keys()].sort()).toEqual([
        'bookstack_recyclebin_delete_permanently',
        'bookstack_recyclebin_list',
        'bookstack_recyclebin_restore',
      ]);
    });

    it('returns a well-formed list envelope', async () => {
      // Shape only: `total` is shared, concurrently-mutated state.
      const result = await listBin({ count: 1 });

      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeLessThanOrEqual(1);
      expect(typeof result.total).toBe('number');
    });

    it('returns rows carrying exactly the fields RecycleBinItem declares', async () => {
      const name = unique('shape');
      const book = await createBook(name);
      await softDeleteBook(book.id);

      const entry = await findOwnEntry('book', book.id);

      expect(Object.keys(entry).sort()).toEqual([...RECYCLE_BIN_FIELDS]);
      // The deletion timestamp is `created_at`; there is no `deleted_at` to read.
      expect(entry).not.toHaveProperty('deleted_at');
      expect(Number.isNaN(Date.parse(entry.created_at))).toBe(false);
      expect(Number.isNaN(Date.parse(entry.updated_at))).toBe(false);
    }, 60_000);

    it('includes a book we just soft-deleted', async () => {
      const name = unique('list');
      const book = await createBook(name);
      await softDeleteBook(book.id);

      const entry = await findOwnEntry('book', book.id);

      expect(entry.deletable_type).toBe('book');
      expect(entry.deletable_id).toBe(book.id);
      expect(entry.id).toBeGreaterThan(0);
      expect(deletableName(entry)).toBe(name);
      expect(entry.deleted_by).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(entry.created_at))).toBe(false);

      // Purge only OUR row, by the id we just resolved.
      const purge = (await callTool('bookstack_recyclebin_delete_permanently', {
        id: entry.id,
      })) as { success: boolean };
      expect(purge.success).toBe(true);
      // Deliberately left tracked: teardown's DELETE 404s and its bin re-read confirms
      // the row is gone, so the tracker independently re-checks this test's claim.
    }, 60_000);

    it('accepts the default parameters', async () => {
      // No params at all: the validator fills count=20, offset=0, sort=-created_at.
      const result = await listBin({});

      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeLessThanOrEqual(20);
    });

    it('lists the newest deletion first by default', async () => {
      // The default sort named `deleted_at` — a field this endpoint does not have.
      // BookStack accepted the request (HTTP 200) and silently fell back to `id`
      // ascending, so the bin opened on the *oldest* deletions in the instance's
      // history: the exact opposite of what someone undoing a mistake needs.
      const older = await createBook(unique('sort-older'));
      const newer = await createBook(unique('sort-newer'));

      await softDeleteBook(older.id);
      // created_at has one-second granularity; make the two deletions distinct.
      await Bun.sleep(1500);
      await softDeleteBook(newer.id);

      const page = await listBin({ count: 500 });

      const indexOfOlder = indexOfOwn(page, 'book', older.id);
      const indexOfNewer = indexOfOwn(page, 'book', newer.id);
      expect(indexOfOlder).toBeGreaterThanOrEqual(0);
      expect(indexOfNewer).toBeGreaterThanOrEqual(0);

      // The later deletion outranks the earlier one. Under the `id`-ascending
      // fallback these two came back in precisely the opposite order, so this
      // comparison of two rows we own is decisive without touching any total.
      expect(indexOfNewer).toBeLessThan(indexOfOlder);

      // And the page as a whole runs newest-first.
      const times = page.data.map((entry) => Date.parse(entry.created_at));
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1]).toBeGreaterThanOrEqual(times[i] as number);
      }
    }, 90_000);
  });

  describe('bookstack_recyclebin_restore', () => {
    it('restores our own deleted book and reports success', async () => {
      const name = unique('restore');
      const book = await createBook(name);

      await softDeleteBook(book.id);
      expect((await apiFetchWithinBudget(harness, `/books/${book.id}`)).status).toBe(404);

      const entry = await findOwnEntry('book', book.id);

      const result = (await callTool('bookstack_recyclebin_restore', { id: entry.id })) as {
        success: boolean;
        restore_count: number;
        message: string;
      };

      expect(result.success).toBe(true);
      // This fixture is a lone book, so exactly one entity comes back. The subtree case
      // is covered by 'reports the whole subtree it brought back'.
      expect(result.restore_count).toBe(1);
      expect(result.message).toBe(
        `Recycle bin entry ${entry.id} restored, bringing back 1 item(s)`
      );

      // The book is really back, under its original id and name.
      const readRes = await apiFetchWithinBudget(harness, `/books/${book.id}`);
      expect(readRes.status).toBe(200);
      const restored = await apiJson<BookStackBook>(readRes);
      expect(restored.name).toBe(name);

      // ...and its row is gone from the bin.
      await expect(findOwnEntry('book', book.id)).rejects.toThrow(/no entry for book/);
    }, 60_000);

    /**
     * The recycle bin is top-level only: deleting a book with a chapter and a page makes
     * ONE entry, and restoring it brings back all three. `restore_count` is the only
     * signal a caller gets for that, so it is asserted against a real subtree - a lone
     * book would report 1 and pass even if the count were hardcoded.
     */
    it('reports the whole subtree it brought back', async () => {
      const book = await createBook(unique('restore-subtree'));

      const chapterRes = await apiFetchWithinBudget(harness, '/chapters', {
        method: 'POST',
        body: JSON.stringify({ book_id: book.id, name: unique('restore-subtree-chapter') }),
      });
      expect(chapterRes.status).toBe(200);
      const chapter = await apiJson<{ id: number }>(chapterRes);

      const pageRes = await apiFetchWithinBudget(harness, '/pages', {
        method: 'POST',
        body: JSON.stringify({
          chapter_id: chapter.id,
          name: unique('restore-subtree-page'),
          markdown: 'Fixture page for the subtree restore count.',
        }),
      });
      expect(pageRes.status).toBe(200);
      const page = await apiJson<{ id: number }>(pageRes);

      await softDeleteBook(book.id);

      // One entry for the whole tree - not three.
      const entry = await findOwnEntry('book', book.id);

      const result = (await callTool('bookstack_recyclebin_restore', { id: entry.id })) as {
        success: boolean;
        restore_count: number;
        message: string;
      };

      expect(result.success).toBe(true);
      expect(result.restore_count).toBe(3);
      expect(result.message).toBe(
        `Recycle bin entry ${entry.id} restored, bringing back 3 item(s)`
      );

      // The count is not decorative: every entity really is back.
      expect((await apiFetchWithinBudget(harness, `/books/${book.id}`)).status).toBe(200);
      expect((await apiFetchWithinBudget(harness, `/chapters/${chapter.id}`)).status).toBe(200);
      expect((await apiFetchWithinBudget(harness, `/pages/${page.id}`)).status).toBe(200);
    }, 120_000);

    it('rejects a deletion id that does not exist', async () => {
      // 2^31-1 cannot collide with a real deletion row, so this can never touch
      // another suite's fixture.
      await expect(
        callTool('bookstack_recyclebin_restore', { id: 2_147_483_647 })
      ).rejects.toThrow();
    });

    /**
     * The boundary rejection, in the mode that actually has one.
     *
     * This test used to be called "rejects a non-positive deletion id at validation time"
     * and ran against the suite's non-strict tools. It passed - but not for its stated
     * reason, and the name had become a lie. `validateId()`, which threw regardless of
     * mode, is gone; id validation now goes through the `id` schema like every other
     * field, so in NON-strict mode a violation is logged and the params pass through
     * untouched. `{id: 0}` therefore left the client, and BookStack's 404 - a full
     * round-trip - was what the `.rejects` caught. "At validation time" was exactly what
     * was not happening. Both halves of the real behaviour are now tested: this one, and
     * `sends a non-positive deletion id...` below.
     *
     * A ZodError can only have come from our own boundary: an API failure is surfaced as
     * an McpError, so the error's *type* is what proves no request was ever issued.
     */
    it('rejects a non-positive deletion id at the boundary under strict mode', async () => {
      let caught: unknown;
      try {
        await findStrictTool('bookstack_recyclebin_restore').handler({ id: 0 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ZodError);
      const issues = (caught as ZodError).issues;
      // The rejection names the field it is about, and the rule it broke: `id` is
      // `z.number().int().positive()`, so 0 fails the positivity bound.
      expect(issues.map((issue) => issue.path.join('.'))).toEqual(['id']);
      expect(issues[0]?.message).toMatch(/expected number to be >0/);
    });

    /**
     * The other half: what non-strict mode really does with the same input.
     *
     * `VALIDATION_STRICT_MODE=false` ships, and its documented contract is warn-and-
     * continue - so the id is NOT rejected locally, the request goes out, and BookStack
     * answers 404. Asserting that honestly is what keeps the strict test above meaningful:
     * if validation started throwing in both modes, this test fails and says so.
     *
     * Id 0 cannot match a real deletion row, so this can never touch another suite's
     * fixture. Verified live on v26.05.2: `PUT /api/recycle-bin/0` -> HTTP 404.
     */
    it('sends a non-positive deletion id to BookStack under non-strict mode, which 404s', async () => {
      let caught: unknown;
      try {
        await callTool('bookstack_recyclebin_restore', { id: 0 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      // NOT a ZodError: the boundary let it past, which is what non-strict mode means.
      expect(caught).not.toBeInstanceOf(ZodError);
      // The failure came from the far side of the network, not from our validator.
      expect((caught as Error).message).toMatch(/Requested resource not found/);
    });
  });

  describe('bookstack_recyclebin_delete_permanently', () => {
    it('purges our own entry for good', async () => {
      const name = unique('purge');
      const book = await createBook(name);

      await softDeleteBook(book.id);
      const entry = await findOwnEntry('book', book.id);

      const result = (await callTool('bookstack_recyclebin_delete_permanently', {
        id: entry.id,
      })) as { success: boolean; delete_count: number; message: string };

      expect(result.success).toBe(true);
      expect(result.delete_count).toBe(1);
      expect(result.message).toBe(
        `Recycle bin entry ${entry.id} permanently deleted, destroying 1 item(s)`
      );

      // Gone from the bin, and not restored into the books listing either.
      await expect(findOwnEntry('book', book.id)).rejects.toThrow(/no entry for book/);
      expect((await apiFetchWithinBudget(harness, `/books/${book.id}`)).status).toBe(404);
    }, 60_000);

    it('purges a page deleted independently of its book', async () => {
      const bookName = unique('page-parent');
      const book = await createBook(bookName);

      const pageName = unique('page');
      const pageRes = await apiFetchWithinBudget(harness, '/pages', {
        method: 'POST',
        body: JSON.stringify({
          book_id: book.id,
          name: pageName,
          html: '<p>Fixture for the recycle-bin tool suite.</p>',
        }),
      });
      expect(pageRes.status).toBe(200);
      const page = await apiJson<{ id: number; name: string }>(pageRes);

      const deleteRes = await apiFetchWithinBudget(harness, `/pages/${page.id}`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(204);

      const entry = await findOwnEntry('page', page.id);
      expect(deletableName(entry)).toBe(pageName);

      const result = (await callTool('bookstack_recyclebin_delete_permanently', {
        id: entry.id,
      })) as { success: boolean };
      expect(result.success).toBe(true);

      await expect(findOwnEntry('page', page.id)).rejects.toThrow(/no entry for page/);
      expect((await apiFetchWithinBudget(harness, `/pages/${page.id}`)).status).toBe(404);
    }, 60_000);

    it('rejects a deletion id that does not exist', async () => {
      await expect(
        callTool('bookstack_recyclebin_delete_permanently', { id: 2_147_483_647 })
      ).rejects.toThrow();
    });
  });
});

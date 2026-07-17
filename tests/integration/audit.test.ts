/**
 * Integration tests for the audit-log MCP tool against a live BookStack.
 *
 * Tools covered here (1):
 *   - bookstack_audit_log_list
 *
 * SHARED-INSTANCE SAFETY. The audit log is append-only global state that every
 * other suite is writing to concurrently, so nothing here asserts on totals or on
 * "the most recent entry" being ours. Each test performs one action against a
 * uniquely-named entity of its own and then asserts only that *that* event is
 * present among the results, located by the entity's own id.
 *
 * Gating: skipped automatically when BookStack is not reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { AuditTools } from '../../src/tools/audit';
import type { AuditLogEntry, ListResponse, MCPTool } from '../../src/types';
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
    '[integration] BookStack unreachable and RUN_INTEGRATION unset - skipping audit tool suite.'
  );
}

/**
 * THE SHARED BUDGET. BookStack throttles the API per user over a 60s window, and
 * every integration suite on this instance authenticates as the same admin token —
 * so a *neighbouring* suite can exhaust the budget this one needs, and a 429 here
 * says nothing about the audit-log tool.
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
 * Every field a `GET /audit-log` row carries on BookStack v26 — no more, no less.
 *
 * `src/types.ts`'s `AuditLogEntry` now declares exactly these, so the suite types
 * responses as `AuditLogEntry` rather than a local stand-in. The interface once
 * declared `entity_type`/`entity_id`; the affected entity actually arrives as
 * `loggable_type`/`loggable_id`. The client casts the response with an unchecked
 * `as`, so asserting this key set is the only thing that would catch a re-drift.
 */
const AUDIT_ENTRY_FIELDS = [
  'created_at',
  'detail',
  'id',
  'ip',
  'loggable_id',
  'loggable_type',
  'type',
  'user',
  'user_id',
] as const;

/** The filters BookStack's AuditLogApiController genuinely applies. */
const SUPPORTED_FILTERS = [
  'date_from',
  'date_to',
  'loggable_id',
  'loggable_type',
  'type',
  'user_id',
] as const;

const unique = (prefix: string): string =>
  `itest-audit-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** BookStack compares filter dates in UTC; format as it stores them. */
const utcStamp = (date: Date): string => date.toISOString().slice(0, 19).replace('T', ' ');

describe.skipIf(!runIntegration)('audit-log tool (live BookStack)', () => {
  let harness: BookStackHarness;
  let tools: Map<string, MCPTool>;
  /**
   * Everything this suite created, so a mid-test failure still gets cleaned up - and so
   * teardown fails loudly rather than dropping an id whose delete BookStack refused.
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
    for (const tool of new AuditTools(client, validator, logger).getTools()) {
      tools.set(tool.name, tool);
    }
    // Generous: connecting may have to sit out a full rate-limit window first.
  }, 240_000);

  // Cleanup can have to sit out a rate-limit window, which overruns bun's 5s default
  // hook timeout - and a timed-out afterAll leaks fixtures. The tracker checks every
  // status, purges each book's own deletion row, re-reads the id, and throws if
  // anything survived rather than dropping it on an unread response.
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

  /** The `filter` object the tool's inputSchema advertises. */
  const advertisedFilters = (): Record<string, unknown> => {
    const filter = findTool('bookstack_audit_log_list').inputSchema.properties.filter as
      | { properties?: Record<string, unknown> }
      | undefined;
    const properties = filter?.properties;
    if (!properties) {
      throw new Error("bookstack_audit_log_list advertises no 'filter' properties");
    }
    return properties;
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

  const listLog = async (params: unknown): Promise<ListResponse<AuditLogEntry>> =>
    (await callTool('bookstack_audit_log_list', params)) as ListResponse<AuditLogEntry>;

  const createBook = async (name: string): Promise<BookStackBook> => {
    const res = await apiFetchWithinBudget(harness, '/books', {
      method: 'POST',
      body: JSON.stringify({ name, description: 'Fixture for the audit-log tool suite.' }),
    });
    expect(res.status).toBe(200);

    const book = await apiJson<BookStackBook>(res);
    cleanup.track('book', book.id);
    return book;
  };

  /**
   * Find OUR event for one specific book, using the filters BookStack really applies.
   *
   * `loggable_type` + `loggable_id` narrow the shared, concurrently-appended log to
   * a single entity's events, so no paging and no scanning is needed. This used to
   * walk the log page by page towards its end: the only sort the schema offered ran
   * *ascending*, which buried a just-written event on the last page.
   */
  const findOwnEvent = async (type: string, bookId: number): Promise<AuditLogEntry> => {
    const page = await listLog({
      count: 50,
      filter: { type, loggable_type: 'book', loggable_id: bookId },
    });

    const match = page.data[0];
    if (!match) {
      throw new Error(`No '${type}' audit entry for book ${bookId} - the action was never logged`);
    }
    return match;
  };

  describe('bookstack_audit_log_list', () => {
    it('registers exactly one audit tool', () => {
      expect([...tools.keys()]).toEqual(['bookstack_audit_log_list']);
    });

    it('returns a well-formed list envelope', async () => {
      // Shape only: the log is shared, concurrently-appended state.
      const result = await listLog({ count: 1 });

      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeLessThanOrEqual(1);
      expect(typeof result.total).toBe('number');
    });

    it('accepts the default parameters', async () => {
      const result = await listLog({});

      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeLessThanOrEqual(20);
    });

    it('returns rows carrying exactly the fields AuditLogEntry declares', async () => {
      const name = unique('shape');
      const book = await createBook(name);
      const entry = await findOwnEvent('book_create', book.id);

      expect(Object.keys(entry).sort()).toEqual([...AUDIT_ENTRY_FIELDS]);
      // `user` is a UserSummary, not a bare id.
      expect(Object.keys(entry.user).sort()).toEqual(['id', 'name', 'slug']);
    }, 60_000);

    it('records a book we just created', async () => {
      const name = unique('create');
      const book = await createBook(name);

      const entry = await findOwnEvent('book_create', book.id);

      expect(entry.type).toBe('book_create');
      expect(entry.detail).toContain(name);
      expect(entry.loggable_type).toBe('book');
      expect(entry.loggable_id).toBe(book.id);
      expect(entry.user_id).toBeGreaterThan(0);
      expect(entry.user.name.length).toBeGreaterThan(0);
      expect(entry.ip.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(entry.created_at))).toBe(false);
    }, 60_000);

    it('records an update and a delete of our own book', async () => {
      const name = unique('update');
      const book = await createBook(name);

      const renamed = `${name}-renamed`;
      const updateRes = await apiFetchWithinBudget(harness, `/books/${book.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: renamed }),
      });
      expect(updateRes.status).toBe(200);

      const updateEntry = await findOwnEvent('book_update', book.id);
      expect(updateEntry.detail).toContain(renamed);
      expect(updateEntry.loggable_id).toBe(book.id);

      const deleteRes = await apiFetchWithinBudget(harness, `/books/${book.id}`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(204);

      // A soft-deleted book still carries its loggable link; BookStack only nulls
      // loggable_type/loggable_id once the entity is purged for good, which is
      // exactly why AuditLogEntry declares both nullable.
      const deleteEntry = await findOwnEvent('book_delete', book.id);
      expect(deleteEntry.type).toBe('book_delete');
      expect(deleteEntry.detail).toContain(renamed);
      expect(deleteEntry.user_id).toBe(updateEntry.user_id);
    }, 90_000);
  });

  describe('sort order', () => {
    it('defaults to most recent first', async () => {
      // The tool's description promises "the most recent entries first", but it
      // sent `sort=created_at` - ascending - and returned the oldest rows in the
      // instance's history, the exact opposite of what an LLM asking "what just
      // happened?" needs. The default is now `-created_at`.
      const schema = findTool('bookstack_audit_log_list').inputSchema.properties.sort as {
        default?: string;
        enum?: readonly string[];
      };
      expect(schema.default).toBe('-created_at');
      expect(schema.enum).toContain('created_at');

      const result = await listLog({ count: 20 });
      expect(result.data.length).toBeGreaterThan(1);

      // Descending by time, and (ids being monotonically assigned) by id too.
      const times = result.data.map((e) => Date.parse(e.created_at));
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1]).toBeGreaterThanOrEqual(times[i] as number);
      }
      const ids = result.data.map((e) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
    });

    it('puts a just-written event on the first page by default', async () => {
      // The practical consequence of the fix. This instance's log holds thousands
      // of rows, so under the old ascending default even a page of 500 returned
      // the very oldest entries and a brand-new event was nowhere near it.
      const name = unique('recent');
      await createBook(name);

      const result = await listLog({ count: 500 });
      expect(result.data.some((e) => e.detail.includes(name))).toBe(true);
    }, 60_000);

    it('still sorts ascending when explicitly asked to', async () => {
      // The opposite direction is a legitimate request, not a bug - it just must
      // not be the default.
      const result = await listLog({ count: 20, sort: 'created_at' });

      const ids = result.data.map((e) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });
  });

  describe('filters', () => {
    it('advertises exactly the filters BookStack applies', () => {
      // `event`, `entity_type` and `entity_id` were advertised but silently dropped
      // upstream: filtering by `entity_type` returned the *entire* unfiltered log,
      // so a caller auditing one entity would read the whole instance's history as
      // that entity's. They are gone; the ones BookStack really supports are named
      // in their place.
      const properties = advertisedFilters();

      expect(Object.keys(properties).sort()).toEqual([...SUPPORTED_FILTERS]);
      for (const removed of ['event', 'entity_type', 'entity_id']) {
        expect(properties).not.toHaveProperty(removed);
      }
    });

    it('narrows the log to a single event type', async () => {
      const name = unique('filter');
      await createBook(name);

      const result = await listLog({ count: 50, filter: { type: 'book_create' } });

      expect(result.data.length).toBeGreaterThan(0);
      for (const entry of result.data) {
        expect(entry.type).toBe('book_create');
      }
    }, 60_000);

    it('narrows the log to a single acting user', async () => {
      const name = unique('user');
      const book = await createBook(name);

      const own = await findOwnEvent('book_create', book.id);

      const result = await listLog({ count: 50, filter: { user_id: own.user_id } });

      expect(result.data.length).toBeGreaterThan(0);
      for (const entry of result.data) {
        expect(entry.user_id).toBe(own.user_id);
      }
    }, 60_000);

    it('narrows the log to one entity by loggable_type and loggable_id', async () => {
      // Newly supported, and the only honest way to ask "what happened to this
      // book?": the entity_type/entity_id filters this replaces never filtered
      // anything at all.
      const name = unique('loggable');
      const book = await createBook(name);

      const result = await listLog({
        count: 50,
        filter: { loggable_type: 'book', loggable_id: book.id },
      });

      expect(result.data.length).toBeGreaterThan(0);
      for (const entry of result.data) {
        expect(entry.loggable_type).toBe('book');
        expect(entry.loggable_id).toBe(book.id);
        expect(entry.detail).toContain(name);
      }

      // It really narrowed: the unfiltered log holds far more than this book.
      const unfiltered = await listLog({ count: 1 });
      expect(unfiltered.total).toBeGreaterThan(result.total);
    }, 60_000);

    it('narrows the log to one type of entity', async () => {
      const name = unique('loggable-type');
      await createBook(name);

      const result = await listLog({ count: 50, filter: { loggable_type: 'book' } });

      expect(result.data.length).toBeGreaterThan(0);
      for (const entry of result.data) {
        expect(entry.loggable_type).toBe('book');
      }
    }, 60_000);

    it('honours date_from, mapping it onto created_at:gte', async () => {
      // `date_from`/`date_to` are the tool's own vocabulary; BookStack only
      // understands `created_at:gte`/`created_at:lte`. Unmapped, they were dropped
      // upstream and the "date range" silently matched everything.
      const since = new Date(Date.now() - 5_000);
      const name = unique('date-from');
      await createBook(name);

      const result = await listLog({ count: 500, filter: { date_from: utcStamp(since) } });

      // Our brand-new event is inside the window...
      expect(result.data.some((e) => e.detail.includes(name))).toBe(true);
      // ...and nothing older than the window leaked in.
      for (const entry of result.data) {
        expect(Date.parse(entry.created_at)).toBeGreaterThanOrEqual(since.getTime() - 1_000);
      }
      // It really narrowed: the instance's log predates this window.
      const unfiltered = await listLog({ count: 1 });
      expect(unfiltered.total).toBeGreaterThan(result.total);
    }, 60_000);

    it('honours date_to, mapping it onto created_at:lte', async () => {
      const name = unique('date-to');
      const book = await createBook(name);
      const own = await findOwnEvent('book_create', book.id);

      // A ceiling below our own event: it must be excluded, and every row returned
      // must sit at or under the ceiling.
      const ceiling = new Date(Date.parse(own.created_at) - 60_000);
      const result = await listLog({ count: 500, filter: { date_to: utcStamp(ceiling) } });

      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.some((e) => e.id === own.id)).toBe(false);
      for (const entry of result.data) {
        expect(Date.parse(entry.created_at)).toBeLessThanOrEqual(ceiling.getTime() + 1_000);
      }
    }, 60_000);

    it('honours date_from and date_to together as a window', async () => {
      const name = unique('window');
      const before = new Date(Date.now() - 5_000);
      const book = await createBook(name);
      const own = await findOwnEvent('book_create', book.id);
      const after = new Date(Date.parse(own.created_at) + 1_000);

      const result = await listLog({
        count: 500,
        filter: { date_from: utcStamp(before), date_to: utcStamp(after) },
      });

      expect(result.data.some((e) => e.id === own.id)).toBe(true);
      for (const entry of result.data) {
        const at = Date.parse(entry.created_at);
        expect(at).toBeGreaterThanOrEqual(before.getTime() - 1_000);
        expect(at).toBeLessThanOrEqual(after.getTime() + 1_000);
      }
    }, 60_000);

    it('combines a date range with an event type', async () => {
      const since = new Date(Date.now() - 5_000);
      const name = unique('combo');
      await createBook(name);

      const result = await listLog({
        count: 500,
        filter: { type: 'book_create', date_from: utcStamp(since) },
      });

      expect(result.data.some((e) => e.detail.includes(name))).toBe(true);
      for (const entry of result.data) {
        expect(entry.type).toBe('book_create');
        expect(Date.parse(entry.created_at)).toBeGreaterThanOrEqual(since.getTime() - 1_000);
      }
    }, 60_000);
  });

  describe('pagination', () => {
    it('honours pagination', async () => {
      const first = await listLog({ count: 2, offset: 0, filter: { type: 'book_create' } });
      const second = await listLog({ count: 2, offset: 1, filter: { type: 'book_create' } });

      // Enough book_create events exist (this suite alone writes several), so the
      // windows must overlap by exactly one entry - without asserting any total.
      expect(first.data.length).toBe(2);
      expect(second.data.length).toBeGreaterThan(0);
      expect(second.data[0]?.id).toBe(first.data[1]?.id);
    }, 30_000);
  });
});

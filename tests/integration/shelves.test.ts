/**
 * Integration tests for the 5 bookshelf MCP tools against a live BookStack.
 *
 * Unlike tests/unit/shelves-style suites, nothing here is mocked: the tools are
 * wired to a real BookStackClient, ValidationHandler and Logger, so a passing
 * run proves the whole path - JSON schema -> zod validation -> axios -> the
 * BookStack REST API - actually works.
 *
 * Isolation: this suite shares the instance with other suites running
 * concurrently, so every fixture carries a unique suffix and no assertion ever
 * touches a global count or claims a list is complete. Cleanup soft-deletes and
 * then purges only the entities this file created.
 *
 * Gating: skipped when BookStack is unreachable, so a plain `bun test` on a
 * machine with no Docker stays green. See shouldRunIntegration().
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { ShelfTools } from '../../src/tools/shelves';
import type { Book, Bookshelf, BookshelfWithBooks, ListResponse, MCPTool } from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  type BookStackHarness,
  CleanupTracker,
  ensureBookStack,
  purgeFromRecycleBin,
  shouldRunIntegration,
} from './helpers/bookstack';

const runIntegration = await shouldRunIntegration();

/** Distinguishes this run's fixtures from every other suite's. */
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A production-shaped Config pointed at the test instance.
 *
 * The rate limit is deliberately raised above the 60/min production default:
 * the limiter still runs, but the default would park this suite behind 1s token
 * waits without buying any extra coverage.
 */
function makeConfig(harness: BookStackHarness): Config {
  return {
    bookstack: { baseUrl: harness.baseUrl, apiToken: harness.token, timeout: 30_000 },
    server: { name: 'bookstack-mcp-itest', version: '1.0.0', port: 3000 },
    rateLimit: { requestsPerMinute: 600, burstLimit: 50 },
    validation: { enabled: true, strictMode: false },
    logging: { level: 'error', format: 'json' },
    development: { nodeEnv: 'test', debug: false },
  };
}

/**
 * MCPTool.handler resolves to `unknown` by design. Narrowing here (rather than
 * at every call site) keeps the assertion in one auditable place; tests still
 * assert on real field values, which is what would catch a wrong shape.
 */
async function callTool<T>(tool: MCPTool, params: unknown): Promise<T> {
  return (await tool.handler(params)) as T;
}

describe.skipIf(!runIntegration)('Shelf tools against live BookStack', () => {
  let harness: BookStackHarness;
  let client: BookStackClient;
  let tools: MCPTool[];

  // Books to hang on the shelf: shelves are containers, so the association is
  // only testable with real books behind it.
  let bookA: Book | undefined;
  let bookB: Book | undefined;
  // Tracked at module scope so cleanup still runs when an assertion fails.
  let shelfId: number | undefined;
  /**
   * Everything this suite created, so a mid-test failure still gets cleaned up - and so
   * teardown fails loudly rather than dropping an id whose delete BookStack refused.
   */
  const cleanup = new CleanupTracker();

  const shelfName = `itest-shelf-${SUFFIX}`;
  const renamedShelfName = `itest-shelf-renamed-${SUFFIX}`;

  const findTool = (name: string): MCPTool => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Expected tool ${name} to be registered`);
    return tool;
  };

  const requireShelfId = (): number => {
    if (shelfId === undefined) throw new Error('Shelf fixture was not created');
    return shelfId;
  };

  beforeAll(async () => {
    harness = await ensureBookStack();

    const logger = Logger.getInstance();
    client = new BookStackClient(makeConfig(harness), logger, new ErrorHandler(logger));
    const validator = new ValidationHandler({ enabled: true, strictMode: false });
    tools = new ShelfTools(client, validator, logger).getTools();

    bookA = await client.createBook({ name: `itest-shelf-book-a-${SUFFIX}` });
    cleanup.track('book', bookA.id);
    bookB = await client.createBook({ name: `itest-shelf-book-b-${SUFFIX}` });
    cleanup.track('book', bookB.id);
  }, 120_000);

  // DELETE is a soft delete; purge so repeat runs leave no residue. Only ever this
  // suite's own entities - other suites' fixtures share the recycle bin. Each
  // `.catch(() => {})` here suppressed nothing real (`fetch` resolves for 4xx/5xx)
  // while dropping the id regardless of what BookStack answered; the tracker checks
  // each status, re-reads each id and throws listing whatever survived.
  afterAll(async () => {
    if (!harness) return;
    await cleanup.run(harness);
  }, 60_000);

  it('registers the 5 shelf tools', () => {
    expect(tools).toHaveLength(5);

    const names = tools.map((tool) => tool.name);
    expect(names).toContain('bookstack_shelves_list');
    expect(names).toContain('bookstack_shelves_create');
    expect(names).toContain('bookstack_shelves_read');
    expect(names).toContain('bookstack_shelves_update');
    expect(names).toContain('bookstack_shelves_delete');
  });

  it('creates a shelf holding a book', async () => {
    const book = bookA;
    if (!book) throw new Error('Book fixture was not created');

    const created = await callTool<Bookshelf>(findTool('bookstack_shelves_create'), {
      name: shelfName,
      description: 'Created by the shelves integration suite.',
      tags: [{ name: 'itest', value: SUFFIX }],
      books: [book.id],
    });

    expect(typeof created.id).toBe('number');
    expect(created.name).toBe(shelfName);
    expect(created.slug).toContain('itest-shelf');
    expect(created.description).toBe('Created by the shelves integration suite.');

    shelfId = created.id;
    cleanup.track('bookshelf', shelfId);
  }, 30_000);

  it('reads the shelf back with its book association and tags', async () => {
    const book = bookA;
    if (!book) throw new Error('Book fixture was not created');

    const shelf = await callTool<BookshelfWithBooks>(findTool('bookstack_shelves_read'), {
      id: requireShelfId(),
    });

    expect(shelf.id).toBe(requireShelfId());
    expect(shelf.name).toBe(shelfName);

    // The book/shelf association round-trips.
    expect(Array.isArray(shelf.books)).toBe(true);
    expect(shelf.books.map((entry) => entry.id)).toContain(book.id);

    // `tags` is optional on the type (absent from list responses); a single read
    // carries it, and the value assertion below fails if it ever does not.
    const tag = shelf.tags?.find((candidate) => candidate.name === 'itest');
    expect(tag?.value).toBe(SUFFIX);
  }, 30_000);

  it('lists shelves and finds the shelf this suite created via the name filter', async () => {
    const body = await callTool<ListResponse<Bookshelf>>(findTool('bookstack_shelves_list'), {
      count: 100,
      filter: { name: shelfName },
    });

    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');

    // Presence, never completeness: other suites are creating shelves right now.
    const mine = body.data.find((shelf) => shelf.id === requireShelfId());
    expect(mine).toBeDefined();
    expect(mine?.name).toBe(shelfName);

    for (const shelf of body.data) {
      expect(typeof shelf.id).toBe('number');
      expect(typeof shelf.name).toBe('string');
      expect(typeof shelf.slug).toBe('string');
    }
  }, 30_000);

  it('applies list pagination and sorting defaults', async () => {
    const body = await callTool<ListResponse<Bookshelf>>(findTool('bookstack_shelves_list'), {
      count: 1,
      sort: 'created_at',
    });

    // Only the requested page size is assertable - the instance total is shared.
    expect(body.data.length).toBeLessThanOrEqual(1);
    expect(typeof body.total).toBe('number');
  }, 30_000);

  it('updates the shelf: renames it and replaces its books', async () => {
    const replacement = bookB;
    if (!replacement) throw new Error('Book fixture was not created');

    const updated = await callTool<Bookshelf>(findTool('bookstack_shelves_update'), {
      id: requireShelfId(),
      name: renamedShelfName,
      books: [replacement.id],
    });

    expect(updated.id).toBe(requireShelfId());
    expect(updated.name).toBe(renamedShelfName);

    // `books` replaces the whole set, per the tool's documented contract - and
    // this shelf is ours alone, so an exact assertion is safe here.
    const reread = await callTool<BookshelfWithBooks>(findTool('bookstack_shelves_read'), {
      id: requireShelfId(),
    });
    expect(reread.name).toBe(renamedShelfName);
    expect(reread.books.map((entry) => entry.id)).toEqual([replacement.id]);
  }, 30_000);

  it('rejects a read of a non-existent shelf', async () => {
    // Ids this high cannot collide with another suite's fixture.
    await expect(findTool('bookstack_shelves_read').handler({ id: 999_999_999 })).rejects.toThrow(
      'Requested resource not found'
    );
  }, 30_000);

  it('rejects an invalid shelf id before hitting the API', async () => {
    await expect(findTool('bookstack_shelves_read').handler({ id: 0 })).rejects.toThrow();
    await expect(findTool('bookstack_shelves_update').handler({ id: -5 })).rejects.toThrow();
  });

  it('deletes the shelf, leaving its books intact', async () => {
    const id = requireShelfId();
    const book = bookB;
    if (!book) throw new Error('Book fixture was not created');

    const result = await callTool<{ success: boolean; message: string }>(
      findTool('bookstack_shelves_delete'),
      { id }
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain(String(id));

    // Gone from the API...
    await expect(findTool('bookstack_shelves_read').handler({ id })).rejects.toThrow(
      'Requested resource not found'
    );

    // ...but the book it held is untouched, as the tool documents.
    const survivor = await client.getBook(book.id);
    expect(survivor.id).toBe(book.id);

    // Soft delete only: purge for real so repeat runs stay clean. `true` means a row was
    // found and destroyed; the helper throws rather than reporting `false` if the purge
    // itself fails, so this assertion cannot pass on a swallowed error.
    const purged = await purgeFromRecycleBin(harness, 'bookshelf', id);
    expect(purged).toBe(true);
    shelfId = undefined;
    // Left tracked on purpose: teardown re-reads the id and would fail if this purge
    // had not actually taken.
  }, 30_000);
});

/**
 * Integration tests for all 11 MCP resources against a live BookStack.
 *
 * Resources are the read-only half of the MCP surface (distinct from tools):
 * six classes under src/resources/ expose 11 URIs, five of them templated with
 * an `{id}`. This suite constructs every class with a real BookStackClient and
 * Logger, then drives each handler with a concrete URI and asserts on real data
 * returned by the live API.
 *
 * Isolation: the instance is shared with other suites running right now, so the
 * list resources (`bookstack://books` and friends return *everything*) are only
 * ever asserted for the presence of this suite's own fixtures and for shape -
 * never for totals or completeness. See expectListContains().
 *
 * Gating: skipped when BookStack is unreachable. See shouldRunIntegration().
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { BookResources } from '../../src/resources/books';
import { ChapterResources } from '../../src/resources/chapters';
import { PageResources } from '../../src/resources/pages';
import { SearchResources } from '../../src/resources/search';
import { ShelfResources } from '../../src/resources/shelves';
import { UserResources } from '../../src/resources/users';
import type {
  Book,
  BookshelfWithBooks,
  BookWithContents,
  Chapter,
  ChapterWithPages,
  ListResponse,
  MCPResource,
  Page,
  PageWithContent,
  SearchResult,
  User,
  UserWithRoles,
} from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import {
  type BookStackHarness,
  CleanupTracker,
  ensureBookStack,
  shouldRunIntegration,
} from './helpers/bookstack';

const runIntegration = await shouldRunIntegration();

/** Distinguishes this run's fixtures from every other suite's. */
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Unique enough that a search hit can only be this suite's page. */
const TOKEN = `zqxjires${Math.random()
  .toString(36)
  .slice(2, 10)
  .replace(/[^a-z]/g, 'q')}`;

/** The complete resource surface this suite must cover. */
const EXPECTED_URIS = [
  'bookstack://books',
  'bookstack://books/{id}',
  'bookstack://chapters',
  'bookstack://chapters/{id}',
  'bookstack://pages',
  'bookstack://pages/{id}',
  'bookstack://search/{query}',
  'bookstack://shelves',
  'bookstack://shelves/{id}',
  'bookstack://users',
  'bookstack://users/{id}',
];

function makeConfig(harness: BookStackHarness): Config {
  return {
    bookstack: { baseUrl: harness.baseUrl, apiToken: harness.token, timeout: 30_000 },
    server: { name: 'bookstack-mcp-itest', version: '1.0.0', port: 3000 },
    // Raised above the 60/min production default; the limiter still runs, but
    // the default would stall this suite behind token waits for no coverage.
    rateLimit: { requestsPerMinute: 600, burstLimit: 50 },
    validation: { enabled: true, strictMode: false },
    logging: { level: 'error', format: 'json' },
    development: { nodeEnv: 'test', debug: false },
  };
}

/** MCPResource.handler resolves to `unknown`; narrow in one auditable place. */
async function readResource<T>(resource: MCPResource, uri: string): Promise<T> {
  return (await resource.handler(uri)) as T;
}

describe.skipIf(!runIntegration)('MCP resources against live BookStack', () => {
  let harness: BookStackHarness;
  let client: BookStackClient;
  let resources: MCPResource[];

  let book: Book | undefined;
  let chapter: Chapter | undefined;
  let page: Page | undefined;
  let shelfId: number | undefined;
  /**
   * Everything this suite created, so a mid-test failure still gets cleaned up - and so
   * teardown fails loudly rather than dropping an id whose delete BookStack refused.
   */
  const cleanup = new CleanupTracker();

  const bookName = `itest-res-book-${SUFFIX}`;
  const chapterName = `itest-res-chapter-${SUFFIX}`;
  const pageName = `${TOKEN} resource fixture ${SUFFIX}`;
  const shelfName = `itest-res-shelf-${SUFFIX}`;

  const findResource = (uri: string): MCPResource => {
    const resource = resources.find((candidate) => candidate.uri === uri);
    if (!resource) throw new Error(`Expected resource ${uri} to be registered`);
    return resource;
  };

  const requireBook = (): Book => {
    if (!book) throw new Error('Book fixture was not created');
    return book;
  };
  const requireChapter = (): Chapter => {
    if (!chapter) throw new Error('Chapter fixture was not created');
    return chapter;
  };
  const requirePage = (): Page => {
    if (!page) throw new Error('Page fixture was not created');
    return page;
  };
  const requireShelfId = (): number => {
    if (shelfId === undefined) throw new Error('Shelf fixture was not created');
    return shelfId;
  };

  /**
   * Assert a list resource returned well-shaped data that includes `id`.
   *
   * The handlers take no pagination arguments, so they return page 1 of a
   * BookStack list. Presence is therefore only *guaranteed* when that page
   * holds the whole set - `data.length >= total`. On an instance where another
   * suite has pushed the entity past page 1, the shape assertions still run;
   * the alternative (asserting on `total`, or on our position in the list)
   * would be exactly the cross-suite coupling this file must avoid.
   */
  const expectListContains = <T extends { id: number; name: string }>(
    body: ListResponse<T>,
    id: number
  ): void => {
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.data.length).toBeGreaterThan(0);

    for (const entry of body.data) {
      expect(typeof entry.id).toBe('number');
      expect(typeof entry.name).toBe('string');
    }

    if (body.data.length >= body.total) {
      expect(body.data.some((entry) => entry.id === id)).toBe(true);
    }
  };

  beforeAll(async () => {
    harness = await ensureBookStack();

    const logger = Logger.getInstance();
    client = new BookStackClient(makeConfig(harness), logger, new ErrorHandler(logger));

    resources = [
      ...new BookResources(client, logger).getResources(),
      ...new ChapterResources(client, logger).getResources(),
      ...new PageResources(client, logger).getResources(),
      ...new SearchResources(client, logger).getResources(),
      ...new ShelfResources(client, logger).getResources(),
      ...new UserResources(client, logger).getResources(),
    ];

    book = await client.createBook({ name: bookName, description: 'Resource suite fixture.' });
    chapter = await client.createChapter({ book_id: book.id, name: chapterName });
    page = await client.createPage({
      chapter_id: chapter.id,
      name: pageName,
      html: `<p>Resource suite fixture body ${TOKEN}.</p>`,
    });
    cleanup.track('book', book.id);
    cleanup.track('chapter', chapter.id);
    cleanup.track('page', page.id);
    const shelf = await client.createShelf({ name: shelfName, books: [book.id] });
    shelfId = shelf.id;
    cleanup.track('bookshelf', shelfId);
  }, 120_000);

  // Soft delete then purge, innermost first, and only this suite's entities - the
  // tracker's own order does exactly that. Each `.catch(() => {})` here suppressed
  // nothing real (`fetch` resolves for 4xx/5xx) while dropping the id regardless of
  // what BookStack answered; `cleanup.run()` checks each status, re-reads each id and
  // throws listing whatever survived.
  afterAll(async () => {
    if (!harness) return;
    await cleanup.run(harness);
  }, 60_000);

  it('registers all 11 resources with declared metadata', () => {
    expect(resources).toHaveLength(EXPECTED_URIS.length);
    expect(resources.map((resource) => resource.uri).sort()).toEqual([...EXPECTED_URIS].sort());

    for (const resource of resources) {
      expect(typeof resource.name).toBe('string');
      expect(resource.mimeType).toBe('application/json');
      expect(typeof resource.handler).toBe('function');
    }
  });

  it('bookstack://books returns real books', async () => {
    const body = await readResource<ListResponse<Book>>(
      findResource('bookstack://books'),
      'bookstack://books'
    );

    expectListContains(body, requireBook().id);
  }, 30_000);

  it('bookstack://books/{id} returns the book with its contents hierarchy', async () => {
    const target = requireBook();
    const result = await readResource<BookWithContents>(
      findResource('bookstack://books/{id}'),
      `bookstack://books/${target.id}`
    );

    expect(result.id).toBe(target.id);
    expect(result.name).toBe(bookName);
    expect(Array.isArray(result.contents)).toBe(true);
    // The chapter fixture lives in this book, so the hierarchy must show it.
    expect(result.contents.some((entry) => entry.id === requireChapter().id)).toBe(true);
  }, 30_000);

  it('bookstack://chapters returns real chapters', async () => {
    const body = await readResource<ListResponse<Chapter>>(
      findResource('bookstack://chapters'),
      'bookstack://chapters'
    );

    expectListContains(body, requireChapter().id);
  }, 30_000);

  it('bookstack://chapters/{id} returns the chapter with its pages', async () => {
    const target = requireChapter();
    const result = await readResource<ChapterWithPages>(
      findResource('bookstack://chapters/{id}'),
      `bookstack://chapters/${target.id}`
    );

    expect(result.id).toBe(target.id);
    expect(result.name).toBe(chapterName);
    expect(result.book_id).toBe(requireBook().id);
    expect(result.pages.map((entry) => entry.id)).toContain(requirePage().id);
  }, 30_000);

  it('bookstack://pages returns real pages', async () => {
    const body = await readResource<ListResponse<Page>>(
      findResource('bookstack://pages'),
      'bookstack://pages'
    );

    expectListContains(body, requirePage().id);
  }, 30_000);

  it('bookstack://pages/{id} returns the page with its full content', async () => {
    const target = requirePage();
    const result = await readResource<PageWithContent>(
      findResource('bookstack://pages/{id}'),
      `bookstack://pages/${target.id}`
    );

    expect(result.id).toBe(target.id);
    expect(result.name).toBe(pageName);
    expect(result.chapter_id).toBe(requireChapter().id);
    // The full body, not a snippet: this is what distinguishes it from search.
    expect(result.html).toContain(TOKEN);
  }, 30_000);

  it('bookstack://shelves returns real shelves', async () => {
    const body = await readResource<ListResponse<BookshelfWithBooks>>(
      findResource('bookstack://shelves'),
      'bookstack://shelves'
    );

    expectListContains(body, requireShelfId());
  }, 30_000);

  it('bookstack://shelves/{id} returns the shelf with its books', async () => {
    const id = requireShelfId();
    const result = await readResource<BookshelfWithBooks>(
      findResource('bookstack://shelves/{id}'),
      `bookstack://shelves/${id}`
    );

    expect(result.id).toBe(id);
    expect(result.name).toBe(shelfName);
    expect(result.books.map((entry) => entry.id)).toContain(requireBook().id);
  }, 30_000);

  it('bookstack://users returns real users', async () => {
    const body = await readResource<ListResponse<User>>(
      findResource('bookstack://users'),
      'bookstack://users'
    );

    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(typeof body.total).toBe('number');

    for (const user of body.data) {
      expect(typeof user.id).toBe('number');
      expect(typeof user.name).toBe('string');
      expect(typeof user.email).toBe('string');
    }
  }, 30_000);

  it('bookstack://users/{id} returns a user with roles', async () => {
    // Read an existing user rather than creating one: this suite must not touch
    // the admin user, roles or any other global state.
    const list = await readResource<ListResponse<User>>(
      findResource('bookstack://users'),
      'bookstack://users'
    );
    const first = list.data[0];
    expect(first).toBeDefined();

    const result = await readResource<UserWithRoles>(
      findResource('bookstack://users/{id}'),
      `bookstack://users/${first.id}`
    );

    expect(result.id).toBe(first.id);
    expect(result.name).toBe(first.name);
    expect(Array.isArray(result.roles)).toBe(true);
  }, 30_000);

  it('bookstack://search/{query} returns results for the token this suite wrote', async () => {
    const resource = findResource('bookstack://search/{query}');
    const target = requirePage();
    const deadline = Date.now() + 30_000;
    let found: SearchResult | undefined;

    // Poll: search visibility depends on BookStack's index, not on the write.
    while (Date.now() < deadline && !found) {
      const body = await readResource<ListResponse<SearchResult>>(
        resource,
        `bookstack://search/${encodeURIComponent(TOKEN)}`
      );
      expect(Array.isArray(body.data)).toBe(true);
      found = body.data.find((entry) => entry.type === 'page' && entry.id === target.id);
      if (!found) await Bun.sleep(500);
    }

    if (!found) {
      throw new Error(
        `bookstack://search/${TOKEN} never returned page ${target.id} within 30000ms`
      );
    }
    expect(found.name).toBe(pageName);
  }, 60_000);

  it('rejects invalid resource URIs', async () => {
    const cases: [string, string, string][] = [
      ['bookstack://books/{id}', 'bookstack://books/notanumber', 'Invalid book resource URI'],
      ['bookstack://chapters/{id}', 'bookstack://chapters/abc', 'Invalid chapter resource URI'],
      ['bookstack://pages/{id}', 'bookstack://pages/12.5', 'Invalid page resource URI'],
      ['bookstack://shelves/{id}', 'bookstack://shelves/xyz', 'Invalid shelf resource URI'],
      ['bookstack://users/{id}', 'bookstack://users/me', 'Invalid user resource URI'],
      ['bookstack://search/{query}', 'bookstack://search/', 'Invalid search resource URI'],
    ];

    for (const [template, uri, message] of cases) {
      await expect(findResource(template).handler(uri)).rejects.toThrow(message);
    }
  });
});

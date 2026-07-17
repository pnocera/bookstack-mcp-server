/**
 * Integration tests for the `bookstack_search` MCP tool against a live BookStack.
 *
 * Two design choices are load-bearing:
 *
 *  1. Every assertion targets content THIS suite created, tagged with a token
 *     (`zqxjitest…`) unique to the run. Other suites are writing to the same
 *     instance concurrently, so a query like "test" would be polluted by their
 *     fixtures; a unique token makes the expected result set exactly ours.
 *  2. Search visibility is polled, not slept on. BookStack maintains its search
 *     index on save, but that is an implementation detail we refuse to bake in:
 *     waitForSearchHit() retries under a bounded deadline, so the suite is
 *     correct whether indexing is synchronous or eventually consistent - and
 *     reports which it observed rather than weakening the assertion.
 *
 * Gating: skipped when BookStack is unreachable. See shouldRunIntegration().
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { SearchTools } from '../../src/tools/search';
import type { Book, ListResponse, MCPTool, Page, SearchResult } from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  type BookStackHarness,
  CleanupTracker,
  ensureBookStack,
  shouldRunIntegration,
} from './helpers/bookstack';

const runIntegration = await shouldRunIntegration();

/** Distinguishes this run's fixtures from every other suite's. */
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A token no other content can plausibly contain, so a hit proves *our* page
 * was indexed. Letters only: it must survive BookStack's term tokenizer intact.
 */
const TOKEN = `zqxjitest${Math.random()
  .toString(36)
  .slice(2, 10)
  .replace(/[^a-z]/g, 'q')}`;
/** A second token that appears ONLY in the page body, never in its title. */
const BODY_TOKEN = `${TOKEN}body`;

/** How long a freshly created page may take to become findable. */
const INDEX_TIMEOUT_MS = 30_000;
const INDEX_POLL_MS = 500;

function makeConfig(harness: BookStackHarness): Config {
  return {
    bookstack: { baseUrl: harness.baseUrl, apiToken: harness.token, timeout: 30_000 },
    server: { name: 'bookstack-mcp-itest', version: '1.0.0', port: 3000 },
    // Raised above the 60/min production default: polling would otherwise spend
    // its whole budget waiting on rate-limit tokens rather than on indexing.
    rateLimit: { requestsPerMinute: 600, burstLimit: 50 },
    validation: { enabled: true, strictMode: false },
    logging: { level: 'error', format: 'json' },
    development: { nodeEnv: 'test', debug: false },
  };
}

/** MCPTool.handler resolves to `unknown`; narrow in one auditable place. */
async function callTool<T>(tool: MCPTool, params: unknown): Promise<T> {
  return (await tool.handler(params)) as T;
}

interface SearchHit {
  /** The matching result. */
  result: SearchResult;
  /** The full response the hit came from, for shape assertions. */
  body: ListResponse<SearchResult>;
  /** 1 means the very first query already saw it (synchronous indexing). */
  attempts: number;
  elapsedMs: number;
}

describe.skipIf(!runIntegration)('Search tool against live BookStack', () => {
  let harness: BookStackHarness;
  let client: BookStackClient;
  let searchTool: MCPTool;
  /** A second instance whose validator throws instead of warning. */
  let strictSearchTool: MCPTool;

  let book: Book | undefined;
  let page: Page | undefined;
  /**
   * Everything this suite created, so a mid-test failure still gets cleaned up - and so
   * teardown fails loudly rather than dropping an id whose delete BookStack refused.
   */
  const cleanup = new CleanupTracker();

  const bookName = `itest-search-book-${TOKEN}`;
  const pageName = `${TOKEN} search fixture ${SUFFIX}`;

  const getTool = (tools: MCPTool[]): MCPTool => {
    const tool = tools.find((candidate) => candidate.name === 'bookstack_search');
    if (!tool) throw new Error('Expected bookstack_search to be registered');
    return tool;
  };

  const requirePage = (): Page => {
    if (!page) throw new Error('Page fixture was not created');
    return page;
  };

  /**
   * Query until `predicate` matches or the deadline passes.
   *
   * Retrying (rather than sleeping a fixed amount) is what keeps this both fast
   * when the index is synchronous and honest when it is not: a failure here
   * means the content never became findable, which is a real result worth
   * reporting - not something to paper over with a looser assertion.
   */
  const waitForSearchHit = async (
    query: string,
    predicate: (result: SearchResult) => boolean,
    timeoutMs = INDEX_TIMEOUT_MS
  ): Promise<SearchHit> => {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let attempts = 0;
    let lastBody: ListResponse<SearchResult> = { data: [], total: 0 };

    while (Date.now() < deadline) {
      attempts++;
      lastBody = await callTool<ListResponse<SearchResult>>(searchTool, { query, count: 100 });
      const result = lastBody.data.find(predicate);
      if (result) {
        return { result, body: lastBody, attempts, elapsedMs: Date.now() - started };
      }
      await Bun.sleep(INDEX_POLL_MS);
    }

    throw new Error(
      `Search never returned a match for ${JSON.stringify(query)} within ${timeoutMs}ms ` +
        `(${attempts} attempts). Last response held ${lastBody.data.length} result(s): ` +
        `${JSON.stringify(lastBody.data.map((entry) => `${entry.type}:${entry.id}:${entry.name}`))}`
    );
  };

  beforeAll(async () => {
    harness = await ensureBookStack();

    const logger = Logger.getInstance();
    client = new BookStackClient(makeConfig(harness), logger, new ErrorHandler(logger));

    searchTool = getTool(
      new SearchTools(
        client,
        new ValidationHandler({ enabled: true, strictMode: false }),
        logger
      ).getTools()
    );
    strictSearchTool = getTool(
      new SearchTools(
        client,
        new ValidationHandler({ enabled: true, strictMode: true }),
        logger
      ).getTools()
    );

    book = await client.createBook({ name: bookName });
    cleanup.track('book', book.id);
    page = await client.createPage({
      book_id: book.id,
      name: pageName,
      html: `<p>Integration search fixture. Body marker ${BODY_TOKEN} lives only here.</p>`,
      tags: [{ name: 'itest', value: TOKEN, order: 0 }],
    });
    cleanup.track('page', page.id);
  }, 120_000);

  // Soft delete, purge the suite's own deletion rows, then re-read each id to confirm.
  // The `.catch(() => {})` this replaces could only fire on a network error - `fetch`
  // resolves for 4xx/5xx - so a refused delete used to drop its id and report nothing.
  afterAll(async () => {
    if (!harness) return;
    await cleanup.run(harness);
  }, 60_000);

  it('registers exactly one search tool', () => {
    const tools = new SearchTools(
      client,
      new ValidationHandler({ enabled: true, strictMode: false }),
      Logger.getInstance()
    ).getTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('bookstack_search');
  });

  it('finds a freshly created page by a unique token in its title', async () => {
    const target = requirePage();
    const hit = await waitForSearchHit(
      TOKEN,
      (result) => result.type === 'page' && result.id === target.id
    );

    console.log(
      `[search] title token indexed after ${hit.attempts} attempt(s) / ${hit.elapsedMs}ms ` +
        `(1 attempt == synchronous indexing)`
    );

    expect(hit.result.name).toBe(pageName);
    expect(hit.result.type).toBe('page');
    expect(typeof hit.result.url).toBe('string');
    expect(typeof hit.result.slug).toBe('string');
    expect(typeof hit.body.total).toBe('number');
  }, 60_000);

  it('finds the page by a token that exists only in its body', async () => {
    const target = requirePage();
    const hit = await waitForSearchHit(
      BODY_TOKEN,
      (result) => result.type === 'page' && result.id === target.id
    );

    console.log(
      `[search] body token indexed after ${hit.attempts} attempt(s) / ${hit.elapsedMs}ms`
    );

    // The body token is in no title, so this can only be a content-index match.
    expect(hit.result.name).toBe(pageName);
    expect(hit.result.preview_html).toBeDefined();
  }, 60_000);

  it('honours the {type:page} filter', async () => {
    const target = requirePage();
    const body = await callTool<ListResponse<SearchResult>>(searchTool, {
      query: `${TOKEN} {type:page}`,
      count: 100,
    });

    expect(body.data.some((result) => result.id === target.id)).toBe(true);
    // The token is unique to this suite, so every hit here is one of ours -
    // making an all-results assertion safe despite the shared instance.
    for (const result of body.data) {
      expect(result.type).toBe('page');
    }
  }, 60_000);

  it('honours the {type:book} filter', async () => {
    const target = book;
    if (!target) throw new Error('Book fixture was not created');

    const hit = await waitForSearchHit(
      `${TOKEN} {type:book}`,
      (result) => result.type === 'book' && result.id === target.id
    );

    expect(hit.result.name).toBe(bookName);
    for (const result of hit.body.data) {
      expect(result.type).toBe('book');
    }
  }, 60_000);

  /**
   * BookStack's tag syntax is `[name=value]`. The `{tag:name=value}` form this suite
   * once used does not exist - and BookStack silently DROPS an unknown `{filter:...}`
   * term rather than erroring, degrading the query to match-all. A test using it found
   * its target among *everything* and would have passed even if tag search were
   * completely broken. Hence the negative control: a filter that matches nothing must
   * return nothing, which is only true if the filter is actually applied.
   */
  it('honours tag search syntax', async () => {
    const target = requirePage();
    const hit = await waitForSearchHit(
      `[itest=${TOKEN}]`,
      (result) => result.type === 'page' && result.id === target.id
    );

    expect(hit.result.tags.some((tag) => tag.name === 'itest' && tag.value === TOKEN)).toBe(true);

    const miss = await callTool<ListResponse<SearchResult>>(searchTool, {
      query: `[itest=no-such-value-${TOKEN}]`,
    });

    expect(miss.total).toBe(0);
    expect(miss.data).toHaveLength(0);
  }, 60_000);

  it('paginates results', async () => {
    const body = await callTool<ListResponse<SearchResult>>(searchTool, {
      query: TOKEN,
      count: 1,
      page: 1,
    });

    expect(body.data.length).toBeLessThanOrEqual(1);
    expect(typeof body.total).toBe('number');
  }, 30_000);

  it('returns an empty result set for a token that matches nothing', async () => {
    const body = await callTool<ListResponse<SearchResult>>(searchTool, {
      query: `${TOKEN}neverwritten`,
    });

    expect(body.data).toEqual([]);
  }, 30_000);

  it('rejects an empty query when validation is strict', async () => {
    await expect(strictSearchTool.handler({ query: '' })).rejects.toThrow();
  });
});

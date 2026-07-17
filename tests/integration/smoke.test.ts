/**
 * Smoke integration test: proves the harness can provision a token and drive
 * the real BookStack REST API end to end.
 *
 * This talks to the API directly via `fetch` and deliberately imports nothing
 * from `src/` — it validates the *harness and the live stack*, so it stays
 * meaningful while the server code is being refactored. Later suites can layer
 * src-level tests on top of the same helpers.
 *
 * Gating: skipped automatically when BookStack is not reachable, so a plain
 * `bun test` with no Docker stays green. See shouldRunIntegration().
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  apiFetch,
  apiJson,
  type BookStackBook,
  type BookStackHarness,
  type BookStackList,
  CleanupTracker,
  ensureBookStack,
  purgeFromRecycleBin,
  shouldRunIntegration,
} from './helpers/bookstack';

// Resolved once, at collection time: bun supports top-level await in tests,
// which lets us feed an async probe into describe.skipIf.
const runIntegration = await shouldRunIntegration();

if (!runIntegration) {
  console.log(
    '[integration] BookStack unreachable and RUN_INTEGRATION unset - skipping integration suite.\n' +
      '[integration] To run it: docker compose up -d db bookstack && RUN_INTEGRATION=1 bun test tests/integration'
  );
}

// describe.skipIf(true) skips; we want to skip when integration is NOT enabled.
describe.skipIf(!runIntegration)('BookStack integration smoke', () => {
  let harness: BookStackHarness;
  /**
   * Tracked so cleanup still runs if an assertion fails mid-test - and so teardown
   * fails loudly rather than dropping an id whose delete BookStack refused.
   */
  const cleanup = new CleanupTracker();

  // Safety net: soft-delete, purge, then re-read to confirm. Generous timeout because a
  // throttled window can outlast bun's 5s default - and a timed-out hook leaks fixtures.
  afterAll(async () => {
    if (!harness) return;
    await cleanup.run(harness);
  }, 120_000);

  it('provisions a working API token', async () => {
    harness = await ensureBookStack();

    expect(harness.baseUrl).toMatch(/\/api$/);
    expect(harness.token).toContain(':');
  }, 120_000);

  it('is idempotent - re-running provisioning reuses the same token', async () => {
    const again = await ensureBookStack();

    expect(again.token).toBe(harness.token);
    expect(again.baseUrl).toBe(harness.baseUrl);
  }, 120_000);

  it('GET /books returns 200 with a JSON payload', async () => {
    const res = await apiFetch(harness, '/books');

    expect(res.status).toBe(200);

    const body = await apiJson<BookStackList<BookStackBook>>(res);
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body).toHaveProperty('total');
  });

  it('rejects a bad token with 401', async () => {
    const res = await fetch(`${harness.baseUrl}/books`, {
      headers: { Authorization: 'Token bogus:credentials' },
    });

    expect(res.status).toBe(401);
  });

  it('creates, reads and deletes a book', async () => {
    const name = `mcp-integration-smoke-${Date.now()}`;

    // Create
    const createRes = await apiFetch(harness, '/books', {
      method: 'POST',
      body: JSON.stringify({ name, description: 'Created by the MCP integration smoke test.' }),
    });
    expect(createRes.status).toBe(200);

    const created = await apiJson<BookStackBook>(createRes);
    expect(created.name).toBe(name);
    expect(typeof created.id).toBe('number');
    cleanup.track('book', created.id);

    // Read back
    const readRes = await apiFetch(harness, `/books/${created.id}`);
    expect(readRes.status).toBe(200);

    const read = await apiJson<BookStackBook>(readRes);
    expect(read.id).toBe(created.id);
    expect(read.name).toBe(name);

    // Delete (soft: moves to the recycle bin)
    const deleteRes = await apiFetch(harness, `/books/${created.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(204);

    // Gone from the books listing
    const goneRes = await apiFetch(harness, `/books/${created.id}`);
    expect(goneRes.status).toBe(404);

    // Purge for real, so repeat runs don't silently fill the recycle bin. `true` means a
    // row was found and destroyed; the helper throws rather than reporting `false` if the
    // purge itself fails, so this assertion cannot pass on a swallowed error.
    const purged = await purgeFromRecycleBin(harness, 'book', created.id);
    expect(purged).toBe(true);
    // Left tracked on purpose: teardown re-reads the id and would fail if this purge
    // had not actually taken.
  }, 30_000);
});

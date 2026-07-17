/**
 * Integration tests for the five user MCP tools, driven against a live BookStack.
 *
 * Unlike tests/unit/books.test.ts - which mocks every collaborator - this suite wires up
 * the *real* BookStackClient, ValidationHandler and Logger and calls each tool's
 * `handler()`. A passing test therefore exercises the whole path: tool handler -> zod
 * validation -> axios -> BookStack -> response.
 *
 * Isolation: other suites run against this same instance with the same admin token, so
 * every entity here is created by this file, carries a unique suffix, and is located by
 * id. Nothing asserts on global counts or list completeness, and the admin user / Admin
 * role are never touched.
 *
 * Delete semantics (verified in `deletes for real`): unlike books, users do NOT pass
 * through the recycle bin - `DELETE /users/{id}` is a hard delete - so cleanup here is a
 * plain delete with no purge step. The one book this suite creates (to prove ownership
 * migration) *does* soft-delete, so it is purged explicitly.
 *
 * Gating: skipped automatically when BookStack is not reachable, so a plain `bun test`
 * with no Docker stays green. See shouldRunIntegration().
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { UserTools } from '../../src/tools/users';
import type { MCPTool, RoleReference, UserListItem, UserRef, UserWithRoles } from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  apiFetch,
  apiJson,
  type BookStackHarness,
  type BookStackList,
  CleanupTracker,
  ensureBookStack,
  type RecycleBinEntry,
  shouldRunIntegration,
} from './helpers/bookstack';

const runIntegration = await shouldRunIntegration();

/**
 * Live payloads recorded verbatim from v26.05.2, checked against the exported types at
 * compile time.
 *
 * These suites used to declare their own response interfaces, which let the exported
 * client types stay wrong while every test passed green. The types are the contract this
 * server publishes, so they are what the tests assert against now - and `satisfies` pins
 * them to reality from both sides: a field BookStack sends that the type does not declare
 * is an excess-property error, and a field the type requires that BookStack does not send
 * is a missing-property error. The key-set assertions in
 * `returns exactly the fields ... declare` check the same contract at runtime, so the
 * type, the fixture and the live payload cannot drift apart quietly.
 */
const LIVE_ROLE_REFERENCE = {
  id: 304,
  display_name: 'itest-users-fixture-role',
} satisfies RoleReference;

/** `POST`/`GET`/`PUT` on /api/users all return this shape - `roles`, no `last_activity_at`. */
const LIVE_USER_WITH_ROLES = {
  id: 289,
  name: 'itest-user',
  slug: 'itest-user',
  email: 'itest-user@example.test',
  external_auth_id: '',
  created_at: '2026-07-16T12:26:10.000000Z',
  updated_at: '2026-07-16T12:26:10.000000Z',
  profile_url: 'http://localhost:6875/user/itest-user',
  edit_url: 'http://localhost:6875/settings/users/289',
  avatar_url: 'http://localhost:6875/uploads/images/user/2026-07/thumbs-50-50/x-avatar.png',
  roles: [LIVE_ROLE_REFERENCE],
} satisfies UserWithRoles;

/** `GET /api/users` is the mirror image: `last_activity_at`, and no `roles`. */
const LIVE_USER_LIST_ITEM = {
  id: 289,
  name: 'itest-user',
  slug: 'itest-user',
  email: 'itest-user@example.test',
  external_auth_id: '',
  created_at: '2026-07-16T12:26:10.000000Z',
  updated_at: '2026-07-16T12:26:10.000000Z',
  profile_url: 'http://localhost:6875/user/itest-user',
  edit_url: 'http://localhost:6875/settings/users/289',
  avatar_url: 'http://localhost:6875/uploads/images/user/2026-07/thumbs-50-50/x-avatar.png',
  last_activity_at: null,
} satisfies UserListItem;

/** The only part of a book this suite reads: who owns it. */
interface OwnedBook {
  id: number;
  owned_by: UserRef;
}

/** What the delete tool resolves to (it synthesises this; BookStack returns 204). */
interface DeleteResult {
  success: boolean;
  message: string;
}

/** Password used for every throwaway account (zod requires >= 8 chars). */
const PASSWORD = 'itestPassword123';

/**
 * Backstop for an HTTP 429 from BookStack's API throttle.
 *
 * Two things make this a formality rather than the load-bearing workaround it once was:
 * this instance's limit is raised well above the stock 180/min, and `client.request()`
 * now retries a 429 itself (any verb, honouring Retry-After, 4 attempts / 30s). What is
 * left uncovered is the *raw* fixture calls below, which bypass the client entirely - so
 * a small budget stays, and it fires only on an explicit 429, never on a real failure.
 */
const THROTTLE_ATTEMPTS = 6;
const THROTTLE_DELAY_MS = 2000;

/** Unique-per-run identifier, so concurrent suites and repeat runs never collide. */
function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Is this the shared instance throttling us, rather than a genuine tool failure? */
function isThrottled(error: unknown): boolean {
  return error instanceof Error && /Rate limit exceeded/.test(error.message);
}

/**
 * Narrow a tool result to `T`.
 *
 * Tool handlers are typed `Promise<unknown>`, so every assertion needs narrowing. Like
 * the harness's apiJson(), `as T` is an assertion rather than validation - what this adds
 * is a clear failure when a handler resolves to something that is not an object at all,
 * instead of a baffling property access on `undefined` further down. The field-value
 * assertions in each test are what catch a genuinely wrong shape.
 */
function narrow<T>(value: unknown, label: string): T {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${label}: expected an object from the tool, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

/**
 * The id behind an `owned_by` / `created_by` reference.
 *
 * BookStack renders these two ways for the same entity - a bare id in list responses, an
 * expanded {id,name,slug} on a single read - which is exactly what src/types' `UserRef`
 * models. Both are handled so a caller never has to care which one it got.
 */
function ownerId(ref: UserRef): number {
  return typeof ref === 'number' ? ref : ref.id;
}

describe.skipIf(!runIntegration)('BookStack user tools (live)', () => {
  let harness: BookStackHarness;
  let tools: MCPTool[];
  /** A throwaway role to assign, so these tests never depend on the seeded roles. */
  let fixtureRoleId: number;

  // Tracked so cleanup still runs if an assertion fails mid-test. The tracker orders the
  // teardown (users before roles, books purged from the bin), checks every response and
  // fails afterAll if anything survives, rather than dropping ids on an unread status.
  const cleanup = new CleanupTracker();

  const findTool = (name: string): MCPTool => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool;
  };

  /** The advertised property names of a tool's inputSchema - i.e. its public contract. */
  const advertisedParams = (name: string): string[] =>
    Object.keys(findTool(name).inputSchema.properties);

  /** Invoke a tool by name. Only an explicit 429 is retried; every other error propagates. */
  const callTool = async (name: string, params: Record<string, unknown>): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await findTool(name).handler(params);
      } catch (error) {
        if (!isThrottled(error) || attempt >= THROTTLE_ATTEMPTS) throw error;
        await Bun.sleep(THROTTLE_DELAY_MS);
      }
    }
  };

  /** Raw API call for fixtures/verification, with the same throttle tolerance. */
  const rawFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const res = await apiFetch(harness, path, init);
      if (res.status !== 429 || attempt >= THROTTLE_ATTEMPTS) return res;
      await Bun.sleep(THROTTLE_DELAY_MS);
    }
  };

  const createUser = async (params: Record<string, unknown>): Promise<UserWithRoles> => {
    const created = narrow<UserWithRoles>(
      await callTool('bookstack_users_create', params),
      'bookstack_users_create'
    );
    cleanup.track('user', created.id);
    return created;
  };

  beforeAll(async () => {
    harness = await ensureBookStack();

    const config: Config = {
      bookstack: { baseUrl: harness.baseUrl, apiToken: harness.token, timeout: 30_000 },
      server: { name: 'bookstack-mcp-server', version: '1.0.0', port: 3000 },
      // Deliberately modest: every suite here authenticates as the same admin, so a client
      // that never self-throttles would eat the shared budget and 429 everybody else.
      rateLimit: { requestsPerMinute: 120, burstLimit: 20 },
      // The shipped defaults (VALIDATION_STRICT_MODE unset => strict), so these tests
      // see exactly what a deployed server does with the same input.
      validation: { enabled: true, strictMode: true },
      logging: { level: 'info', format: 'pretty' },
      development: { nodeEnv: 'test', debug: false },
    };

    const logger = Logger.getInstance();
    const client = new BookStackClient(config, logger, new ErrorHandler(logger));
    tools = new UserTools(client, new ValidationHandler(config.validation), logger).getTools();

    // Created through the raw API on purpose: this file tests the *user* tools, so the
    // role it assigns is a fixture rather than a second tool under test.
    const roleRes = await rawFetch('/roles', {
      method: 'POST',
      body: JSON.stringify({ display_name: unique('itest-users-fixture-role') }),
    });
    expect(roleRes.status).toBe(200);
    const role = await apiJson<{ id: number }>(roleRes);
    fixtureRoleId = role.id;
    cleanup.track('role', fixtureRoleId);
  }, 180_000);

  // Safety net: remove anything a failed test left behind, and say so if it cannot.
  //
  // Users and roles are hard deletes; a book soft-deletes, so its recycle-bin entry is
  // purged by id - the shared bin itself is never emptied. Every id used to be dropped on
  // an unread `fetch` status behind a `.catch(() => {})` that could only ever fire on a
  // network error, so a delete BookStack refused left residue and reported nothing.
  afterAll(async () => {
    if (!harness) return;
    await cleanup.run(harness);
  }, 180_000);

  it('exposes the five user tools', () => {
    expect(tools).toHaveLength(5);
    expect(tools.map((tool) => tool.name)).toEqual([
      'bookstack_users_list',
      'bookstack_users_create',
      'bookstack_users_read',
      'bookstack_users_update',
      'bookstack_users_delete',
    ]);
  });

  /**
   * The exported types are the contract, so they get asserted rather than paraphrased.
   *
   * This suite used to declare its own `ApiUser`, whose comment recorded that
   * `UserWithRoles.roles` was wrong in src - a bug the tests then worked around instead
   * of failing on. With the workaround gone, a src type that stops matching BookStack
   * breaks the build (the `LIVE_*` fixtures above) or this test, not neither.
   *
   * `roles` vs `last_activity_at` is the whole distinction between the two user types:
   * `singleFormatter()` adds `roles` and no listing scope, `list()` does the opposite.
   * Asserting the exact key set is what keeps a field from quietly appearing on the
   * wrong one.
   */
  it('returns exactly the fields UserWithRoles and UserListItem declare, and no others', async () => {
    const name = unique('itest-user-shape');
    const email = `${name}@example.test`;
    const created = await createUser({ name, email, password: PASSWORD, roles: [fixtureRoleId] });

    // Single-user reads: `roles`, and no `last_activity_at` to read back.
    expect(Object.keys(created).sort()).toEqual(Object.keys(LIVE_USER_WITH_ROLES).sort());
    expect(created).not.toHaveProperty('last_activity_at');

    const read = narrow<UserWithRoles>(
      await callTool('bookstack_users_read', { id: created.id }),
      'bookstack_users_read'
    );
    expect(Object.keys(read).sort()).toEqual(Object.keys(LIVE_USER_WITH_ROLES).sort());

    // BookStack embeds a role reference, not a full role: {id, display_name} only.
    const roleRef: RoleReference = read.roles[0] as RoleReference;
    expect(Object.keys(roleRef).sort()).toEqual(Object.keys(LIVE_ROLE_REFERENCE).sort());
    expect(roleRef.id).toBe(fixtureRoleId);
    expect(typeof roleRef.display_name).toBe('string');

    // The listing is the mirror image: `last_activity_at`, and no `roles`.
    const listed = narrow<BookStackList<UserListItem>>(
      await callTool('bookstack_users_list', { filter: { email } }),
      'bookstack_users_list'
    );
    const entry = listed.data.find((user) => user.id === created.id);
    expect(entry).toBeDefined();
    expect(Object.keys(entry as UserListItem).sort()).toEqual(
      Object.keys(LIVE_USER_LIST_ITEM).sort()
    );
    expect(entry).not.toHaveProperty('roles');
    // Never active, so null - which is why the type is `string | null`.
    expect((entry as UserListItem).last_activity_at).toBeNull();
  }, 180_000);

  it('creates, reads, lists, updates and deletes a user', async () => {
    const name = unique('itest-user');
    const email = `${name}@example.test`;

    // --- create -------------------------------------------------------------------
    const created = await createUser({ name, email, password: PASSWORD, roles: [fixtureRoleId] });

    expect(typeof created.id).toBe('number');
    expect(created.name).toBe(name);
    expect(created.email).toBe(email);
    expect(created.slug).toBe(name);
    expect(created.roles.map((role) => role.id)).toEqual([fixtureRoleId]);

    // --- read ---------------------------------------------------------------------
    const read = narrow<UserWithRoles>(
      await callTool('bookstack_users_read', { id: created.id }),
      'bookstack_users_read'
    );

    expect(read.id).toBe(created.id);
    expect(read.name).toBe(name);
    expect(read.email).toBe(email);
    expect(read.roles.map((role) => role.id)).toEqual([fixtureRoleId]);

    // --- list ---------------------------------------------------------------------
    // Located by our own unique email: other suites are creating users concurrently, so
    // presence is the only safe assertion - never a count or the whole listing.
    const filtered = narrow<BookStackList<UserListItem>>(
      await callTool('bookstack_users_list', { filter: { email } }),
      'bookstack_users_list'
    );

    expect(filtered.data.map((user) => user.id)).toContain(created.id);
    expect(filtered.data.find((user) => user.id === created.id)?.email).toBe(email);

    // The `count` cap is honoured (proves list params reach BookStack).
    const capped = narrow<BookStackList<UserListItem>>(
      await callTool('bookstack_users_list', { count: 1, offset: 0, sort: 'email' }),
      'bookstack_users_list'
    );

    expect(capped.data.length).toBeLessThanOrEqual(1);
    expect(capped.total).toBeGreaterThanOrEqual(1);

    // --- update -------------------------------------------------------------------
    const renamed = `${name}-renamed`;
    const updated = narrow<UserWithRoles>(
      await callTool('bookstack_users_update', {
        id: created.id,
        name: renamed,
        email: `${renamed}@example.test`,
        roles: [],
      }),
      'bookstack_users_update'
    );

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe(renamed);
    expect(updated.email).toBe(`${renamed}@example.test`);
    expect(updated.roles).toEqual([]);

    // The change is persisted, not just echoed back.
    const reread = narrow<UserWithRoles>(
      await callTool('bookstack_users_read', { id: created.id }),
      'bookstack_users_read'
    );

    expect(reread.name).toBe(renamed);
    expect(reread.email).toBe(`${renamed}@example.test`);
    expect(reread.roles).toEqual([]);

    // --- delete -------------------------------------------------------------------
    const deleted = narrow<DeleteResult>(
      await callTool('bookstack_users_delete', { id: created.id }),
      'bookstack_users_delete'
    );

    expect(deleted).toEqual({ success: true, message: `User ${created.id} deleted successfully` });

    await expect(callTool('bookstack_users_read', { id: created.id })).rejects.toThrow(
      /Requested resource not found/
    );
  }, 180_000);

  it('deletes for real - a deleted user does not land in the recycle bin', async () => {
    const name = unique('itest-user-purge');
    const created = await createUser({ name, email: `${name}@example.test`, password: PASSWORD });

    await callTool('bookstack_users_delete', { id: created.id });

    // Books soft-delete into the recycle bin; users do not. Scoped to our own id on
    // purpose - the bin holds other suites' entries and must never be emptied.
    const bin = await apiJson<BookStackList<RecycleBinEntry>>(
      await rawFetch('/recycle-bin?count=500')
    );
    const ours = bin.data.filter(
      (entry) => entry.deletable_type === 'user' && entry.deletable_id === created.id
    );

    expect(ours).toEqual([]);
  }, 180_000);

  /**
   * `migrate_ownership_id` is real, and this proves it end to end rather than settling
   * for "the call returned 200": a book is parked on the leaver, the leaver is deleted
   * with the heir named, and the book must come out owned by the heir. Without the
   * parameter BookStack would hand the content to the deleting admin instead, so an
   * ownership check is the only thing that can tell the two apart.
   */
  it('deletes a user with migrate_ownership_id, moving their content to the heir', async () => {
    // Ownership is migrated to a second throwaway user, never to admin: this suite must
    // not be able to disturb the shared admin account even if it goes wrong.
    const leaverName = unique('itest-user-leaver');
    const heirName = unique('itest-user-heir');
    const leaver = await createUser({
      name: leaverName,
      email: `${leaverName}@example.test`,
      password: PASSWORD,
    });
    const heir = await createUser({
      name: heirName,
      email: `${heirName}@example.test`,
      password: PASSWORD,
    });

    // A book to inherit. Raw API: the content tools are not under test here.
    const bookRes = await rawFetch('/books', {
      method: 'POST',
      body: JSON.stringify({ name: unique('itest-user-legacy-book') }),
    });
    expect(bookRes.status).toBe(200);
    const book = await apiJson<{ id: number }>(bookRes);
    cleanup.track('book', book.id);

    // Park it on the leaver - `owner_id` is settable only through content-permissions.
    const ownRes = await rawFetch(`/content-permissions/book/${book.id}`, {
      method: 'PUT',
      body: JSON.stringify({ owner_id: leaver.id }),
    });
    expect(ownRes.status).toBe(200);

    const beforeBook = await apiJson<OwnedBook>(await rawFetch(`/books/${book.id}`));
    expect(ownerId(beforeBook.owned_by)).toBe(leaver.id);

    const deleted = narrow<DeleteResult>(
      await callTool('bookstack_users_delete', {
        id: leaver.id,
        migrate_ownership_id: heir.id,
      }),
      'bookstack_users_delete'
    );

    expect(deleted.success).toBe(true);

    // The point of the parameter: the content really moved to the named heir.
    const afterBook = await apiJson<OwnedBook>(await rawFetch(`/books/${book.id}`));
    expect(ownerId(afterBook.owned_by)).toBe(heir.id);

    // The leaver is gone; the heir survives untouched.
    await expect(callTool('bookstack_users_read', { id: leaver.id })).rejects.toThrow(
      /Requested resource not found/
    );
    const survivor = narrow<UserWithRoles>(
      await callTool('bookstack_users_read', { id: heir.id }),
      'bookstack_users_read'
    );

    expect(survivor.id).toBe(heir.id);
    expect(survivor.name).toBe(heirName);
  }, 180_000);

  it('surfaces a missing user as a not-found error', async () => {
    await expect(callTool('bookstack_users_read', { id: 999_999_999 })).rejects.toThrow(
      /Requested resource not found/
    );
  }, 180_000);

  it('rejects an id that is not a positive integer before any request is made', async () => {
    // validateId() parses through zod, which throws a raw ZodError - it is not mapped to
    // an McpError the way an API failure is.
    const failure = await callTool('bookstack_users_read', { id: 0 }).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('ZodError');
  }, 180_000);

  it('rejects a duplicate email', async () => {
    const name = unique('itest-user-dup');
    const email = `${name}@example.test`;
    await createUser({ name, email, password: PASSWORD });

    // BookStack's `unique:users,email` rule -> 422 -> McpError(InvalidParams).
    await expect(
      callTool('bookstack_users_create', { name: `${name}-second`, email, password: PASSWORD })
    ).rejects.toThrow(/Validation failed/);
  }, 180_000);

  /**
   * `external_auth_id` is advertised by both tools and reaches BookStack from both: the
   * value round-trips instead of being stripped by zod on the way out.
   */
  it('round-trips external_auth_id through create and update', async () => {
    const name = unique('itest-user-ext');
    const externalId = `ext-${name}`;
    const created = await createUser({
      name,
      email: `${name}@example.test`,
      password: PASSWORD,
      external_auth_id: externalId,
    });

    expect(created.external_auth_id).toBe(externalId);

    // Persisted, not just echoed back by the create response.
    const read = narrow<UserWithRoles>(
      await callTool('bookstack_users_read', { id: created.id }),
      'bookstack_users_read'
    );

    expect(read.external_auth_id).toBe(externalId);

    // And the update tool can change it.
    const changed = `${externalId}-updated`;
    const updated = narrow<UserWithRoles>(
      await callTool('bookstack_users_update', { id: created.id, external_auth_id: changed }),
      'bookstack_users_update'
    );

    expect(updated.external_auth_id).toBe(changed);

    const reread = narrow<UserWithRoles>(
      await callTool('bookstack_users_read', { id: created.id }),
      'bookstack_users_read'
    );

    expect(reread.external_auth_id).toBe(changed);
  }, 180_000);

  /**
   * There is no `active` flag anywhere in the user contract, because BookStack has no
   * such concept: users-update declares no `active` param and the `users` table has no
   * `active` column. Nothing advertises it, and the payload never carries it - so this
   * asserts both halves, then proves the offboarding path the tool actually recommends.
   */
  it('advertises no `active` flag, and revokes access by stripping roles instead', async () => {
    // Not in either tool's contract...
    expect(advertisedParams('bookstack_users_update')).not.toContain('active');
    expect(advertisedParams('bookstack_users_create')).not.toContain('active');

    // ...nor in any example, which once told callers to "deactivate" with {active: false}.
    const updateExamples = findTool('bookstack_users_update').examples ?? [];
    expect(updateExamples.length).toBeGreaterThan(0);
    expect(updateExamples.some((example) => 'active' in example.input)).toBe(false);

    // ...nor among the filters, where `filter.active` was equally fictional.
    const listFilter = narrow<{ properties: Record<string, unknown> }>(
      findTool('bookstack_users_list').inputSchema.properties.filter,
      'bookstack_users_list filter schema'
    );

    expect(Object.keys(listFilter.properties)).toEqual(['name', 'email']);

    // The documented replacement: strip the roles, and the account keeps none.
    const name = unique('itest-user-offboard');
    const created = await createUser({
      name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roles: [fixtureRoleId],
    });

    expect(created.roles.map((role) => role.id)).toEqual([fixtureRoleId]);

    const stripped = narrow<UserWithRoles>(
      await callTool('bookstack_users_update', { id: created.id, roles: [] }),
      'bookstack_users_update'
    );

    expect(stripped.roles).toEqual([]);

    const read = narrow<UserWithRoles>(
      await callTool('bookstack_users_read', { id: created.id }),
      'bookstack_users_read'
    );

    expect(read.roles).toEqual([]);
    // The live payload has no `active` field to read or set, in either direction.
    expect(read).not.toHaveProperty('active');
  }, 180_000);
});

/**
 * Integration tests for the five role MCP tools, driven against a live BookStack.
 *
 * Unlike tests/unit/books.test.ts - which mocks every collaborator - this suite wires up
 * the *real* BookStackClient, ValidationHandler and Logger and calls each tool's
 * `handler()`. A passing test therefore exercises the whole path: tool handler -> zod
 * validation -> axios -> BookStack -> response.
 *
 * Isolation: other suites run against this same instance with the same admin token, so
 * every entity here is created by this file, carries a unique suffix, and is located by
 * id. Nothing asserts on global counts or list completeness, and the Admin role (and its
 * permissions) is never touched - breaking it would lock every suite out of the API.
 *
 * Delete semantics (verified in `deletes for real`): unlike books, roles do NOT pass
 * through the recycle bin - `DELETE /roles/{id}` is a hard delete - so cleanup here is a
 * plain delete with no purge step.
 *
 * Gating: skipped automatically when BookStack is not reachable, so a plain `bun test`
 * with no Docker stays green. See shouldRunIntegration().
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { RoleTools } from '../../src/tools/roles';
import type {
  MCPTool,
  RoleCreateResult,
  RoleListItem,
  RoleWithPermissions,
  UserSummary,
} from '../../src/types';
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
 * This suite used to declare its own `ApiRole`, which let the exported role types stay
 * wrong while every test passed green. The types are the contract this server publishes,
 * so they are what the tests assert against now - and `satisfies` pins them to reality
 * from both sides: a field BookStack sends that the type does not declare is an
 * excess-property error, and a field the type requires that BookStack does not send is a
 * missing-property error. The key-set assertions in `returns exactly the fields ...
 * declare` check the same contract at runtime.
 *
 * The three shapes are genuinely different, which is the point of having three types.
 */
const LIVE_USER_SUMMARY = {
  id: 289,
  name: 'itest-roles-fixture-user',
  slug: 'itest-roles-fixture-user',
} satisfies UserSummary;

/** `GET`/`PUT` on /api/roles/{id}: the settled row, plus `permissions` and `users`. */
const LIVE_ROLE_WITH_PERMISSIONS = {
  id: 304,
  display_name: 'itest-role',
  description: null,
  created_at: '2026-07-16T12:26:09.000000Z',
  updated_at: '2026-07-16T12:26:09.000000Z',
  system_name: '',
  external_auth_id: '',
  mfa_enforced: false,
  permissions: [],
  users: [],
} satisfies RoleWithPermissions;

/** `GET /api/roles`: counts instead of the relations - how many, not which. */
const LIVE_ROLE_LIST_ITEM = {
  id: 304,
  display_name: 'itest-role',
  description: null,
  created_at: '2026-07-16T12:26:09.000000Z',
  updated_at: '2026-07-16T12:26:09.000000Z',
  system_name: '',
  external_auth_id: '',
  mfa_enforced: false,
  users_count: 0,
  permissions_count: 0,
} satisfies RoleListItem;

/**
 * `POST /api/roles` with only a `display_name`: the freshly saved model carries just the
 * attributes that were actually assigned, so `description`, `external_auth_id` and
 * `system_name` are all absent - unlike the read above, which has all three.
 */
const LIVE_ROLE_CREATE_BARE = {
  id: 304,
  display_name: 'itest-role',
  mfa_enforced: false,
  created_at: '2026-07-16T12:26:09.000000Z',
  updated_at: '2026-07-16T12:26:09.000000Z',
  permissions: [],
  users: [],
} satisfies RoleCreateResult;

/** The same create with `description`/`external_auth_id` supplied: both echo back. */
const LIVE_ROLE_CREATE_FULL = {
  id: 305,
  display_name: 'itest-role-full',
  description: 'probe desc',
  external_auth_id: 'probe-ext',
  mfa_enforced: false,
  created_at: '2026-07-16T12:26:09.000000Z',
  updated_at: '2026-07-16T12:26:09.000000Z',
  permissions: [],
  users: [],
} satisfies RoleCreateResult;

/** What the delete tool resolves to (it synthesises this; BookStack returns 204). */
interface DeleteResult {
  success: boolean;
  message: string;
}

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

/** BookStack's cap on a role description (`description => ['string', 'max:180']`). */
const DESCRIPTION_MAX = 180;

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

describe.skipIf(!runIntegration)('BookStack role tools (live)', () => {
  let harness: BookStackHarness;
  let tools: MCPTool[];

  // Tracked so cleanup still runs if an assertion fails mid-test. The tracker
  // deletes users before roles, checks each response instead of assuming it, and
  // fails afterAll if anything survives - this suite's `itest-role-filter-other`
  // fixture is the one Codex found still on the live instance after a green run.
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

  /** A named property's advertised JSON-schema fragment. */
  const advertisedProperty = <T>(name: string, property: string): T =>
    narrow<T>(findTool(name).inputSchema.properties[property], `${name}.${property} schema`);

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

  const createRole = async (params: Record<string, unknown>): Promise<RoleCreateResult> => {
    const created = narrow<RoleCreateResult>(
      await callTool('bookstack_roles_create', params),
      'bookstack_roles_create'
    );
    cleanup.track('role', created.id);
    return created;
  };

  /** A throwaway user, created through the raw API - the user tools are not under test here. */
  const createUserFixture = async (roleIds: number[]): Promise<number> => {
    const name = unique('itest-roles-fixture-user');
    const res = await rawFetch('/users', {
      method: 'POST',
      body: JSON.stringify({
        name,
        email: `${name}@example.test`,
        password: 'itestPassword123',
        roles: roleIds,
      }),
    });
    expect(res.status).toBe(200);
    const user = await apiJson<{ id: number }>(res);
    cleanup.track('user', user.id);
    return user.id;
  };

  const readUserFixture = async (id: number): Promise<{ roles: { id: number }[] }> => {
    const res = await rawFetch(`/users/${id}`);
    expect(res.status).toBe(200);
    return await apiJson<{ roles: { id: number }[] }>(res);
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
    tools = new RoleTools(client, new ValidationHandler(config.validation), logger).getTools();
  }, 180_000);

  // Safety net: remove anything a failed test left behind, and say so if it cannot.
  //
  // This loop used to be `rawFetch(...).catch(() => {})` per id. `fetch` resolves for
  // 4xx/5xx, so the `.catch` suppressed nothing real while a refused delete read exactly
  // like an honoured one - which is how `itest-role-filter-other-...` (role 117) survived
  // an all-green run. `cleanup.run()` checks each status, re-reads each id, and throws.
  afterAll(async () => {
    if (!harness) return;
    await cleanup.run(harness);
  }, 180_000);

  it('exposes the five role tools', () => {
    expect(tools).toHaveLength(5);
    expect(tools.map((tool) => tool.name)).toEqual([
      'bookstack_roles_list',
      'bookstack_roles_create',
      'bookstack_roles_read',
      'bookstack_roles_update',
      'bookstack_roles_delete',
    ]);
  });

  /**
   * The exported types are the contract, so they get asserted rather than paraphrased.
   *
   * BookStack serves three genuinely different role shapes, which is why src declares
   * three types. Create is the surprising one: it responds with the freshly saved model,
   * so a field that was never assigned is simply absent - `system_name` always, and
   * `description`/`external_auth_id` unless they were supplied. Reading the same role a
   * moment later returns all three. A single "role" interface cannot express that, and
   * the `ApiRole` this suite used to declare papered over it.
   */
  it('returns exactly the fields RoleCreateResult, RoleWithPermissions and RoleListItem declare', async () => {
    // --- create, bare: only what was actually assigned comes back ------------------
    const bare = await createRole({ display_name: unique('itest-role-shape-bare') });

    expect(Object.keys(bare).sort()).toEqual(Object.keys(LIVE_ROLE_CREATE_BARE).sort());
    expect(bare).not.toHaveProperty('system_name');
    expect(bare).not.toHaveProperty('description');
    expect(bare).not.toHaveProperty('external_auth_id');

    // --- create, with both optionals: they echo back, system_name still does not ---
    const fullName = unique('itest-role-shape-full');
    const full = await createRole({
      display_name: fullName,
      description: 'Shape check.',
      external_auth_id: `ext-${fullName}`,
    });

    expect(Object.keys(full).sort()).toEqual(Object.keys(LIVE_ROLE_CREATE_FULL).sort());
    expect(full.description).toBe('Shape check.');
    expect(full.external_auth_id).toBe(`ext-${fullName}`);
    // Create never reports it, however the role was made.
    expect(full).not.toHaveProperty('system_name');

    // --- read: the settled shape, with all three present --------------------------
    const read = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_read', { id: bare.id }),
      'bookstack_roles_read'
    );

    expect(Object.keys(read).sort()).toEqual(Object.keys(LIVE_ROLE_WITH_PERMISSIONS).sort());
    // The same role that just omitted them reads back with all three settled.
    expect(read.system_name).toBe('');
    expect(read.description).toBeNull();
    expect(read.external_auth_id).toBe('');

    // --- list: counts instead of the relations ------------------------------------
    const listed = narrow<BookStackList<RoleListItem>>(
      await callTool('bookstack_roles_list', { count: 500 }),
      'bookstack_roles_list'
    );
    const entry = listed.data.find((role) => role.id === bare.id);
    expect(entry).toBeDefined();
    expect(Object.keys(entry as RoleListItem).sort()).toEqual(
      Object.keys(LIVE_ROLE_LIST_ITEM).sort()
    );
    expect(entry).not.toHaveProperty('permissions');
    expect(entry).not.toHaveProperty('users');
    expect((entry as RoleListItem).users_count).toBe(0);
    expect((entry as RoleListItem).permissions_count).toBe(0);
  }, 180_000);

  it('creates, reads, lists, updates and deletes a role', async () => {
    const displayName = unique('itest-role');

    // --- create -------------------------------------------------------------------
    const created = await createRole({
      display_name: displayName,
      description: 'Created by the users/roles integration suite.',
      mfa_enforced: true,
      external_auth_id: `ext-${displayName}`,
      permissions: ['content-export', 'restrictions-manage-own'],
    });

    expect(typeof created.id).toBe('number');
    expect(created.display_name).toBe(displayName);
    expect(created.description).toBe('Created by the users/roles integration suite.');
    expect(created.mfa_enforced).toBe(true);
    expect(created.external_auth_id).toBe(`ext-${displayName}`);
    expect(created.permissions).toEqual(['content-export', 'restrictions-manage-own']);

    // --- read ---------------------------------------------------------------------
    const read = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_read', { id: created.id }),
      'bookstack_roles_read'
    );

    expect(read.id).toBe(created.id);
    expect(read.display_name).toBe(displayName);
    expect(read.mfa_enforced).toBe(true);
    expect(read.permissions).toEqual(['content-export', 'restrictions-manage-own']);
    // A brand-new role is a plain (non-system) role with nobody assigned.
    expect(read.system_name).toBe('');
    expect(read.users).toEqual([]);

    // --- list ---------------------------------------------------------------------
    // Located by our own id: other suites create roles concurrently, so presence is the
    // only safe assertion - never a count or the whole listing.
    const listed = narrow<BookStackList<RoleListItem>>(
      await callTool('bookstack_roles_list', { count: 500 }),
      'bookstack_roles_list'
    );

    expect(listed.data.map((role) => role.id)).toContain(created.id);
    expect(listed.data.find((role) => role.id === created.id)?.display_name).toBe(displayName);

    // --- update -------------------------------------------------------------------
    const renamed = `${displayName}-renamed`;
    const updated = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_update', {
        id: created.id,
        display_name: renamed,
        description: 'Updated by the integration suite.',
        mfa_enforced: false,
      }),
      'bookstack_roles_update'
    );

    expect(updated.id).toBe(created.id);
    expect(updated.display_name).toBe(renamed);
    expect(updated.description).toBe('Updated by the integration suite.');
    expect(updated.mfa_enforced).toBe(false);
    // Permissions were not part of the update, so they survive untouched.
    expect(updated.permissions).toEqual(['content-export', 'restrictions-manage-own']);

    // The change is persisted, not just echoed back.
    const reread = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_read', { id: created.id }),
      'bookstack_roles_read'
    );

    expect(reread.display_name).toBe(renamed);
    expect(reread.description).toBe('Updated by the integration suite.');
    expect(reread.mfa_enforced).toBe(false);

    // --- delete -------------------------------------------------------------------
    const deleted = narrow<DeleteResult>(
      await callTool('bookstack_roles_delete', { id: created.id }),
      'bookstack_roles_delete'
    );

    expect(deleted).toEqual({ success: true, message: `Role ${created.id} deleted successfully` });

    await expect(callTool('bookstack_roles_read', { id: created.id })).rejects.toThrow(
      /Requested resource not found/
    );
  }, 180_000);

  /**
   * `permissions` is advertised as an array of permission-name strings, which is exactly
   * what BookStack takes (`permissions => ['array'], permissions.* => ['string']`). The
   * advertised shape is therefore the working shape - asserted here from both ends: the
   * contract says array-of-string, and the array round-trips through the live API.
   */
  it('advertises permissions as the string array BookStack accepts', async () => {
    for (const tool of ['bookstack_roles_create', 'bookstack_roles_update']) {
      const permissions = advertisedProperty<{ type: string; items: { type: string } }>(
        tool,
        'permissions'
      );

      expect(permissions.type).toBe('array');
      expect(permissions.items.type).toBe('string');
    }

    // The create tool's example is runnable rather than illustrative: it passes an array.
    const example = findTool('bookstack_roles_create').examples?.[0];
    expect(Array.isArray(example?.input.permissions)).toBe(true);

    // And the advertised shape works end to end.
    const created = await createRole({
      display_name: unique('itest-role-permshape'),
      permissions: ['content-export'],
    });

    expect(created.permissions).toEqual(['content-export']);

    // The object-of-booleans shape the schema once advertised is simply invalid input.
    // Strict mode is the shipped default, so zod's array rule rejects it at our
    // boundary and the request never reaches BookStack. Kept as a guard that the
    // array stays the only accepted shape.
    await expect(
      callTool('bookstack_roles_create', {
        display_name: unique('itest-role-objperm'),
        permissions: { 'content-export': true },
      })
    ).rejects.toThrow(/expected array/);
  }, 180_000);

  it('assigns, replaces and clears permissions', async () => {
    const created = await createRole({
      display_name: unique('itest-role-perms'),
      permissions: ['content-export', 'restrictions-manage-own'],
    });

    // Replace: the array is authoritative, so the permission left out is revoked.
    const replaced = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_update', {
        id: created.id,
        permissions: ['restrictions-manage-own'],
      }),
      'bookstack_roles_update'
    );

    expect(replaced.permissions).toEqual(['restrictions-manage-own']);

    // Grant a different one, and confirm it round-trips through a read.
    await callTool('bookstack_roles_update', {
      id: created.id,
      permissions: ['content-export', 'users-manage'],
    });
    const granted = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_read', { id: created.id }),
      'bookstack_roles_read'
    );

    expect(granted.permissions).toContain('content-export');
    expect(granted.permissions).toContain('users-manage');
    expect(granted.permissions).not.toContain('restrictions-manage-own');

    // An empty array clears every granted permission (BookStack's documented behaviour).
    const cleared = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_update', { id: created.id, permissions: [] }),
      'bookstack_roles_update'
    );

    expect(cleared.permissions).toEqual([]);

    const reread = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_read', { id: created.id }),
      'bookstack_roles_read'
    );

    expect(reread.permissions).toEqual([]);
  }, 180_000);

  it('lists the users assigned to a role', async () => {
    const created = await createRole({ display_name: unique('itest-role-users') });
    const userId = await createUserFixture([created.id]);

    const read = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_read', { id: created.id }),
      'bookstack_roles_read'
    );

    expect(read.users.map((user) => user.id)).toEqual([userId]);
    // `users` holds a {id,name,slug} summary - never a full user payload.
    expect(Object.keys(read.users[0] as UserSummary).sort()).toEqual(
      Object.keys(LIVE_USER_SUMMARY).sort()
    );
  }, 180_000);

  it('deletes for real - a deleted role does not land in the recycle bin', async () => {
    const created = await createRole({ display_name: unique('itest-role-purge') });

    await callTool('bookstack_roles_delete', { id: created.id });

    // Books soft-delete into the recycle bin; roles do not. Scoped to our own id on
    // purpose - the bin holds other suites' entries and must never be emptied.
    const bin = await apiJson<BookStackList<RecycleBinEntry>>(
      await rawFetch('/recycle-bin?count=500')
    );
    const ours = bin.data.filter(
      (entry) => entry.deletable_type === 'role' && entry.deletable_id === created.id
    );

    expect(ours).toEqual([]);
  }, 180_000);

  it('surfaces a missing role as a not-found error', async () => {
    await expect(callTool('bookstack_roles_read', { id: 999_999_999 })).rejects.toThrow(
      /Requested resource not found/
    );
  }, 180_000);

  it('rejects an id that is not a positive integer before any request is made', async () => {
    // validateId() parses through zod, which throws a raw ZodError - it is not mapped to
    // an McpError the way an API failure is.
    const failure = await callTool('bookstack_roles_read', { id: 0 }).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('ZodError');
  }, 180_000);

  /**
   * The advertised `filter` reaches BookStack and really filters.
   *
   * Presence-based on purpose: other suites create roles concurrently, so the honest
   * question is not "how many came back" but "did the filter keep mine and drop a role I
   * know exists". A sibling role created in the same test supplies that second half - it
   * is what tells real filtering apart from an unfiltered listing that merely happens to
   * contain our role.
   */
  it('filters the role listing by display_name and external_auth_id', async () => {
    const wantedName = unique('itest-role-filter-wanted');
    const otherName = unique('itest-role-filter-other');
    const wanted = await createRole({
      display_name: wantedName,
      external_auth_id: `eid-${wantedName}`,
    });
    const other = await createRole({
      display_name: otherName,
      external_auth_id: `eid-${otherName}`,
    });

    // Exact match on a name only this run can have produced -> ours, and only ours.
    const byName = narrow<BookStackList<RoleListItem>>(
      await callTool('bookstack_roles_list', {
        count: 500,
        filter: { display_name: wantedName },
      }),
      'bookstack_roles_list'
    );

    expect(byName.data.map((role) => role.id)).toEqual([wanted.id]);
    // The sibling exists and is excluded: the filter was applied, not dropped.
    expect(byName.data.map((role) => role.id)).not.toContain(other.id);

    const byExternalId = narrow<BookStackList<RoleListItem>>(
      await callTool('bookstack_roles_list', {
        count: 500,
        filter: { external_auth_id: `eid-${wantedName}` },
      }),
      'bookstack_roles_list'
    );

    expect(byExternalId.data.map((role) => role.id)).toEqual([wanted.id]);
    expect(byExternalId.data.map((role) => role.id)).not.toContain(other.id);

    // An unfiltered listing is what proves the two calls above differ: both roles show up.
    const unfiltered = narrow<BookStackList<RoleListItem>>(
      await callTool('bookstack_roles_list', { count: 500 }),
      'bookstack_roles_list'
    );

    expect(unfiltered.data.map((role) => role.id)).toContain(wanted.id);
    expect(unfiltered.data.map((role) => role.id)).toContain(other.id);
  }, 180_000);

  /**
   * `system_name` is not a field BookStack exposes on roles, so it can be neither
   * filtered nor sorted on - a live `filter[system_name]=admin` comes back unfiltered.
   * The contract no longer offers it in either place, which is what this pins.
   */
  it('offers no system_name filter or sort, which BookStack would ignore', () => {
    const filter = advertisedProperty<{ properties: Record<string, unknown> }>(
      'bookstack_roles_list',
      'filter'
    );

    expect(Object.keys(filter.properties)).not.toContain('system_name');

    const sort = advertisedProperty<{ enum: string[] }>('bookstack_roles_list', 'sort');

    expect(sort.enum).not.toContain('system_name');
    expect(sort.enum).not.toContain('-system_name');
  });

  /**
   * Deleting a role strips it from its users, with no way to move them elsewhere:
   * BookStack's roles-delete route takes no request body at all. The tool no longer
   * advertises a `migrate_ownership_id` it could never honour, and its description says
   * plainly what does happen - which is exactly what this asserts, contract and live.
   *
   * (`bookstack_users_delete` is the opposite case: there the parameter is real and is
   * honoured - see the users suite, which proves the content actually moves.)
   */
  it('deletes a role without any migrate option, leaving its users role-less', async () => {
    expect(advertisedParams('bookstack_roles_delete')).toEqual(['id']);

    const doomed = await createRole({ display_name: unique('itest-role-doomed') });
    const userId = await createUserFixture([doomed.id]);

    expect((await readUserFixture(userId)).roles.map((role) => role.id)).toEqual([doomed.id]);

    const deleted = narrow<DeleteResult>(
      await callTool('bookstack_roles_delete', { id: doomed.id }),
      'bookstack_roles_delete'
    );

    expect(deleted.success).toBe(true);

    // As documented: the users simply lose the role rather than inheriting another.
    expect((await readUserFixture(userId)).roles).toEqual([]);
  }, 180_000);

  /**
   * The advertised `description` limit is BookStack's real one (`max:180`), so 180 is
   * accepted and 181 is not. Both ends are asserted: a limit that only ever rejects
   * would pass just as well if it were wrong in the strict direction.
   */
  it('advertises the description limit BookStack actually enforces (180)', async () => {
    for (const tool of ['bookstack_roles_create', 'bookstack_roles_update']) {
      const description = advertisedProperty<{ maxLength: number }>(tool, 'description');

      expect(description.maxLength).toBe(DESCRIPTION_MAX);
    }

    // Exactly at the limit: accepted, and stored whole.
    const atLimit = 'x'.repeat(DESCRIPTION_MAX);
    const created = await createRole({
      display_name: unique('itest-role-desc180'),
      description: atLimit,
    });

    expect(created.description).toBe(atLimit);
    expect(created.description?.length).toBe(DESCRIPTION_MAX);

    // One character over: rejected rather than silently truncated. Strict mode is the
    // shipped default, so zod rejects at our boundary before BookStack is called.
    await expect(
      callTool('bookstack_roles_create', {
        display_name: unique('itest-role-desc181'),
        description: 'x'.repeat(DESCRIPTION_MAX + 1),
      })
    ).rejects.toThrow(/<=180 characters/);

    // The same limit holds on update - the role keeps its valid description.
    await expect(
      callTool('bookstack_roles_update', {
        id: created.id,
        description: 'x'.repeat(DESCRIPTION_MAX + 1),
      })
    ).rejects.toThrow(/<=180 characters/);

    const reread = narrow<RoleWithPermissions>(
      await callTool('bookstack_roles_read', { id: created.id }),
      'bookstack_roles_read'
    );

    expect(reread.description).toBe(atLimit);
  }, 180_000);
});

/**
 * Integration tests for the content-permission MCP tools against a live BookStack.
 *
 * Tools covered here (2):
 *   - bookstack_permissions_read
 *   - bookstack_permissions_update
 *
 * SHARED-INSTANCE SAFETY. Permissions are the one area where a careless test can
 * lock every other suite out of the instance, so:
 *
 *   - Every write targets a book/chapter this suite created seconds earlier and
 *     deletes at the end. Nothing pre-existing is ever touched.
 *   - The Admin role, the admin user and the API token are never modified. Content
 *     permissions are a property of the *content*, not of the role, so granting a
 *     role access to our throwaway book leaves the role itself untouched.
 *   - Grantee roles are resolved by system_name, never by id, so we cannot
 *     accidentally rewrite Admin's access even if role ids differ per instance.
 *
 * Gating: skipped automatically when BookStack is not reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ZodError } from 'zod';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { PermissionTools } from '../../src/tools/permissions';
import type {
  ContentPermissions,
  MCPSchemaNode,
  MCPTool,
  UpdateContentPermissionsParams,
} from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  apiFetch,
  apiJson,
  apiUrl,
  type BookStackBook,
  type BookStackHarness,
  type BookStackList,
  CleanupTracker,
  ensureBookStack,
  shouldRunIntegration,
  tokenString,
} from './helpers/bookstack';

const runIntegration = await shouldRunIntegration();

if (!runIntegration) {
  console.log(
    '[integration] BookStack unreachable and RUN_INTEGRATION unset - skipping permissions tool suite.'
  );
}

/**
 * THE SHARED BUDGET. BookStack throttles the API per user over a 60s window, and
 * every integration suite on this instance authenticates as the same admin token —
 * so a *neighbouring* suite can exhaust the budget this one needs, and a 429 here
 * says nothing about the permission tools.
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
 * Every top-level field `GET/PUT /content-permissions/{type}/{id}` returns on
 * BookStack v26 — no more, no less.
 *
 * `src/types.ts`'s `ContentPermissions` now declares exactly these, so the suite
 * types responses as `ContentPermissions` rather than a local stand-in. The
 * interface once declared `{ inheriting, permissions[] }`: the real payload nests
 * inheriting under `fallback_permissions`, names the grant list `role_permissions`,
 * and adds an `owner` the interface omitted entirely. The client casts with an
 * unchecked `as`, so asserting this key set is the only thing that would catch a
 * re-drift.
 */
const CONTENT_PERMISSION_FIELDS = ['fallback_permissions', 'owner', 'role_permissions'] as const;

interface BookStackRole {
  id: number;
  display_name: string;
  system_name: string;
}

const unique = (prefix: string): string =>
  `itest-perm-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!runIntegration)('content-permission tools (live BookStack)', () => {
  let harness: BookStackHarness;
  let tools: Map<string, MCPTool>;
  /**
   * The same tools, wired to a validator in strict mode.
   *
   * `ValidationHandler` only *raises* a schema violation when strictMode is on
   * (the default). With `VALIDATION_STRICT_MODE=false` it instead logs a warning
   * and passes the caller's params through untouched. Both modes ship, so both
   * are tested.
   */
  let strictTools: Map<string, MCPTool>;
  let book: BookStackBook;
  let chapterId: number;
  /** Non-admin roles to hand grants to. Never the Admin role. */
  let granteeRole: BookStackRole;
  let otherRole: BookStackRole;
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

    tools = new Map<string, MCPTool>();
    for (const tool of new PermissionTools(
      client,
      new ValidationHandler(config.validation),
      logger
    ).getTools()) {
      tools.set(tool.name, tool);
    }

    strictTools = new Map<string, MCPTool>();
    for (const tool of new PermissionTools(
      client,
      new ValidationHandler({ enabled: true, strictMode: true }),
      logger
    ).getTools()) {
      strictTools.set(tool.name, tool);
    }

    // Fixture: a book of our own, plus a chapter inside it.
    const bookRes = await apiFetchWithinBudget(harness, '/books', {
      method: 'POST',
      body: JSON.stringify({
        name: unique('book'),
        description: 'Fixture for the permissions tool suite.',
      }),
    });
    expect(bookRes.status).toBe(200);
    book = await apiJson<BookStackBook>(bookRes);
    cleanup.track('book', book.id);

    const chapterRes = await apiFetchWithinBudget(harness, '/chapters', {
      method: 'POST',
      body: JSON.stringify({ book_id: book.id, name: unique('chapter') }),
    });
    expect(chapterRes.status).toBe(200);
    chapterId = (await apiJson<{ id: number }>(chapterRes)).id;

    const rolesRes = await apiFetchWithinBudget(harness, '/roles?count=100');
    expect(rolesRes.status).toBe(200);
    const roles = await apiJson<BookStackList<BookStackRole>>(rolesRes);
    // Ordinary, durable roles only:
    //   - never Admin, and never the special `public` role whose grants govern
    //     anonymous access;
    //   - never another suite's `itest-` fixture role, which can be deleted out
    //     from under us mid-test while suites run in parallel.
    const candidates = roles.data.filter(
      (role) =>
        role.system_name !== 'admin' &&
        role.system_name !== 'public' &&
        !role.display_name.startsWith('itest-')
    );
    const [first, second] = candidates;
    if (!first || !second) {
      throw new Error('Need two durable non-admin, non-public roles to test grant replacement');
    }
    granteeRole = first;
    otherRole = second;
    // Generous: connecting may have to sit out a full rate-limit window first.
  }, 240_000);

  // Deleting the book takes its chapter and every permission row with it. Cleanup can
  // have to sit out a rate-limit window, which overruns bun's 5s default hook timeout -
  // and a timed-out afterAll leaks fixtures. The tracker checks every status, purges the
  // book's own deletion row and re-reads the id, then throws if anything survived.
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

  const readPermissions = async (
    contentType: string,
    contentId: number
  ): Promise<ContentPermissions> =>
    (await callTool('bookstack_permissions_read', {
      content_type: contentType,
      content_id: contentId,
    })) as ContentPermissions;

  const updatePermissions = async (
    contentType: string,
    contentId: number,
    params: UpdateContentPermissionsParams
  ): Promise<ContentPermissions> =>
    (await callTool('bookstack_permissions_update', {
      content_type: contentType,
      content_id: contentId,
      ...params,
    })) as ContentPermissions;

  /** Hand our fixture back to inheriting, so each test starts from a clean slate. */
  const restoreInheritance = async (contentType: string, contentId: number): Promise<void> => {
    await updatePermissions(contentType, contentId, {
      role_permissions: [],
      fallback_permissions: { inheriting: true },
    });
  };

  describe('bookstack_permissions_read', () => {
    it('registers both permission tools', () => {
      expect([...tools.keys()].sort()).toEqual([
        'bookstack_permissions_read',
        'bookstack_permissions_update',
      ]);
    });

    it('files itself under the permissions category', () => {
      // PermissionTools has always declared this, but the server's category list
      // had no `permissions` entry and filed these tools under `system` instead.
      expect(findTool('bookstack_permissions_read').category).toBe('permissions');
    });

    it('reads the default (inheriting) permissions of a fresh book', async () => {
      const permissions = await readPermissions('book', book.id);

      expect(permissions.fallback_permissions.inheriting).toBe(true);
      expect(permissions.role_permissions).toEqual([]);
      expect(permissions.owner.id).toBeGreaterThan(0);
    });

    it('returns exactly the fields ContentPermissions declares', async () => {
      const permissions = await readPermissions('book', book.id);

      expect(Object.keys(permissions).sort()).toEqual([...CONTENT_PERMISSION_FIELDS]);
      // `owner` is a UserSummary the old interface did not model at all.
      expect(Object.keys(permissions.owner).sort()).toEqual(['id', 'name', 'slug']);
      // Inheriting is a property of `fallback_permissions`, not a top-level flag,
      // and the four actions read back null until inheritance is switched off.
      expect(Object.keys(permissions.fallback_permissions).sort()).toEqual([
        'create',
        'delete',
        'inheriting',
        'update',
        'view',
      ]);
      expect(permissions.fallback_permissions.view).toBeNull();
      expect(permissions.fallback_permissions.create).toBeNull();
      expect(permissions.fallback_permissions.update).toBeNull();
      expect(permissions.fallback_permissions.delete).toBeNull();
      // The grant list is `role_permissions`, never `permissions`.
      expect(permissions).not.toHaveProperty('permissions');
      expect(permissions).not.toHaveProperty('inheriting');
    });

    it('reads the permissions of a chapter', async () => {
      const permissions = await readPermissions('chapter', chapterId);

      expect(permissions.fallback_permissions.inheriting).toBe(true);
      expect(Array.isArray(permissions.role_permissions)).toBe(true);
    });

    it('rejects a content id that does not exist', async () => {
      await expect(
        callTool('bookstack_permissions_read', {
          content_type: 'book',
          content_id: 2_147_483_647,
        })
      ).rejects.toThrow();
    });

    it('rejects a non-positive content id at validation time', async () => {
      await expect(
        callTool('bookstack_permissions_read', { content_type: 'book', content_id: 0 })
      ).rejects.toThrow();
    });
  });

  describe('bookstack_permissions_update', () => {
    it('grants a role view access to our own book, then restores inheritance', async () => {
      const updated = await updatePermissions('book', book.id, {
        role_permissions: [
          { role_id: granteeRole.id, view: true, create: false, update: false, delete: false },
        ],
        fallback_permissions: {
          inheriting: false,
          view: false,
          create: false,
          update: false,
          delete: false,
        },
      });

      expect(updated.fallback_permissions.inheriting).toBe(false);
      expect(updated.role_permissions).toHaveLength(1);
      expect(updated.role_permissions[0]).toMatchObject({
        role_id: granteeRole.id,
        view: true,
        create: false,
        update: false,
        delete: false,
      });
      // Each grant carries the role it belongs to, expanded.
      expect(updated.role_permissions[0]?.role).toMatchObject({
        id: granteeRole.id,
        display_name: granteeRole.display_name,
      });

      // The write really persisted - read it back through the other tool.
      const readBack = await readPermissions('book', book.id);
      expect(readBack.fallback_permissions.inheriting).toBe(false);
      expect(readBack.role_permissions.map((p) => p.role_id)).toEqual([granteeRole.id]);

      const restored = await updatePermissions('book', book.id, {
        role_permissions: [],
        fallback_permissions: { inheriting: true },
      });

      expect(restored.fallback_permissions.inheriting).toBe(true);
      expect(restored.role_permissions).toEqual([]);
    }, 60_000);

    it('replaces the role grants rather than merging into them', async () => {
      // The tool's own docs used to promise a merge. The client sends the list
      // straight to BookStack, which sync()s it: whatever is not in the request is
      // deleted. An LLM told otherwise would send one role and silently revoke
      // every other role's access.
      try {
        const first = await updatePermissions('book', book.id, {
          role_permissions: [
            { role_id: granteeRole.id, view: true, create: false, update: false, delete: false },
          ],
          fallback_permissions: {
            inheriting: false,
            view: false,
            create: false,
            update: false,
            delete: false,
          },
        });
        expect(first.role_permissions.map((p) => p.role_id)).toEqual([granteeRole.id]);

        // Send a *different* single role. Under merge semantics both would survive.
        const second = await updatePermissions('book', book.id, {
          role_permissions: [
            { role_id: otherRole.id, view: true, create: false, update: false, delete: false },
          ],
          fallback_permissions: {
            inheriting: false,
            view: false,
            create: false,
            update: false,
            delete: false,
          },
        });

        expect(second.role_permissions.map((p) => p.role_id)).toEqual([otherRole.id]);
        expect(second.role_permissions.map((p) => p.role_id)).not.toContain(granteeRole.id);

        // Read it back: the first grant is genuinely gone, not merely omitted from
        // the response.
        const readBack = await readPermissions('book', book.id);
        expect(readBack.role_permissions.map((p) => p.role_id)).toEqual([otherRole.id]);

        // An empty list clears the grants outright - the same replace semantics.
        const cleared = await updatePermissions('book', book.id, {
          role_permissions: [],
          fallback_permissions: {
            inheriting: false,
            view: false,
            create: false,
            update: false,
            delete: false,
          },
        });
        expect(cleared.role_permissions).toEqual([]);
      } finally {
        await restoreInheritance('book', book.id);
      }
    }, 90_000);

    it('sets permissions on a chapter independently of its book', async () => {
      try {
        const updated = await updatePermissions('chapter', chapterId, {
          role_permissions: [
            { role_id: granteeRole.id, view: true, create: false, update: true, delete: false },
          ],
          fallback_permissions: {
            inheriting: false,
            view: true,
            create: false,
            update: false,
            delete: false,
          },
        });

        expect(updated.role_permissions).toHaveLength(1);
        expect(updated.role_permissions[0]?.update).toBe(true);
        expect(updated.fallback_permissions.inheriting).toBe(false);

        // The parent book is untouched: chapter overrides do not leak upwards.
        const bookPermissions = await readPermissions('book', book.id);
        expect(bookPermissions.fallback_permissions.inheriting).toBe(true);
        expect(bookPermissions.role_permissions).toEqual([]);
      } finally {
        await restoreInheritance('chapter', chapterId);
      }
    }, 60_000);

    it('rejects a content id that does not exist', async () => {
      await expect(
        callTool('bookstack_permissions_update', {
          content_type: 'book',
          content_id: 2_147_483_647,
          fallback_permissions: { inheriting: true },
        })
      ).rejects.toThrow();
    });
  });

  describe('fallback_permissions validation', () => {
    it('no longer advertises permission concepts BookStack does not have', () => {
      // The advertised example used to set `restricted: true` and grant to a
      // `user_id`. BookStack has neither: permissions are role-based only, and
      // there is no `restricted` flag anywhere in the payload. An LLM copying that
      // example produced a request that could not succeed.
      const serialized = JSON.stringify(findTool('bookstack_permissions_update'));

      expect(serialized).not.toContain('restricted');
      expect(serialized).not.toContain('user_id');
    });

    /**
     * This replaces an assertion that read `expect(schema.required).toEqual(['inheriting'])`
     * and nothing more.
     *
     * That assertion passed identically with and without the conditional branch, because the
     * `oneOf` is a SIBLING of `required` rather than a change to it: the base `required` is
     * still exactly `['inheriting']`, and the branch is what adds the other four when
     * `inheriting` is false. So it could not fail on the bug it sat next to - and its name
     * ("advertises inheriting as the one required fallback field") taught the weaker reading
     * that only `inheriting` is ever needed, which is the very thing BookStack contradicts
     * with `required_if:fallback_permissions.inheriting,false`.
     *
     * The behavioural half of this - that both the published schema and the runtime accept
     * and reject the same payloads - is proven over the real HTTP `tools/call` route in
     * tests/transport/tools.test.ts. What is asserted here is the structure a client reads.
     */
    it('advertises the conditional fallback requirement, not just inheriting', () => {
      const schema = findTool('bookstack_permissions_update').inputSchema.properties
        .fallback_permissions as MCPSchemaNode;

      // The property set is unchanged, and the base `required` still names only
      // `inheriting` - which is exactly why it cannot be the whole assertion.
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
        'create',
        'delete',
        'inheriting',
        'update',
        'view',
      ]);
      expect(schema.required).toEqual(['inheriting']);

      // The part that carries the contract: two branches, discriminated on `inheriting`.
      const branches = schema.oneOf ?? [];
      expect(branches).toHaveLength(2);

      const inheritingBranch = branches.find(
        (branch) => branch.properties?.inheriting?.const === true
      );
      const overrideBranch = branches.find(
        (branch) => branch.properties?.inheriting?.const === false
      );

      // inheriting:true - the four flags are not merely unnecessary, they are refused, because
      // BookStack answers 200 and nulls them, so an accepted `view: true` would mean its
      // opposite.
      expect(inheritingBranch).toBeDefined();
      expect(inheritingBranch?.required).toEqual(['inheriting']);
      expect(inheritingBranch?.not?.anyOf?.map((clause) => clause.required?.[0]).sort()).toEqual([
        'create',
        'delete',
        'update',
        'view',
      ]);

      // inheriting:false - all four become required, which is the rule the old assertion
      // could not see.
      expect(overrideBranch).toBeDefined();
      expect([...(overrideBranch?.required ?? [])].sort()).toEqual([
        'create',
        'delete',
        'inheriting',
        'update',
        'view',
      ]);
    });

    /**
     * The examples are what an LLM copies, so each must actually validate - as written,
     * whole.
     *
     * This used to strip `content_type`/`content_id` before validating, which made the
     * test weaker than the thing it checks in two ways: `contentPermissionsUpdate` now
     * models the COMPLETE request (both fields included, because they select the endpoint
     * and used to reach the URL builder as unchecked casts), so a projection could not
     * see them - and under a strict schema, handing over an object with those keys
     * removed is not the call the example advertises at all. Passing `example.input`
     * verbatim is the only version that checks what a caller would actually send.
     */
    it('accepts every input its own examples advertise', () => {
      const validator = new ValidationHandler({ enabled: true, strictMode: true });
      const examples = findTool('bookstack_permissions_update').examples ?? [];
      expect(examples.length).toBeGreaterThan(0);

      for (const example of examples) {
        expect(() =>
          validator.validateParams(example.input, 'contentPermissionsUpdate')
        ).not.toThrow();
      }
    });

    it('rejects inheriting:false without all four action flags at the boundary', async () => {
      // `{ inheriting: false, view: true }` is what four independently-optional
      // booleans used to allow through: BookStack requires create/update/delete as
      // soon as inheriting is false, so the only thing that caught it was a 422
      // from the far side of the network. A discriminated union now settles it
      // here, before any request is issued.
      let caught: unknown;
      try {
        await findStrictTool('bookstack_permissions_update').handler({
          content_type: 'book',
          content_id: book.id,
          fallback_permissions: { inheriting: false, view: true },
        });
      } catch (error) {
        caught = error;
      }

      // A ZodError can only have come from our own boundary: BookStack's 422 is
      // surfaced as an McpError, so the error's *type* is what proves no request
      // was ever sent.
      expect(caught).toBeInstanceOf(ZodError);
      const issues = (caught as ZodError).issues;
      // The rejection names precisely what is missing.
      expect(issues.map((issue) => issue.path.join('.')).sort()).toEqual([
        'fallback_permissions.create',
        'fallback_permissions.delete',
        'fallback_permissions.update',
      ]);

      // The rejected write left the fixture exactly as it was.
      const permissions = await readPermissions('book', book.id);
      expect(permissions.fallback_permissions.inheriting).toBe(true);
    }, 30_000);

    it('rejects an unrecognised inheriting value with a message naming both shapes', async () => {
      let caught: unknown;
      try {
        await findStrictTool('bookstack_permissions_update').handler({
          content_type: 'book',
          content_id: book.id,
          fallback_permissions: { view: true },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ZodError);
      const message = (caught as ZodError).issues.map((issue) => issue.message).join(' ');
      expect(message).toContain('inheriting: true');
      expect(message).toContain('inheriting: false');
    }, 30_000);

    /**
     * Both branches of the `fallback_permissions` union are reachable.
     *
     * The routing fields are supplied because the schema models the whole request: a bare
     * `{fallback_permissions: ...}` is missing two required keys, so it would now be
     * rejected for reasons that have nothing to do with the union under test - and a test
     * asserting `.not.toThrow()` on it would fail while the union was perfectly fine.
     */
    it('accepts both halves of the union', () => {
      const validator = new ValidationHandler({ enabled: true, strictMode: true });

      expect(() =>
        validator.validateParams(
          {
            content_type: 'book',
            content_id: book.id,
            fallback_permissions: { inheriting: true },
          },
          'contentPermissionsUpdate'
        )
      ).not.toThrow();

      expect(() =>
        validator.validateParams(
          {
            content_type: 'book',
            content_id: book.id,
            fallback_permissions: {
              inheriting: false,
              view: true,
              create: false,
              update: false,
              delete: false,
            },
          },
          'contentPermissionsUpdate'
        )
      ).not.toThrow();
    });

    it('still round-trips to a 422 when strict mode is disabled', async () => {
      // Records the opt-out path (VALIDATION_STRICT_MODE=false); strict is the
      // default. `ValidationHandler.validateParams`
      // only *raises* a schema violation when strictMode is on; otherwise it warns
      // and forwards the caller's params untouched, so the union above cannot stop
      // the request and BookStack rejects it instead. The outcome is still a
      // refusal - the fixture is never corrupted either way - but the rejection
      // costs a round trip and arrives as a generic "Validation failed".
      await expect(
        callTool('bookstack_permissions_update', {
          content_type: 'book',
          content_id: book.id,
          fallback_permissions: { inheriting: false, view: true },
        })
      ).rejects.toThrow(/Validation failed/);

      const permissions = await readPermissions('book', book.id);
      expect(permissions.fallback_permissions.inheriting).toBe(true);
    }, 30_000);
  });
});

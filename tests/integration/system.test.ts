/**
 * Integration tests for the system and server-info MCP tools against a live BookStack.
 *
 * Unlike smoke.test.ts (which drives raw HTTP), this suite drives the actual MCP
 * tool objects — real `BookStackClient`, real `ValidationHandler`, real `Logger` —
 * so it exercises the same code path an MCP client would hit.
 *
 * Tools covered here (6):
 *   - bookstack_system_info      (SystemTools, hits BookStack's GET /system)
 *   - bookstack_server_info      (ServerInfoTools)
 *   - bookstack_tool_categories  (ServerInfoTools)
 *   - bookstack_usage_examples   (ServerInfoTools)
 *   - bookstack_error_guides     (ServerInfoTools)
 *   - bookstack_help             (ServerInfoTools)
 *
 * Gating: skipped automatically when BookStack is not reachable, so a plain
 * `bun test` with no Docker stays green. See shouldRunIntegration().
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import { type Config, ConfigManager } from '../../src/config/manager';
import { BookResources } from '../../src/resources/books';
import { SearchResources } from '../../src/resources/search';
import { AuditTools } from '../../src/tools/audit';
import { PermissionTools } from '../../src/tools/permissions';
import { RecycleBinTools } from '../../src/tools/recyclebin';
import { ServerInfoTools } from '../../src/tools/server-info';
import { SystemTools } from '../../src/tools/system';
import type {
  ErrorHandlingInfo,
  MCPResource,
  MCPServerInfo,
  MCPTool,
  ResourceType,
  ServerUsageExample,
  SystemInfo,
  ToolCategory,
} from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  apiUrl,
  appUrl,
  type BookStackHarness,
  ensureBookStack,
  shouldRunIntegration,
  tokenString,
} from './helpers/bookstack';

const runIntegration = await shouldRunIntegration();

if (!runIntegration) {
  console.log(
    '[integration] BookStack unreachable and RUN_INTEGRATION unset - skipping system tool suite.'
  );
}

/**
 * THE SHARED BUDGET. BookStack throttles the API per user over a 60s window, and
 * every integration suite on this instance authenticates as the same admin token —
 * so a *neighbouring* suite can exhaust the budget this one needs, and a 429 here
 * says nothing about the tools under test.
 *
 * This test instance is provisioned well above BookStack's 180/min default, so the
 * retries below should effectively never fire. They stay because the default is
 * what a real deployment runs, and because waiting a closed window out is the only
 * honest response to a throttle: only 429 is ever retried, so every other error
 * still fails on the first attempt.
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

/**
 * Every field `GET /system` returns on BookStack v26 — no more, no less.
 *
 * `src/types.ts`'s `SystemInfo` now declares exactly these five, so the suite types
 * the response as `SystemInfo` rather than a local stand-in and asserts the key set
 * outright. That equality is the whole point: the client casts the response with an
 * unchecked `as`, so a drift between the interface and the wire format is invisible
 * at runtime and this assertion is the only thing that would catch it.
 */
const SYSTEM_INFO_FIELDS = ['app_logo', 'app_name', 'base_url', 'instance_id', 'version'] as const;

describe.skipIf(!runIntegration)('system + server-info tools (live BookStack)', () => {
  let harness: BookStackHarness;
  let toolsMap: Map<string, MCPTool>;
  let resourcesMap: Map<string, MCPResource>;

  beforeAll(async () => {
    harness = await connectWhenNotThrottled();

    // `bookstack_server_info` reads the ConfigManager singleton, which builds its
    // config from the environment and rejects an empty API token. Populate the
    // environment before any handler can construct it.
    process.env.BOOKSTACK_BASE_URL = harness.baseUrl;
    process.env.BOOKSTACK_API_TOKEN = harness.token;
    // One test below reload()s that singleton, and loadConfig() reconfigures the
    // shared Logger from these two. Pin them to the quiet settings this suite runs
    // with, so a reload cannot leave a noisier logger behind for its neighbours.
    process.env.LOG_LEVEL = 'error';
    process.env.LOG_FORMAT = 'json';

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

    // Mirror server.ts: the maps ServerInfoTools reports on are the server's own
    // registries, so build them from real tool/resource classes rather than stubs.
    toolsMap = new Map<string, MCPTool>();
    for (const toolClass of [
      new SystemTools(client, validator, logger),
      new RecycleBinTools(client, validator, logger),
      new PermissionTools(client, validator, logger),
      new AuditTools(client, validator, logger),
    ]) {
      for (const tool of toolClass.getTools()) {
        toolsMap.set(tool.name, tool);
      }
    }

    resourcesMap = new Map<string, MCPResource>();
    for (const resourceClass of [
      new BookResources(client, logger),
      new SearchResources(client, logger),
    ]) {
      for (const resource of resourceClass.getResources()) {
        resourcesMap.set(resource.uri, resource);
      }
    }

    const serverInfoTools = new ServerInfoTools(logger, toolsMap, resourcesMap);
    for (const tool of serverInfoTools.getTools()) {
      toolsMap.set(tool.name, tool);
    }
    // Generous: connecting may have to sit out a full rate-limit window first.
  }, 240_000);

  const findTool = (name: string): MCPTool => {
    const tool = toolsMap.get(name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool;
  };

  /**
   * The values a tool's inputSchema advertises for one of its string properties.
   *
   * Driving the tests off the *advertised* enum rather than a hand-copied list is
   * what makes "every value returns real content" a claim about the tool's own
   * contract: add a value to an enum without implementing it and these tests fail.
   */
  const advertisedEnum = (toolName: string, property: string): string[] => {
    const schema = findTool(toolName).inputSchema.properties[property] as
      | { enum?: readonly string[] }
      | undefined;
    const values = schema?.enum;
    if (!values || values.length === 0) {
      throw new Error(`${toolName}'s inputSchema advertises no enum for '${property}'`);
    }
    return [...values];
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

  describe('bookstack_system_info', () => {
    it('registers exactly one system tool', () => {
      expect(findTool('bookstack_system_info').name).toBe('bookstack_system_info');
    });

    it('returns live instance metadata from GET /system', async () => {
      const info = (await callTool('bookstack_system_info', {})) as SystemInfo;

      // The endpoint behind healthCheck(): a hard failure here breaks /health too.
      expect(info.version).toMatch(/^v?\d+\.\d+/);
      expect(info.instance_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(info.base_url).toBe(appUrl());
      expect(typeof info.app_name).toBe('string');
      expect(info.app_name.length).toBeGreaterThan(0);
      expect(typeof info.app_logo).toBe('string');
    });

    it('returns exactly the fields SystemInfo declares, and no others', async () => {
      const info = (await callTool('bookstack_system_info', {})) as SystemInfo;

      // The interface once declared php_version / theme / language / timezone /
      // app_url / drawing_enabled / registrations_enabled / upload_limit — none of
      // which v26 returns — and omitted app_name / app_logo / base_url, which it
      // does. Asserting the exact key set is what keeps that fiction from coming
      // back: every declared field is present, and nothing undeclared arrives.
      expect(Object.keys(info).sort()).toEqual([...SYSTEM_INFO_FIELDS]);
    });

    /**
     * The support list is a record of what was actually exercised, so the version this
     * suite just drove has to be on it - exactly, not by major.
     *
     * It used to read ['23.x', '24.x', '26.x'], inventing coverage of two majors nothing
     * here has ever run against while omitting the 25.x that src/api/client.ts documents
     * real observations from; this test passed anyway, because a `26.x` match said
     * nothing about the other two. It is now the single exact version above, which is a
     * claim this test can actually check: BookStack ships breaking API details in point
     * releases (role create and read disagree on their response shape, for one), so a
     * major-version range would be an assertion nobody has evidence for.
     *
     * Consequence worth knowing: bumping the instance in docker-compose.yml without
     * re-verifying fails here, which is the point.
     */
    it('runs the exact BookStack version this server claims to have been verified against', async () => {
      const info = (await callTool('bookstack_system_info', {})) as SystemInfo;
      const serverInfo = (await callTool('bookstack_server_info', {})) as MCPServerInfo;

      expect(serverInfo.supported_bookstack_versions).toContain(info.version);
      // A record of verification, not a compatibility range: one entry, no wildcards.
      expect(serverInfo.supported_bookstack_versions).toEqual([info.version]);
      expect(serverInfo.supported_bookstack_versions).not.toContainEqual(
        expect.stringMatching(/\.x$/)
      );
    });

    /**
     * NON-STRICT behaviour, and only that.
     *
     * This suite deliberately builds `validation: { strictMode: false }` (see the config
     * above), which is NOT what the server ships - `VALIDATION_STRICT_MODE` defaults to true.
     * So this documents the opt-out path: log the schema failure and forward the original
     * params. It is no guard whatsoever for the shipped default, and its previous name
     * ("ignores extraneous params (the schema declares none)") read as though ignoring them
     * were the tool's contract rather than one mode's.
     *
     * The shipped strict default is where an extraneous argument is REJECTED, and it is
     * guarded in tests/unit/strict-validation.test.ts - which asserts both the rejection and
     * that BookStack was never contacted - and over the real HTTP route in
     * tests/transport/tools.test.ts.
     */
    it('forwards extraneous params in non-strict mode, which is not the shipped default', async () => {
      const info = (await callTool('bookstack_system_info', {
        unexpected: true,
      })) as SystemInfo;

      expect(info.instance_id).toMatch(/-/);
    });
  });

  describe('bookstack_server_info', () => {
    it('reports the injected tool and resource registries', async () => {
      const info = (await callTool('bookstack_server_info', {})) as MCPServerInfo;

      expect(info.name).toBe('BookStack MCP Server');
      expect(info.version).toBe('1.0.0');
      expect(info.capabilities.tools.total).toBe(toolsMap.size);
      expect(info.capabilities.resources.total).toBe(resourcesMap.size);
      expect(info.capabilities.authentication.required).toBe(true);
      expect(info.capabilities.authentication.methods).toContain('API Token');
      expect(info.tool_categories.length).toBeGreaterThan(0);
      expect(info.resource_types.length).toBeGreaterThan(0);
      expect(info.error_handling.common_errors.length).toBeGreaterThan(0);
    });

    it('reflects the real ConfigManager configuration', async () => {
      const info = (await callTool('bookstack_server_info', {
        section: 'capabilities',
      })) as Pick<MCPServerInfo, 'capabilities'>;

      // rateLimit always resolves (the schema defaults it), so this is always on.
      expect(info.capabilities.rate_limiting.enabled).toBe(true);
      expect(typeof info.capabilities.rate_limiting.requests_per_minute).toBe('number');
      expect(typeof info.capabilities.rate_limiting.burst_limit).toBe('number');
      expect(info.capabilities.validation.enabled).toBe(true);
      expect(typeof info.capabilities.validation.strict_mode).toBe('boolean');
    });

    it('reports only capabilities this server actually has', async () => {
      const info = (await callTool('bookstack_server_info', {
        section: 'capabilities',
      })) as Pick<MCPServerInfo, 'capabilities'>;

      // Each of these once advertised a feature that does not exist, which is worse
      // than silence: an LLM reading `supports_batch_operations: true` will look for
      // a batch tool, and `supports_caching: true` invites it to assume a stale read
      // is cheap. There is no batch layer, no cache, no streaming and no transaction
      // support anywhere in this server, so all four must report false.
      expect(info.capabilities.tools.supports_batch_operations).toBe(false);
      expect(info.capabilities.tools.supports_transactions).toBe(false);
      expect(info.capabilities.resources.supports_streaming).toBe(false);
      expect(info.capabilities.resources.supports_caching).toBe(false);
    });

    it('can report validation as disabled when the environment disables it', async () => {
      // `config.validation?.enabled || true` is `true` for every input — a disabled
      // validator reported itself as enabled, and no value of VALIDATION_ENABLED
      // could ever change that. `??` is what makes this observable.
      const previous = process.env.VALIDATION_ENABLED;
      try {
        process.env.VALIDATION_ENABLED = 'false';
        ConfigManager.getInstance().reload();

        const info = (await callTool('bookstack_server_info', {
          section: 'capabilities',
        })) as Pick<MCPServerInfo, 'capabilities'>;

        expect(info.capabilities.validation.enabled).toBe(false);
      } finally {
        // Restore the singleton for every other test, pass or fail.
        if (previous === undefined) {
          delete process.env.VALIDATION_ENABLED;
        } else {
          process.env.VALIDATION_ENABLED = previous;
        }
        ConfigManager.getInstance().reload();
      }

      const restored = (await callTool('bookstack_server_info', {
        section: 'capabilities',
      })) as Pick<MCPServerInfo, 'capabilities'>;
      expect(restored.capabilities.validation.enabled).toBe(true);
    });

    it('returns only the tools section when asked', async () => {
      const result = (await callTool('bookstack_server_info', { section: 'tools' })) as {
        tool_categories: ToolCategory[];
        total_tools: number;
      };

      expect(result.total_tools).toBe(toolsMap.size);
      expect(result.tool_categories.map((c) => c.name)).toContain('system');
      expect(result).not.toHaveProperty('capabilities');
    });

    it('returns only the resources section when asked', async () => {
      const result = (await callTool('bookstack_server_info', {
        section: 'resources',
      })) as {
        resource_types: ResourceType[];
        total_resources: number;
      };

      expect(result.total_resources).toBe(resourcesMap.size);
      expect(result.resource_types.map((r) => r.type)).toContain('books');
    });

    it('returns only the examples section when asked', async () => {
      const result = (await callTool('bookstack_server_info', { section: 'examples' })) as {
        usage_examples: ServerUsageExample[];
      };

      expect(result.usage_examples.length).toBeGreaterThan(0);
      for (const example of result.usage_examples) {
        expect(example.key.length).toBeGreaterThan(0);
        expect(example.workflow.length).toBeGreaterThan(0);
      }
    });

    it('returns only the errors section when asked', async () => {
      const result = (await callTool('bookstack_server_info', { section: 'errors' })) as {
        error_handling: ErrorHandlingInfo;
      };

      expect(result.error_handling.common_errors.map((e) => e.code)).toContain('UNAUTHORIZED');
      expect(result.error_handling.support_contact).toContain('github.com');
    });

    it('rejects an unknown section instead of silently returning everything', async () => {
      // The tool advertises an INVALID_SECTION error code, so it has to actually
      // raise one: an out-of-enum value used to fall through the switch's default
      // branch and hand back the full payload, making the advertised code dead
      // and hiding the caller's typo behind a plausible-looking success.
      const result = (await callTool('bookstack_server_info', {
        section: 'not-a-section',
      })) as {
        error?: string;
        message?: string;
        requested?: string;
        available_sections?: string[];
      };

      expect(result.error).toBe('INVALID_SECTION');
      expect(result.requested).toBe('not-a-section');
      expect(result.message).toContain('not-a-section');
      // The recovery path the error names is the tool's own advertised enum.
      expect(result.available_sections).toEqual(advertisedEnum('bookstack_server_info', 'section'));
      // Emphatically not the full payload.
      expect(result).not.toHaveProperty('name');
      expect(result).not.toHaveProperty('capabilities');
    });

    it('still serves every section its enum advertises', async () => {
      // The flip side of enforcing the enum: nothing advertised may be rejected.
      for (const section of advertisedEnum('bookstack_server_info', 'section')) {
        const result = (await callTool('bookstack_server_info', { section })) as {
          error?: string;
        };
        expect(result.error).toBeUndefined();
      }
    });
  });

  describe('bookstack_tool_categories', () => {
    it('advertises exactly the categories it can return', async () => {
      const result = (await callTool('bookstack_tool_categories', {})) as {
        categories: ToolCategory[];
      };

      // The enum and getToolCategories() are two hand-maintained lists that must
      // agree: a name in one and not the other is either a category no caller can
      // ask for, or an enum value that only ever answers "Category not found".
      expect(result.categories.map((c) => c.name)).toEqual(
        advertisedEnum('bookstack_tool_categories', 'category')
      );
    });

    it('lists every category', async () => {
      const result = (await callTool('bookstack_tool_categories', {})) as {
        categories: ToolCategory[];
      };

      const names = result.categories.map((c) => c.name);
      expect(names).toContain('books');
      expect(names).toContain('system');
      expect(names).toContain('recyclebin');
      expect(names).toContain('permissions');
    });

    it('returns a single category by name', async () => {
      const category = (await callTool('bookstack_tool_categories', {
        category: 'books',
      })) as ToolCategory;

      expect(category.name).toBe('books');
      expect(category.tools).toContain('bookstack_books_list');
      expect(category.use_cases.length).toBeGreaterThan(0);
    });

    it('exposes permissions as a category in its own right', async () => {
      // PermissionTools has always declared `category: 'permissions'`, but the
      // category list had no such entry and filed its tools under `system` — so the
      // one category an LLM would look in for them did not exist.
      const category = (await callTool('bookstack_tool_categories', {
        category: 'permissions',
      })) as ToolCategory & { error?: string };

      expect(category.error).toBeUndefined();
      expect(category.name).toBe('permissions');
      expect([...category.tools].sort()).toEqual([
        'bookstack_permissions_read',
        'bookstack_permissions_update',
      ]);
      expect(category.description.length).toBeGreaterThan(0);
      expect(category.use_cases.length).toBeGreaterThan(0);
    });

    it('no longer files the permission tools under system', async () => {
      const category = (await callTool('bookstack_tool_categories', {
        category: 'system',
      })) as ToolCategory;

      expect(category.tools).toEqual(['bookstack_system_info', 'bookstack_audit_log_list']);
      expect(category.tools).not.toContain('bookstack_permissions_read');
      expect(category.tools).not.toContain('bookstack_permissions_update');
    });

    it('only advertises tools that are actually registered', async () => {
      // A category naming a tool the server never registers would send an LLM
      // chasing a nonexistent tool, so cross-check every category whose tools this
      // suite registers in full.
      const result = (await callTool('bookstack_tool_categories', {})) as {
        categories: ToolCategory[];
      };

      const advertised = result.categories
        .filter((c) => c.name === 'system' || c.name === 'recyclebin' || c.name === 'permissions')
        .flatMap((c) => c.tools);

      expect(advertised.length).toBeGreaterThan(0);
      for (const toolName of advertised) {
        expect(toolsMap.has(toolName)).toBe(true);
      }
    });

    it('reports an error for an unknown category', async () => {
      const result = (await callTool('bookstack_tool_categories', {
        category: 'nonexistent',
      })) as { error?: string; requested?: string; available_categories?: string[] };

      expect(result.error).toBe('Category not found');
      expect(result.requested).toBe('nonexistent');
      expect(result.available_categories).toEqual(
        advertisedEnum('bookstack_tool_categories', 'category')
      );
    });
  });

  describe('bookstack_usage_examples', () => {
    it('lists every workflow example', async () => {
      const result = (await callTool('bookstack_usage_examples', {})) as {
        examples: ServerUsageExample[];
      };

      expect(result.examples.length).toBeGreaterThan(0);
      const first = result.examples[0];
      expect(first).toBeDefined();
      expect(first?.workflow[0]?.step).toBe(1);
      expect(first?.expected_outcome.length).toBeGreaterThan(0);
    });

    it('serves real content for every workflow its enum advertises', async () => {
      // This tool was wholly non-functional: lookup was
      // `title.toLowerCase().includes(workflow)`, and since every enum value carries
      // an underscore and no title does, all five values returned "Workflow not
      // found" — two of them had no content behind them at all. Every advertised
      // value must now come back as a fully-populated workflow.
      const workflows = advertisedEnum('bookstack_usage_examples', 'workflow');
      expect(workflows).toHaveLength(5);

      for (const workflow of workflows) {
        const example = (await callTool('bookstack_usage_examples', {
          workflow,
        })) as ServerUsageExample & { error?: string };

        expect(example.error).toBeUndefined();
        // Lookup keys off the stable `key`, not the prose title.
        expect(example.key).toBe(workflow);
        expect(example.title.length).toBeGreaterThan(0);
        expect(example.description.length).toBeGreaterThan(0);
        expect(example.expected_outcome.length).toBeGreaterThan(0);

        // A workflow is only real if its steps are: numbered from 1, each naming a
        // tool and saying what it is for.
        expect(example.workflow.length).toBeGreaterThan(0);
        example.workflow.forEach((step, index) => {
          expect(step.step).toBe(index + 1);
          expect(step.tool_or_resource.length).toBeGreaterThan(0);
          expect(step.action.length).toBeGreaterThan(0);
          expect(step.description.length).toBeGreaterThan(0);
        });
      }
    });

    it('advertises exactly the workflows it holds content for', async () => {
      const result = (await callTool('bookstack_usage_examples', {})) as {
        examples: ServerUsageExample[];
      };

      expect([...result.examples.map((e) => e.key)].sort()).toEqual(
        [...advertisedEnum('bookstack_usage_examples', 'workflow')].sort()
      );
    });

    it('only ever points at tools that really exist', async () => {
      // A workflow step naming a tool the server does not have is a dead end an LLM
      // cannot recover from, so cross-check every step against the full tool list
      // the server advertises.
      const categories = (await callTool('bookstack_tool_categories', {})) as {
        categories: ToolCategory[];
      };
      const knownTools = new Set(categories.categories.flatMap((c) => c.tools));

      const result = (await callTool('bookstack_usage_examples', {})) as {
        examples: ServerUsageExample[];
      };

      for (const example of result.examples) {
        for (const step of example.workflow) {
          expect(knownTools.has(step.tool_or_resource)).toBe(true);
        }
      }
    });

    it('reports an error for an unknown workflow', async () => {
      const result = (await callTool('bookstack_usage_examples', {
        workflow: 'no-such-workflow',
      })) as { error?: string; requested?: string; available_workflows?: string[] };

      expect(result.error).toBe('Workflow not found');
      expect(result.requested).toBe('no-such-workflow');
      // The error names the keys that would have worked.
      expect([...(result.available_workflows ?? [])].sort()).toEqual(
        [...advertisedEnum('bookstack_usage_examples', 'workflow')].sort()
      );
    });
  });

  describe('bookstack_error_guides', () => {
    it('returns the whole error-handling guide', async () => {
      const info = (await callTool('bookstack_error_guides', {})) as ErrorHandlingInfo;

      expect(info.common_errors.map((e) => e.code)).toEqual([
        'UNAUTHORIZED',
        'NOT_FOUND',
        'VALIDATION_ERROR',
      ]);
      expect(info.debugging_tips.length).toBeGreaterThan(0);
    });

    it('looks a single error code up', async () => {
      const result = (await callTool('bookstack_error_guides', {
        error_code: 'NOT_FOUND',
      })) as { code: string; causes: string[]; solutions: string[] };

      expect(result.code).toBe('NOT_FOUND');
      expect(result.causes.length).toBeGreaterThan(0);
      expect(result.solutions.length).toBeGreaterThan(0);
    });

    it('reports an error for an unknown code', async () => {
      const result = (await callTool('bookstack_error_guides', {
        error_code: 'TEAPOT',
      })) as { error?: string };

      expect(result.error).toBe('Error code not found');
    });
  });

  describe('bookstack_help', () => {
    it('lists the available topics when none is given', async () => {
      const result = (await callTool('bookstack_help', {})) as {
        available_topics: string[];
        general_guidance: string;
      };

      // Three of the six advertised topics carried no content at all; the listing
      // and the enum now agree, so what is offered is what can be answered.
      expect(result.available_topics).toEqual(advertisedEnum('bookstack_help', 'topic'));
      expect(result.general_guidance).toContain('bookstack_server_info');
    });

    it('serves real content for every topic its enum advertises', async () => {
      // user_management, search and best_practices were advertised but unwritten:
      // asking for one returned `{ topic, guidance: undefined }` — a success-shaped
      // response carrying nothing, which is the hardest kind of gap for an LLM to
      // notice. All six must now answer with substance.
      const topics = advertisedEnum('bookstack_help', 'topic');
      expect(topics).toHaveLength(6);

      for (const topic of topics) {
        const result = (await callTool('bookstack_help', { topic })) as {
          topic?: string;
          guidance?: Record<string, unknown>;
          context_advice?: string | null;
          error?: string;
        };

        expect(result.error).toBeUndefined();
        expect(result.topic).toBe(topic);

        const guidance = result.guidance;
        expect(guidance).toBeDefined();
        if (!guidance) throw new Error(`unreachable: ${topic} guidance missing`);

        // Substance, not merely presence: an overview plus at least one further
        // section of advice, every section a non-empty list of non-empty strings.
        expect(typeof guidance.overview).toBe('string');
        expect(String(guidance.overview).length).toBeGreaterThan(0);
        expect(Object.keys(guidance).length).toBeGreaterThan(1);

        for (const [section, value] of Object.entries(guidance)) {
          if (section === 'overview') continue;
          expect(Array.isArray(value)).toBe(true);
          const entries = value as unknown[];
          expect(entries.length).toBeGreaterThan(0);
          for (const entry of entries) {
            expect(typeof entry).toBe('string');
            expect(String(entry).length).toBeGreaterThan(0);
          }
        }

        expect(result.context_advice).toBeNull();
      }
    });

    it('returns guidance for a known topic', async () => {
      const result = (await callTool('bookstack_help', {
        topic: 'getting_started',
      })) as {
        topic: string;
        guidance: { overview: string; first_steps: string[] };
        context_advice: string | null;
      };

      expect(result.topic).toBe('getting_started');
      expect(result.guidance.overview).toContain('bookstack_server_info');
      expect(result.guidance.first_steps.length).toBeGreaterThan(0);
      expect(result.context_advice).toBeNull();
    });

    it('adds contextual advice when context is supplied', async () => {
      const result = (await callTool('bookstack_help', {
        topic: 'content_creation',
        context: 'I want to create a new book for our API docs',
      })) as { context_advice: string | null };

      expect(result.context_advice).toContain('For creating content');
    });

    it('reports an error for an unknown topic', async () => {
      // An unrecognised topic used to fall straight through to `guidance:
      // undefined`, reporting success while answering nothing.
      const result = (await callTool('bookstack_help', {
        topic: 'no-such-topic',
      })) as {
        error?: string;
        requested?: string;
        available_topics?: string[];
        guidance?: unknown;
      };

      expect(result.error).toBe('Topic not found');
      expect(result.requested).toBe('no-such-topic');
      expect(result.available_topics).toEqual(advertisedEnum('bookstack_help', 'topic'));
      expect(result).not.toHaveProperty('guidance');
    });
  });
});

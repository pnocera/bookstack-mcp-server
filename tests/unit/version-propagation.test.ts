import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pkg from '../../package.json' with { type: 'json' };
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { ConfigManager } from '../../src/config/manager';
import { ServerInfoTools } from '../../src/tools/server-info';
import type { MCPResource, MCPServerInfo, MCPTool } from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { resetSharedRateLimiters } from '../../src/utils/rateLimit';
import { VERSION } from '../../src/version';
import { startBookStackStub } from '../transport/stub-bookstack';

/**
 * release-please rewrites package.json and nothing else in src/, so any version
 * literal elsewhere survives a release: the 2.0.0 tarball — the breaking Bun-only
 * one — would introduce itself as 1.0.0 over MCP initialize, from GET /, from
 * bookstack_server_info and on every outbound API call, in an artifact npm will
 * not let us replace.
 *
 * Two rules this file has learned the hard way, both from tests that passed while
 * the bug was live:
 *
 *  1. OBSERVE the surface, never assert *about* it. A comment is not evidence that
 *     initialize was checked, and axios's construction-time defaults are not
 *     evidence of what reaches the wire — an interceptor can rewrite the header
 *     afterwards, and did, with the suite still green.
 *  2. TEST THE PATH A RELEASE TAKES. A sentinel delivered through SERVER_VERSION
 *     only proves the override branch works. `.env.example` tells operators to
 *     leave that unset, so the DEFAULT branch is the one the published artifact
 *     runs — and a consumer that honours config only when SERVER_VERSION is set,
 *     falling back to a stale literal otherwise, passed every override test.
 *
 * Hence: sentinels arrive through `Config` (not the environment) wherever the
 * default path is under test, and are deliberately never the package's own
 * version — while package.json says 1.0.0, asserting package.json#version cannot
 * tell "reads package.json" from "hard-codes the same string".
 */

/** Delivered via Config, so it cannot arrive through the SERVER_VERSION branch. */
const SENTINEL = '9.8.7-sentinel';
/** Delivered via the environment, to prove the override is honoured. */
const OVERRIDE = '9.8.7-test';

const ENV_KEYS = ['SERVER_VERSION', 'BOOKSTACK_BASE_URL', 'BOOKSTACK_API_TOKEN'] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

/**
 * Restore exactly what the process started with — including "was absent".
 * These suites share one process environment and the ConfigManager singleton, so a
 * leaked stub token makes a later file believe it has a credential the run never
 * had, and an unconditional delete destroys a legitimate pre-existing value.
 */
function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    ConfigManager.getInstance().reload();
  } catch {
    // Best-effort: the environment this file INHERITED may not be loadable on its
    // own (run this file alone and there is no BOOKSTACK_API_TOKEN at all). The
    // restore above is the part that matters — reloading merely avoids handing the
    // next file a singleton built from our stub. Rethrowing here would fail a
    // passing test in teardown over a condition it did not create.
  }
}

/**
 * ConfigManager validates on load, so a token must exist before any reload().
 * `??=` so a real pre-existing value is used rather than clobbered; restoreEnv()
 * puts the original back (including "absent") after every test. The production
 * name is BOOKSTACK_BASE_URL — an earlier revision set BOOKSTACK_API_URL, which
 * nothing reads, so that line had been doing nothing at all.
 */
beforeEach(() => {
  process.env.BOOKSTACK_BASE_URL ??= 'http://localhost:6875/api';
  process.env.BOOKSTACK_API_TOKEN ??= 'id:secret';
});

afterEach(restoreEnv);
afterAll(restoreEnv);

async function serverInfo(): Promise<MCPServerInfo> {
  const tools = new ServerInfoTools(
    Logger.getInstance(),
    new Map<string, MCPTool>(),
    new Map<string, MCPResource>()
  );
  const tool = tools.getTools().find((t) => t.name === 'bookstack_server_info');
  if (!tool) throw new Error('bookstack_server_info tool is missing');
  return (await tool.handler({})) as unknown as MCPServerInfo;
}

/** The User-Agent a real BookStack server received from `config`. */
async function userAgentOnWire(build: (base: Config) => Config): Promise<string | undefined> {
  const stub = startBookStackStub();
  try {
    process.env.BOOKSTACK_BASE_URL = stub.baseUrl;
    process.env.BOOKSTACK_API_TOKEN = stub.apiToken;
    const config = build(ConfigManager.getInstance().reload());

    const logger = Logger.getInstance();
    await new BookStackClient(config, logger, new ErrorHandler(logger)).listBooks();

    return stub.requests.at(-1)?.userAgent;
  } finally {
    await stub.stop();
    resetSharedRateLimiters();
  }
}

describe('version propagation — the default path a release actually uses', () => {
  it('derives the default from package.json, not a literal', () => {
    delete process.env.SERVER_VERSION;
    ConfigManager.getInstance().reload();

    expect(VERSION).toBe(pkg.version);
    expect(ConfigManager.getInstance().getConfig().server.version).toBe(pkg.version);
  });

  /**
   * SERVER_VERSION is UNSET here and the sentinel arrives through Config. That is
   * the whole point: a consumer reading the env var directly — using config only
   * when it is set and a stale literal otherwise — passes every override test in
   * this file. This one fails it, because the sentinel never touches the branch
   * under test.
   */
  it('sends the configured version on the wire with SERVER_VERSION unset', async () => {
    delete process.env.SERVER_VERSION;

    const ua = await userAgentOnWire((base) => ({
      ...base,
      server: { ...base.server, version: SENTINEL },
    }));

    expect(ua).toBe(`bookstack-mcp-server/${SENTINEL}`);
  });

  it('reports the package version from bookstack_server_info with SERVER_VERSION unset', async () => {
    delete process.env.SERVER_VERSION;
    ConfigManager.getInstance().reload();

    // Coincidence-bound while package.json is 1.0.0 — a literal would pass too.
    // It becomes real evidence the moment release-please bumps the package, which
    // is exactly when this must not regress.
    expect((await serverInfo()).version).toBe(pkg.version);
  });
});

describe('version propagation — the SERVER_VERSION override', () => {
  it('is honoured on the wire', async () => {
    process.env.SERVER_VERSION = OVERRIDE;

    const ua = await userAgentOnWire((base) => base);

    expect(OVERRIDE).not.toBe(pkg.version);
    expect(ua).toBe(`bookstack-mcp-server/${OVERRIDE}`);
  });

  it('is honoured by bookstack_server_info', async () => {
    process.env.SERVER_VERSION = OVERRIDE;
    ConfigManager.getInstance().reload();

    expect(OVERRIDE).not.toBe(pkg.version);
    expect((await serverInfo()).version).toBe(OVERRIDE);
  });
});

/**
 * A spelling check, and labelled as one. It cannot see a template literal, a
 * prefixed value like 'bookstack-mcp-server/1.0.0', or a computed one — the
 * behaviour tests above are what cover those. It stays only for the gap behaviour
 * cannot reach today: while package.json says 1.0.0, no runtime assertion can
 * distinguish "reads package.json" from "hard-codes the same string".
 */
describe('version literals', () => {
  it('appear nowhere in src/ except version.ts (spelling check only)', async () => {
    const { Glob } = await import('bun');
    const offenders: string[] = [];

    for await (const file of new Glob('src/**/*.ts').scan('.')) {
      if (file === 'src/version.ts') continue;
      const text = await Bun.file(file).text();
      text.split('\n').forEach((line, i) => {
        if (/['"`]\d+\.\d+\.\d+['"`]/.test(line))
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});

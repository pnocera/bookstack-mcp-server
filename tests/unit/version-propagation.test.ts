import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pkg from '../../package.json' with { type: 'json' };
import { BookStackClient } from '../../src/api/client';
import { ConfigManager } from '../../src/config/manager';
import { ServerInfoTools } from '../../src/tools/server-info';
import type { MCPResource, MCPServerInfo, MCPTool } from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { resetSharedRateLimiters } from '../../src/utils/rateLimit';
import { VERSION } from '../../src/version';
import { startBookStackStub } from '../transport/stub-bookstack';

/**
 * release-please rewrites package.json and nothing else in src/. Every version
 * literal elsewhere therefore survives a release silently: the 2.0.0 tarball would
 * introduce itself as 1.0.0 over MCP initialize, from GET / and from
 * bookstack_server_info — the very identity a client uses to tell the Node-capable
 * 1.0.0 server from the Bun-only 2.0.0 one, in an artifact npm will not let us
 * replace.
 *
 * The whole suite is false-green at this seam while the package still says 1.0.0:
 * a hard-coded '1.0.0' matches the real version by coincidence. So these tests set
 * a version that is deliberately NOT the package's, which is the only way to tell
 * "propagated" from "happens to agree".
 */

const OVERRIDE = '9.8.7-test';

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

describe('version propagation', () => {
  const saved = process.env.SERVER_VERSION;

  beforeEach(() => {
    process.env.BOOKSTACK_API_URL ??= 'http://localhost:6875/api';
    process.env.BOOKSTACK_API_TOKEN ??= 'id:secret';
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SERVER_VERSION;
    else process.env.SERVER_VERSION = saved;
    ConfigManager.getInstance().reload();
  });

  it('defaults to the package version rather than a literal', () => {
    delete process.env.SERVER_VERSION;
    ConfigManager.getInstance().reload();

    expect(VERSION).toBe(pkg.version);
    expect(ConfigManager.getInstance().getConfig().server.version).toBe(pkg.version);
  });

  /**
   * A source scan is a check on ONE SPELLING of the bug, never a substitute for
   * running the consumers — a template literal, a prefixed or computed value, or a
   * constant that quietly stopped honouring SERVER_VERSION all sail past it. An
   * earlier revision of this file leaned on exactly that and was demonstrably
   * false-green: both reads in src/server.ts could be replaced with `1.0.0` and
   * this file stayed green.
   *
   * The behaviour is covered where it happens — MCP initialize in
   * tests/transport/stdio.test.ts, GET / in tests/transport/http.test.ts,
   * bookstack_server_info and the outbound User-Agent below — each driven with a
   * sentinel the source cannot contain.
   *
   * This stays only for what behaviour cannot reach today: while package.json says
   * 1.0.0, no runtime assertion can tell "reads package.json" from "hard-codes the
   * same string". Backticks included, since that is the spelling that got through.
   */
  it('has no version literal anywhere in src/ except version.ts (spelling check only)', async () => {
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

  /**
   * Asserted from the SERVER's side, on a real request.
   *
   * An earlier revision read `axios.defaults.headers['User-Agent']` through a cast.
   * That proves the constructor set a default — not that the default survives to the
   * wire. It does not: a request interceptor can overwrite the header afterwards,
   * and with one added this file still reported all green while the actual request
   * carried a stale version. The BookStack operator sees the wire, so the test does
   * too.
   */
  it('sends the configured version as its outbound User-Agent', async () => {
    const stub = startBookStackStub();
    try {
      process.env.BOOKSTACK_BASE_URL = stub.baseUrl;
      process.env.BOOKSTACK_API_TOKEN = stub.apiToken;
      process.env.SERVER_VERSION = OVERRIDE;
      const cfg = ConfigManager.getInstance().reload();

      const logger = Logger.getInstance();
      const client = new BookStackClient(cfg, logger, new ErrorHandler(logger));
      await client.listBooks();

      const seen = stub.requests.at(-1);
      expect(seen?.path).toBe('/books');
      expect(seen?.userAgent).toBe(`${cfg.server.name}/${OVERRIDE}`);
    } finally {
      await stub.stop();
      delete process.env.BOOKSTACK_BASE_URL;
      resetSharedRateLimiters();
    }
  });

  it('reports the configured version from bookstack_server_info, not a literal', async () => {
    process.env.SERVER_VERSION = OVERRIDE;
    ConfigManager.getInstance().reload();

    // Guards the guard: if this ever equals the package version the assertion
    // below proves nothing.
    expect(OVERRIDE).not.toBe(pkg.version);
    expect((await serverInfo()).version).toBe(OVERRIDE);
  });

  it('agrees across every surface that announces a version', async () => {
    process.env.SERVER_VERSION = OVERRIDE;
    ConfigManager.getInstance().reload();

    // The same value MCP `initialize` and `GET /` hand out (src/server.ts reads
    // config.server.version for both).
    const configured = ConfigManager.getInstance().getConfig().server.version;

    expect(configured).toBe(OVERRIDE);
    expect((await serverInfo()).version).toBe(configured);
  });
});

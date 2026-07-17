import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pkg from '../../package.json' with { type: 'json' };
import { ConfigManager } from '../../src/config/manager';
import { ServerInfoTools } from '../../src/tools/server-info';
import type { MCPResource, MCPServerInfo, MCPTool } from '../../src/types';
import { Logger } from '../../src/utils/logger';
import { VERSION } from '../../src/version';

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
   * The test above cannot see a regression today: package.json says 1.0.0, so a
   * literal '1.0.0' equals the real version by coincidence and every assertion
   * still passes. (Verified: restoring the literal default leaves the suite green.)
   * It only starts biting at 2.0.0 — i.e. one release too late, in an artifact npm
   * will not let us replace.
   *
   * So assert the invariant that does not depend on today's version: src/ contains
   * no version literal at all. version.ts is the one place a version may appear,
   * and it reads package.json.
   */
  it('has no version literal anywhere in src/ except version.ts', async () => {
    const { Glob } = await import('bun');
    const offenders: string[] = [];

    for await (const file of new Glob('src/**/*.ts').scan('.')) {
      if (file === 'src/version.ts') continue;
      const text = await Bun.file(file).text();
      text.split('\n').forEach((line, i) => {
        if (/['"]\d+\.\d+\.\d+['"]/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
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

/**
 * Docker smoke tests: the built image, actually started.
 *
 * Why this file exists. CI used to `docker build` and stop there, so an image whose
 * command, user, working directory or configuration could not start at all still went
 * green - a build proves the layers assemble, not that anything runs. These tests start
 * the image and speak to it over a published port.
 *
 * No live BookStack. BOOKSTACK_BASE_URL deliberately points at a closed port inside the
 * container, so `/health` is expected to be 503: that is asserted as the true outcome
 * rather than avoided. Everything checked here - the HTTP transport coming up, the fail-
 * closed auth startup, bearer enforcement and `tools/list` - is reachable without any
 * BookStack behind it, because the MCP surface itself does not need one.
 *
 * Gating: skipped unless RUN_DOCKER_SMOKE=1, so `bun test` on a machine with no Docker
 * (and the fast unit job in CI) stays green and quick. CI's docker job builds the image
 * and then runs this suite with the flag set.
 *
 *   docker build -t bookstack-mcp-server:ci .
 *   RUN_DOCKER_SMOKE=1 bun test tests/transport/docker-smoke.test.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';

const SMOKE_ENABLED = ['1', 'true'].includes(process.env.RUN_DOCKER_SMOKE ?? '');
/** Tag CI builds. Overridable so the suite can smoke any locally built image. */
const IMAGE = process.env.DOCKER_SMOKE_IMAGE ?? 'bookstack-mcp-server:ci';

/** Dummy credentials: syntactically valid, pointing nowhere. */
const MCP_AUTH_TOKEN = 'docker-smoke-inbound-secret';
const BOOKSTACK_API_TOKEN = 'docker-smoke-id:docker-smoke-secret';
/** Port 9 (discard) inside the container: reliably closed, so health fails fast. */
const UNREACHABLE_BOOKSTACK = 'http://127.0.0.1:9/api';

/** How long to wait for the container's HTTP transport to answer. */
const STARTUP_TIMEOUT_MS = 45_000;

if (!SMOKE_ENABLED) {
  console.log(
    '[docker] RUN_DOCKER_SMOKE unset - skipping image smoke tests.\n' +
      `[docker] To run them: docker build -t ${IMAGE} . && ` +
      'RUN_DOCKER_SMOKE=1 bun test tests/transport/docker-smoke.test.ts'
  );
}

interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a docker CLI command to completion and capture both streams. */
async function docker(args: string[]): Promise<DockerResult> {
  const proc = Bun.spawn({ cmd: ['docker', ...args], stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const started: string[] = [];

/** Start the image detached, without waiting for it to serve anything. */
async function runDetached(env: Record<string, string>): Promise<string> {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  // No --rm: the exit code and logs have to outlive the process to be assertable.
  const run = await docker(['run', '-d', ...envArgs, IMAGE]);
  if (run.exitCode !== 0) {
    throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  }
  const id = run.stdout.trim();
  started.push(id);
  return id;
}

/**
 * Wait up to `timeoutMs` for a container to exit and report its exit code.
 *
 * Returns `undefined` if it is still running at the deadline. That is a real outcome, not
 * an error: a server expected to fail closed but still happily listening is exactly the
 * bug the caller is testing for, and it deserves an assertion rather than a timeout.
 *
 * The state is always read at least once, so `timeoutMs: 0` means "is it dead right now?".
 */
async function waitForExit(id: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await docker(['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', id]);
    const [running, code] = state.stdout.trim().split(' ');
    if (running === 'false') {
      return Number(code);
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await Bun.sleep(200);
  }
}

/** Exit status plus logs for a container, for failure messages worth reading. */
async function describeContainer(id: string): Promise<string> {
  const state = await docker(['inspect', '-f', '{{.State.Status}} (exit {{.State.ExitCode}})', id]);
  const logs = await docker(['logs', id]);
  return (
    `state: ${state.stdout.trim() || state.stderr.trim()}\n` +
    `logs (stdout):\n${logs.stdout}\nlogs (stderr):\n${logs.stderr}`
  );
}

/**
 * Start the image detached, publish its port on loopback, and wait until it answers.
 *
 * The port is published as `127.0.0.1::3000` so the host picks a free one - a fixed port
 * would make the suite collide with anything already listening, including a previous run.
 */
async function startContainer(env: Record<string, string>): Promise<{ url: string; id: string }> {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const run = await docker(['run', '-d', '-p', '127.0.0.1::3000', ...envArgs, IMAGE]);
  if (run.exitCode !== 0) {
    throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  }
  const id = run.stdout.trim();
  started.push(id);

  const port = await docker(['port', id, '3000/tcp']);
  // e.g. "127.0.0.1:49155" (and possibly a second IPv6 line).
  const mapped = port.stdout.split('\n')[0]?.trim().split(':').pop();
  if (!mapped) {
    // Usually means the container already exited - a broken CMD, or a config error the
    // server fails closed on. Its own logs say which, so surface them instead of the
    // "no public port" message docker leaves behind.
    throw new Error(
      `container ${id} published no port for 3000/tcp; it likely exited at startup.\n` +
        `${await describeContainer(id)}`
    );
  }
  const url = `http://127.0.0.1:${mapped}`;

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/`);
      if (response.ok) {
        return { url, id };
      }
    } catch {
      // Not listening yet - or dead. Tell those apart rather than waiting out the whole
      // timeout on a container that has already given up.
      const exitCode = await waitForExit(id, 0);
      if (exitCode !== undefined) {
        throw new Error(
          `container ${id} exited (code ${exitCode}) instead of serving ${url}.\n` +
            `${await describeContainer(id)}`
        );
      }
    }
    await Bun.sleep(250);
  }

  throw new Error(
    `container ${id} never answered on ${url} within ${STARTUP_TIMEOUT_MS}ms.\n` +
      `${await describeContainer(id)}`
  );
}

afterAll(async () => {
  await Promise.all(started.splice(0).map((id) => docker(['rm', '-f', id])));
});

describe.skipIf(!SMOKE_ENABLED)('built image', () => {
  it(
    'refuses to start the HTTP transport without MCP_AUTH_TOKEN',
    async () => {
      // Fail-closed, verified on the artefact that actually ships. A container that keeps
      // listening here would be an open proxy to the operator's BookStack admin token.
      const id = await runDetached({
        BOOKSTACK_BASE_URL: UNREACHABLE_BOOKSTACK,
        BOOKSTACK_API_TOKEN,
        // MCP_AUTH_TOKEN deliberately absent.
      });

      const exitCode = await waitForExit(id, 20_000);

      // Named rather than inlined so a still-running container reports as "it did not
      // exit", instead of as a bare test timeout that says nothing about why.
      expect(
        exitCode,
        `container did not exit; it is still serving.\n${await describeContainer(id)}`
      ).toBeDefined();
      expect(exitCode).not.toBe(0);
      expect(await describeContainer(id)).toContain('MCP_AUTH_TOKEN is not set');
    },
    STARTUP_TIMEOUT_MS
  );

  it(
    'starts and serves its root endpoint with the required credentials',
    async () => {
      // The check a `docker build` cannot make: the CMD, the non-root `bun` user, the
      // working directory and the copied source all have to be right for this to answer.
      const { url } = await startContainer({
        BOOKSTACK_BASE_URL: UNREACHABLE_BOOKSTACK,
        BOOKSTACK_API_TOKEN,
        MCP_AUTH_TOKEN,
      });

      const response = await fetch(`${url}/`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'running', mcp: true });
    },
    STARTUP_TIMEOUT_MS + 15_000
  );

  it(
    'enforces bearer auth and serves tools/list from the container',
    async () => {
      const { url } = await startContainer({
        BOOKSTACK_BASE_URL: UNREACHABLE_BOOKSTACK,
        BOOKSTACK_API_TOKEN,
        MCP_AUTH_TOKEN,
      });
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };

      const anonymous = await fetch(`${url}/message`, { method: 'POST', headers, body });
      expect(anonymous.status).toBe(401);

      // tools/list needs no BookStack, so this is a genuine end-to-end check of the
      // shipped MCP surface even with nothing behind it.
      const authenticated = await fetch(`${url}/message`, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${MCP_AUTH_TOKEN}` },
        body,
      });

      expect(authenticated.status).toBe(200);
      const payload = (await authenticated.json()) as {
        result?: { tools?: Array<{ name: string }> };
      };
      expect(payload.result?.tools).toHaveLength(56);
    },
    STARTUP_TIMEOUT_MS + 15_000
  );

  it(
    'reports unhealthy while BookStack is unreachable',
    async () => {
      // Asserting what is true rather than what is convenient: /health probes BookStack,
      // and there is deliberately none here, so 503 is the correct answer. The point is
      // that the probe is served at all - unauthenticated, and with tools loaded.
      const { url } = await startContainer({
        BOOKSTACK_BASE_URL: UNREACHABLE_BOOKSTACK,
        BOOKSTACK_API_TOKEN,
        MCP_AUTH_TOKEN,
      });

      const response = await fetch(`${url}/health`);

      expect(response.status).toBe(503);
      const health = (await response.json()) as {
        status?: string;
        checks?: Array<{ name: string; healthy: boolean }>;
      };
      expect(health.status).toBe('unhealthy');
      // The BookStack check is the only one that may fail: the image itself is fine.
      const byName = new Map(health.checks?.map((check) => [check.name, check.healthy]));
      expect(byName.get('bookstack_connection')).toBe(false);
      expect(byName.get('tools_loaded')).toBe(true);
      expect(byName.get('resources_loaded')).toBe(true);
    },
    STARTUP_TIMEOUT_MS + 30_000
  );

  it(
    'runs the same Bun version that validated the code',
    async () => {
      // The Dockerfile used to track the floating `oven/bun:1-alpine` tag while CI pinned
      // one version, so a base-tag move could ship an image running a Bun the quality job
      // never exercised. Comparing against the *running* Bun rather than a literal keeps
      // the check honest with no fourth copy of the version to forget: in CI that is the
      // interpreter pinned by .github/workflows/ci.yml, which is precisely the claim.
      const result = await docker(['run', '--rm', '--entrypoint', 'bun', IMAGE, '--version']);

      expect(result.exitCode).toBe(0);
      expect(
        result.stdout.trim(),
        "The image's Bun and the Bun running this suite disagree. Bump them together: " +
          'the BUN_VERSION in .github/workflows/ci.yml and the BUN_IMAGE pin in the Dockerfile.'
      ).toBe(process.versions.bun);
    },
    STARTUP_TIMEOUT_MS
  );
});

/**
 * Transport tests: the real Express app, driven over real HTTP.
 *
 * Why this file exists. Every other suite calls tool handlers directly, so nothing
 * crossed the HTTP boundary - and an `express.json()` with no limit shipped behind a
 * green suite, capping every inline upload at Express's ~100 KB default while the tool
 * schemas advertised 50,000 KB. The tests here therefore start the actual app from
 * createHttpApp() and speak to it with fetch(): middleware order, status codes and the
 * body ceiling are the subject, not mocks of them.
 *
 * No live BookStack. BOOKSTACK_BASE_URL points at a closed port, and every assertion
 * below is about the transport: MCP `initialize` and the auth/parse layers never touch
 * BookStack. `bun test` stays green with no Docker running.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type Config,
  ConfigManager,
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  type HttpTransportConfig,
  loadHttpTransportConfig,
} from '../../src/config/manager';
import { BookStackMCPServer, createHttpApp, HEALTH_CHECK_FAILED_MESSAGE } from '../../src/server';
import { Logger } from '../../src/utils/logger';
import { resetSharedRateLimiters } from '../../src/utils/rateLimit';

/** Port 9 is the discard service: reliably closed, so BookStack calls fail fast. */
const UNREACHABLE_BOOKSTACK = 'http://127.0.0.1:9/api';
const TEST_AUTH_TOKEN = 'test-inbound-secret-0123456789';

/**
 * Env keys this suite pins. ConfigManager is a process-wide singleton and bun runs test
 * files in one process, so the originals are restored in afterAll to keep neighbouring
 * suites (notably tests/integration/system.test.ts, which reload()s the same singleton)
 * on the environment they expect.
 */
const PINNED_ENV = [
  'BOOKSTACK_BASE_URL',
  'BOOKSTACK_API_TOKEN',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'RATE_LIMIT_REQUESTS_PER_MINUTE',
  'RATE_LIMIT_BURST_LIMIT',
] as const;

const savedEnv = new Map<string, string | undefined>();
let config: Config;

function setEnv(key: string, value: string): void {
  process.env[key] = value;
}

function restoreEnv(key: string): void {
  const value = savedEnv.get(key);
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** Put the environment back the way the file-level beforeAll left it, and reload. */
function restoreSuiteEnv(): void {
  setEnv('BOOKSTACK_BASE_URL', UNREACHABLE_BOOKSTACK);
  delete process.env.RATE_LIMIT_REQUESTS_PER_MINUTE;
  delete process.env.RATE_LIMIT_BURST_LIMIT;
  config = ConfigManager.getInstance().reload();
}

beforeAll(() => {
  for (const key of PINNED_ENV) {
    savedEnv.set(key, process.env[key]);
  }

  // A syntactically valid token pointing nowhere: BookStackMCPServer (built per request
  // by the /message handler, and by /health) parses config through ConfigManager, which
  // rejects an empty API token.
  setEnv('BOOKSTACK_BASE_URL', UNREACHABLE_BOOKSTACK);
  setEnv('BOOKSTACK_API_TOKEN', 'transport-test-id:transport-test-secret');
  setEnv('LOG_LEVEL', 'error');
  setEnv('LOG_FORMAT', 'json');

  // reload() rather than getConfig(): another suite may have already populated the
  // singleton from a live stack.
  config = ConfigManager.getInstance().reload();
});

afterAll(() => {
  for (const key of PINNED_ENV) {
    restoreEnv(key);
  }
  try {
    ConfigManager.getInstance().reload();
  } catch {
    // The restored environment may not validate on its own (e.g. no BOOKSTACK_API_TOKEN
    // in a plain `bun test`). That is the state we found it in, so leave it there.
  }
});

/** Everything `body` returned, plus everything the process wrote while it ran. */
interface Captured<T> {
  result: T;
  stdout: string;
  stderr: string;
}

/**
 * Run `body` with this process's stdout and stderr captured.
 *
 * A leak assertion that only reads the HTTP response is half a test: the same refusal is
 * also rendered into an exception message and written to the log on the way out, and under
 * the stdio transport stdout is the MCP stream itself. Both streams are patched at the
 * `write` method, which is what Winston, `console.*` and a raw throw all end up calling.
 */
function captureStdio<T>(body: () => T): Captured<T> {
  let stdout = '';
  let stderr = '';
  const realStdout = process.stdout.write;
  const realStderr = process.stderr.write;

  const record = (sink: (text: string) => void): typeof process.stdout.write =>
    ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      sink(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      // write()'s callback may be the second or third argument. Invoke whichever one is a
      // function, so nothing is left waiting on a drain that would never come.
      for (const arg of rest) {
        if (typeof arg === 'function') {
          (arg as () => void)();
        }
      }
      return true;
    }) as typeof process.stdout.write;

  process.stdout.write = record((text) => {
    stdout += text;
  });
  process.stderr.write = record((text) => {
    stderr += text;
  });

  try {
    return { result: body(), stdout, stderr };
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  }
}

/** A listening app plus the base URL to reach it on. */
interface RunningApp {
  url: string;
  server: Server;
}

const running: Server[] = [];

/** Start an app on an ephemeral loopback port. Closed automatically after each test. */
async function startApp(
  http: HttpTransportConfig,
  appConfig: Config = config
): Promise<RunningApp> {
  const app = createHttpApp({ config: appConfig, http });

  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  running.push(server);

  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, server };
}

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

/** POST a raw body to /message, mirroring what an MCP client sends. */
async function postMessage(
  url: string,
  body: string,
  options: { authToken?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // The Streamable HTTP transport requires both media types on POST.
    accept: 'application/json, text/event-stream',
  };
  if (options.authToken !== undefined) {
    headers.authorization = `Bearer ${options.authToken}`;
  }

  return fetch(`${url}/message`, { method: 'POST', headers, body });
}

/**
 * A valid MCP `initialize` request, padded to `padBytes` of base64-ish filler.
 *
 * `initialize` is the cheapest request that proves real dispatch: the SDK answers it
 * from the server's own capabilities without any BookStack call, so a 200 with a
 * serverInfo result means the body crossed the parser and reached MCP.
 */
function initializeRequest(padBytes = 0): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'transport-test', version: '1.0.0', padding: 'A'.repeat(padBytes) },
    },
  });
}

/**
 * A `tools/call` request. Unlike `initialize`, this one reaches BookStack - which is the
 * point: it is the cheapest proof that a real tool dispatched and spent an outbound token.
 * The stateless transport accepts it without a prior `initialize` handshake.
 */
function callToolRequest(name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

describe('HTTP transport configuration', () => {
  it('defaults the body limit to 70 MiB when HTTP_BODY_LIMIT is unset', () => {
    // Guards the trap called out in manager.ts: a default computed in loadConfig()
    // (`parseInt(env.X || '...')`) shadows the schema `.default()`, so the schema
    // becomes decoration. Here the empty env must fall through to the schema.
    const http = loadHttpTransportConfig({});

    expect(http.bodyLimitBytes).toBe(DEFAULT_HTTP_BODY_LIMIT_BYTES);
    expect(http.bodyLimitBytes).toBe(73_400_320);
    // 50,000 KB of source data, base64-encoded, must fit inside the default with room
    // for the JSON-RPC envelope - that is the whole point of the number.
    expect(http.bodyLimitBytes).toBeGreaterThan(Math.ceil((50_000 * 1024) / 3) * 4);
  });

  it('honours an explicit HTTP_BODY_LIMIT', () => {
    expect(loadHttpTransportConfig({ HTTP_BODY_LIMIT: '1048576' }).bodyLimitBytes).toBe(1_048_576);
  });

  it('rejects an unparseable HTTP_BODY_LIMIT instead of silently defaulting', () => {
    expect(() => loadHttpTransportConfig({ HTTP_BODY_LIMIT: '70mb' })).toThrow(/HTTP_BODY_LIMIT/);
    expect(() => loadHttpTransportConfig({ HTTP_BODY_LIMIT: '-1' })).toThrow(
      /HTTP transport configuration/
    );
  });

  it('reads MCP_AUTH_TOKEN, treating blank as unset', () => {
    expect(loadHttpTransportConfig({ MCP_AUTH_TOKEN: '  s3cret  ' }).authToken).toBe('s3cret');
    // docker-compose passes `${MCP_AUTH_TOKEN:-}`, i.e. '' when the operator set nothing.
    expect(loadHttpTransportConfig({ MCP_AUTH_TOKEN: '' }).authToken).toBeUndefined();
    expect(loadHttpTransportConfig({}).authToken).toBeUndefined();
  });
});

describe('GET / identity', () => {
  /**
   * The other surface that announces a version (MCP `initialize` is asserted in
   * stdio.test.ts). release-please rewrites only package.json, so a literal here
   * would survive a release and the 2.0.0 tarball would report 1.0.0 from an
   * artifact npm cannot replace.
   *
   * The sentinel is deliberately NOT the package's own version: while package.json
   * says 1.0.0, asserting package.json#version passes just as happily against a
   * hard-coded '1.0.0'. Driving the real route with a value the source cannot
   * contain is what makes the assertion mean something.
   */
  it('reports the configured version, not a literal', async () => {
    setEnv('SERVER_VERSION', '9.8.7-sentinel');
    const appConfig = ConfigManager.getInstance().reload();
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );

    const body = (await (await fetch(`${url}/`)).json()) as { version?: string };

    expect(body.version).toBe('9.8.7-sentinel');

    restoreEnv('SERVER_VERSION');
    config = ConfigManager.getInstance().reload();
  });
});

describe('HTTP transport startup', () => {
  it('fails closed when MCP_AUTH_TOKEN is unset', () => {
    // No app is built at all, so "unset" can never degrade into "no auth required".
    expect(() =>
      createHttpApp({ config, http: { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES } })
    ).toThrow(/MCP_AUTH_TOKEN is not set/);
  });

  it('starts once MCP_AUTH_TOKEN is present', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    expect((await fetch(`${url}/`)).status).toBe(200);
  });
});

/**
 * A base URL this server can never serve traffic with, and the secrets it would leak.
 *
 * `canonicalBaseUrl()` refuses all three placements, because each is unbounded free text on
 * the outbound identity - and each is somewhere a credential really does get written by
 * hand. The markers are unique strings, so any path that echoes the configured URL anywhere
 * - response body, exception message, log line, stdout - names itself.
 *
 * WHY EVERY PROBE NOW CARRIES A SECOND MARKER, IN ITS PATH.
 *
 * R6-W3, and it is a lesson about how this table was built rather than about the code it
 * tests. Every probe here used to put its marker in the component being REFUSED, and a
 * harmless `/api` path. So the table could only ever prove the thing it was written to
 * prove - "userinfo, query and fragment are dropped" - and was structurally blind to the
 * claim that actually mattered: that the rest of the value is not quoted either. It was not.
 * The refusal named `scheme://host/path`, on the reasoning that those three "can never hold
 * a credential", and a path holds whatever the deployment put there - including the
 * capability token of a reverse proxy.
 *
 * So each probe carries a marker in a component the refusal is NOT about, and `markers`
 * is asserted as a whole. A test that can only see what it was aimed at is how a leak
 * survives five rounds of review.
 */
interface UnusableBaseUrl {
  where: string;
  url: string;
  markers: readonly string[];
}

const UNUSABLE_BASE_URLS: readonly UnusableBaseUrl[] = [
  {
    where: 'userinfo',
    url: 'https://svc:userinfo-leak-marker@books.example/userinfo-path-marker/api',
    markers: ['userinfo-leak-marker', 'userinfo-path-marker'],
  },
  {
    // Codex's R5-W2 probe, verbatim: this exact value came back from an unauthenticated
    // GET /health, credential and all. The path marker is R6-W3's addition to it.
    where: 'query',
    url: 'https://books.example/query-path-marker/api?api_token=health-leak-marker',
    markers: ['health-leak-marker', 'query-path-marker'],
  },
  {
    where: 'fragment',
    url: 'https://books.example/fragment-path-marker/api#fragment-leak-marker',
    markers: ['fragment-leak-marker', 'fragment-path-marker'],
  },
  {
    // A scheme this server cannot speak, with the marker in neither the scheme nor a
    // credential field - just the ordinary text of the value.
    where: 'scheme',
    url: 'ftp://books.example/scheme-path-marker/api',
    markers: ['scheme-path-marker'],
  },
];

describe('an unusable configured base URL fails before the server listens', () => {
  // R5-W2, which was fallout from the round-4 alias fix rather than an original bug.
  // canonicalBaseUrl() started refusing userinfo/query/fragment, but ConfigSchema kept
  // accepting any syntactically valid URL - so the process booted and bound a port with a
  // base URL it could never build a client from, and the first anonymous /health request
  // constructed that client, caught the refusal, and returned its message verbatim.

  it('refuses to load a configuration whose BOOKSTACK_BASE_URL carries userinfo, a query or a fragment', () => {
    try {
      for (const probe of UNUSABLE_BASE_URLS) {
        setEnv('BOOKSTACK_BASE_URL', probe.url);

        const captured = captureStdio(() => {
          try {
            ConfigManager.getInstance().reload();
            return undefined;
          } catch (error) {
            return error as Error;
          }
        });

        // Nothing is constructed, nothing binds a port: the process dies at config load,
        // which is the only stage where "this can never work" is cheap to say.
        expect(captured.result).toBeDefined();
        expect(captured.result?.message).toContain('Configuration validation failed');
        expect(captured.result?.message).toContain('bookstack.baseUrl');

        for (const marker of probe.markers) {
          // The refusal must not become the leak - not in the message an operator sees...
          expect(captured.result?.message, `${probe.where}: ${marker}`).not.toContain(marker);
          // ...and not in the line ConfigManager logs on its way out, on either stream.
          //
          // Marker absence, not stream emptiness. Which stream the logger writes to (stderr,
          // because under stdio stdout is the MCP JSON-RPC stream) is src/utils/logger.ts's
          // property and its own suite's to prove; asserting it here only couples this test
          // to that file. What this fix owns is the part asserted: no marker reaches either
          // stream, because canonicalBaseUrl() never puts ANY part of the refused value in
          // the message for anything to log in the first place.
          expect(captured.stderr, `${probe.where}: ${marker}`).not.toContain(marker);
          expect(captured.stdout, `${probe.where}: ${marker}`).not.toContain(marker);
        }
      }
    } finally {
      restoreSuiteEnv();
    }
  });

  it('accepts the base URLs that ARE usable, so the rule is not just "reject everything"', () => {
    // The control. Without it, a schema that refused every URL would pass the test above.
    try {
      for (const usable of [
        'http://127.0.0.1:6875/api',
        'https://books.example.com/api',
        'https://books.example.com:8443/api/',
        'http://books.example.com/x/../api',
      ]) {
        setEnv('BOOKSTACK_BASE_URL', usable);
        expect(ConfigManager.getInstance().reload().bookstack.baseUrl).toBe(usable);
      }
    } finally {
      restoreSuiteEnv();
    }
  });

  it('refuses to build the HTTP app on such a URL, so there is nothing to listen with', () => {
    // The second half of the same rule, for callers that build a Config by hand and never
    // cross the schema. createHttpApp() returning nothing is what makes the failure strictly
    // earlier than listen(): startHttpServer() cannot reach app.listen() without an app.
    for (const probe of UNUSABLE_BASE_URLS) {
      const appConfig: Config = {
        ...config,
        bookstack: { ...config.bookstack, baseUrl: probe.url },
      };

      const captured = captureStdio(() => {
        try {
          createHttpApp({
            config: appConfig,
            http: { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
          });
          return undefined;
        } catch (error) {
          return error as Error;
        }
      });

      expect(captured.result).toBeDefined();
      expect(captured.result?.message).toContain('BookStack base URL');
      for (const marker of probe.markers) {
        expect(captured.result?.message, `${probe.where}: ${marker}`).not.toContain(marker);
        expect(captured.stderr, `${probe.where}: ${marker}`).not.toContain(marker);
        expect(captured.stdout, `${probe.where}: ${marker}`).not.toContain(marker);
      }
    }
  });

  it('never logs the path of an ACCEPTED base URL when a server is constructed', () => {
    // The other half of R6-W3, and the one that needs nothing to go wrong. An arbitrary
    // reverse-proxy mount is a legitimate deployment, so this URL is ACCEPTED - and building
    // a server logs `BookStack API client initialized` and `BookStack MCP Server initialized`
    // at `info`, the default level. Both used to render `baseUrl` in full, and the redactor
    // keeps a URL's path on purpose, so the capability went to the operator's log with no
    // failure, no attacker and no unusual configuration involved.
    //
    // Constructed directly because that is where the leak was: under this transport a
    // BookStackMCPServer is built per POST /message, so those two lines are written for
    // every single request rather than once at boot.
    const marker = 'accepted-path-capability-marker';

    // This suite pins LOG_LEVEL=error so that its own noise stays out of the way, and the
    // two lines under test are `info` - the DEFAULT level, which is the entire reason this
    // leak mattered. So the level is raised for the duration: a marker test that runs with
    // the logger switched off is the purest form of false green there is.
    const logger = Logger.getInstance();
    const pinnedOptions = logger.getOptions();
    logger.configure({ level: 'info', format: 'json' });

    const captured = (() => {
      try {
        return captureStdio(() => {
          new BookStackMCPServer({
            bookstack: { ...config.bookstack, baseUrl: `https://books.example/${marker}/api` },
          });
          return undefined;
        });
      } finally {
        logger.configure(pinnedOptions);
      }
    })();

    expect(captured.stderr, 'the base URL path must not reach stderr').not.toContain(marker);
    expect(captured.stdout, 'the base URL path must not reach stdout').not.toContain(marker);

    // THE CONTROL. Without it, the two assertions above pass on a server that logs nothing
    // at all, which is the failure mode this whole review round warns about. The lines were
    // really written, and they still say which upstream this client is pointed at - the
    // fact an operator is actually reading them for.
    expect(captured.stderr).toContain('BookStack API client initialized');
    expect(captured.stderr).toContain('https://books.example');
    // ...and the shape of the mount, in place of the mount itself.
    expect(captured.stderr).toContain('base_path_segments');
    expect(captured.stderr).toContain('base_path_digest');
  });

  it('never answers the unauthenticated /health with caught exception text', async () => {
    // The response-side half. An unusable base URL can no longer reach this route, but the
    // route must not be the kind of route that echoes exceptions in the first place - that
    // property is what made a configuration mistake into a credential disclosure.
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const realGetHealth = BookStackMCPServer.prototype.getHealth;
    // The message the route used to hand back to anonymous callers, word for word.
    BookStackMCPServer.prototype.getHealth = (): Promise<never> =>
      Promise.reject(
        new Error(
          "BookStack base URL 'https://books.example/api?api_token=health-leak-marker' " +
            'must not carry a query string or fragment; it is a base, not a request.'
        )
      );

    try {
      const response = await fetch(`${url}/health`);
      const text = await response.text();

      expect(response.status).toBe(503);
      expect(text).not.toContain('health-leak-marker');
      expect(text).not.toContain('api_token');
      const payload = JSON.parse(text) as { status?: string; error?: string };
      expect(payload.status).toBe('unhealthy');
      // A fixed public reason: it does not pretend to have checked BookStack and found it
      // wanting either.
      expect(payload.error).toBe(HEALTH_CHECK_FAILED_MESSAGE);
    } finally {
      BookStackMCPServer.prototype.getHealth = realGetHealth;
    }
  }, 15_000);

  it('still refuses a request-scoped x-bookstack-url override, inside authenticated /message', async () => {
    // The rule has to keep binding where it originally did. `x-bookstack-url` never sees the
    // config schema, so moving the check to startup must not have moved it off this path -
    // and this path must not leak the override either.
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await fetch(`${url}/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
        'x-bookstack-url': 'https://books.example/api?api_token=override-leak-marker',
      },
      body: callToolRequest('bookstack_books_list', { count: 1 }),
    });
    const text = await response.text();

    // Refused inside the authenticated route, where an authenticated caller's own mistake
    // belongs - not at startup, and not by being forwarded to axios.
    expect(response.status).toBe(500);
    expect(text).not.toContain('override-leak-marker');
    expect(text).not.toContain('books.example');
  }, 15_000);
});

describe('POST /message body limit', () => {
  it('accepts and dispatches a body far larger than express.json()"s ~100KB default', async () => {
    // B1 regression guard. 150,000 bytes of padding puts the body well past Express's
    // ~100 KB default, which is what an inline base64 upload looks like. Against
    // `express.json()` with no limit this returns 413 before MCP ever sees the request.
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });
    const body = initializeRequest(150_000);
    expect(body.length).toBeGreaterThan(100 * 1024);

    const response = await postMessage(url, body, { authToken: TEST_AUTH_TOKEN });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
    // Proof of dispatch, not merely of parsing: MCP answered from the server itself.
    expect(payload.result?.serverInfo?.name).toBe(config.server.name);
  });

  it("applies the configured ceiling, not Express's default, below it", async () => {
    // Brackets the ceiling from underneath: 150 KB sits above Express's ~100 KB default
    // but below the 200 KiB configured here, so only a parser actually wired to
    // bodyLimitBytes accepts it.
    const { url } = await startApp({ bodyLimitBytes: 200 * 1024, authToken: TEST_AUTH_TOKEN });

    const response = await postMessage(url, initializeRequest(150_000), {
      authToken: TEST_AUTH_TOKEN,
    });

    expect(response.status).toBe(200);
  });

  it('rejects a body above the configured ceiling with a JSON 413', async () => {
    const limitBytes = 200 * 1024;
    const { url } = await startApp({ bodyLimitBytes: limitBytes, authToken: TEST_AUTH_TOKEN });

    const response = await postMessage(url, initializeRequest(300_000), {
      authToken: TEST_AUTH_TOKEN,
    });

    expect(response.status).toBe(413);
    // A JSON error, not Express's default HTML stack trace.
    expect(response.headers.get('content-type')).toContain('application/json');
    const payload = (await response.json()) as {
      error?: string;
      message?: string;
      limitBytes?: number;
    };
    expect(payload.error).toBe('Payload Too Large');
    expect(payload.limitBytes).toBe(limitBytes);
    expect(payload.message).toContain('HTTP_BODY_LIMIT');
  });

  it('answers malformed JSON with a clean 400', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await postMessage(url, '{"jsonrpc": "2.0",', { authToken: TEST_AUTH_TOKEN });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(((await response.json()) as { error?: string }).error).toBe('Bad Request');
  });
});

describe('POST /message authentication', () => {
  it('rejects a request with no credentials', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await postMessage(url, initializeRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    const payload = (await response.json()) as { error?: string; message?: string };
    expect(payload.error).toBe('Unauthorized');
    // The challenge must not disclose the secret it is checking against.
    expect(JSON.stringify(payload)).not.toContain(TEST_AUTH_TOKEN);
  });

  it('rejects a request with the wrong credentials', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await postMessage(url, initializeRequest(), { authToken: 'not-the-secret' });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error?: string }).error).toBe('Unauthorized');
  });

  it('rejects a near-miss credential (prefix of the real secret)', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await postMessage(url, initializeRequest(), {
      authToken: TEST_AUTH_TOKEN.slice(0, -1),
    });

    expect(response.status).toBe(401);
  });

  it('accepts the correct credentials and dispatches', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await postMessage(url, initializeRequest(), { authToken: TEST_AUTH_TOKEN });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(payload.result?.serverInfo?.name).toBe(config.server.name);
  });

  it('authenticates before parsing the body', async () => {
    // Ordering proof. The ceiling is 1 KiB and the body is ~100 KB, so a parser placed
    // ahead of the auth check would answer 413 - it would have had to read the body to
    // know. 401 means we refused on the header alone, buffering nothing.
    const { url } = await startApp({ bodyLimitBytes: 1024, authToken: TEST_AUTH_TOKEN });
    const body = initializeRequest(100_000);
    expect(body.length).toBeGreaterThan(1024);

    const response = await postMessage(url, body);

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error?: string }).error).toBe('Unauthorized');
  });
});

describe('unauthenticated endpoints', () => {
  it('serves GET / without credentials and leaks nothing sensitive', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await fetch(`${url}/`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ status: 'running', mcp: true });
    expect(text).not.toContain(TEST_AUTH_TOKEN);
    expect(text).not.toContain(config.bookstack.apiToken);
    expect(text).not.toContain(config.bookstack.baseUrl);
  });

  it('serves GET /health without credentials and leaks nothing sensitive', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await fetch(`${url}/health`);
    const text = await response.text();

    // 503: BookStack is deliberately unreachable here. The point is that the probe is
    // answered at all rather than challenged for credentials.
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ status: 'unhealthy' });
    expect(text).not.toContain(TEST_AUTH_TOKEN);
    expect(text).not.toContain(config.bookstack.apiToken);
  }, 15_000);

  it('answers an unknown route with a JSON 404', async () => {
    const { url } = await startApp({
      bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
    });

    const response = await fetch(`${url}/nope`);

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error?: string }).error).toBe('Not Found');
  });
});

/* ------------------------------------------------------------- a stub BookStack -- */

/**
 * Just enough BookStack to count what this server sent it.
 *
 * The suites below are about what crosses the boundary - how many upstream calls a burst of
 * HTTP requests turns into - so the upstream has to be observable, and `/system` has to be
 * holdable: a check that returns instantly cannot show whether callers coalesced onto it or
 * merely took turns.
 */
interface StubUpstream {
  baseUrl: string;
  /** How many readiness checks (`GET /system`) actually left this process. */
  readonly systemCalls: number;
  /** Every non-/system path that arrived, i.e. real tool traffic. */
  readonly toolCalls: string[];
  /** Hold every subsequent /system response open until release(). */
  hold(): void;
  release(): void;
  reset(): void;
  stop(): void;
}

function startStubUpstream(): StubUpstream {
  const state = { systemCalls: 0, toolCalls: [] as string[] };
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;

      if (path === '/api/system') {
        state.systemCalls += 1;
        if (gate) {
          await gate;
        }
        return Response.json({ version: '26.05.2', instance_id: 'stub' });
      }

      state.toolCalls.push(path);
      return Response.json({ data: [], total: 0 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/api`,
    get systemCalls() {
      return state.systemCalls;
    },
    get toolCalls() {
      return state.toolCalls;
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
      gate = undefined;
      open = undefined;
    },
    reset() {
      state.systemCalls = 0;
      state.toolCalls.length = 0;
      gate = undefined;
      open = undefined;
    },
    stop() {
      server.stop(true);
    },
  };
}

/**
 * Point the whole process at `baseUrl` with the given outbound limits.
 *
 * `ConfigManager` is a singleton and `BookStackMCPServer` reads it for everything but the
 * BookStack block, so the limits have to be set the way an operator sets them - through the
 * environment - and reloaded.
 */
function reconfigure(baseUrl: string, burstLimit: number, requestsPerMinute: number): Config {
  setEnv('BOOKSTACK_BASE_URL', baseUrl);
  setEnv('RATE_LIMIT_BURST_LIMIT', String(burstLimit));
  setEnv('RATE_LIMIT_REQUESTS_PER_MINUTE', String(requestsPerMinute));
  config = ConfigManager.getInstance().reload();
  return config;
}

describe('outbound rate limiting across HTTP requests', () => {
  let upstream: StubUpstream;

  beforeAll(() => {
    upstream = startStubUpstream();
  });

  afterAll(() => {
    upstream.stop();
    restoreSuiteEnv();
    resetSharedRateLimiters();
  });

  beforeEach(() => {
    upstream.reset();
    // The registry is process-wide by design, so a neighbouring test's spent tokens would
    // otherwise be this one's problem.
    resetSharedRateLimiters();
  });

  it('queues the second tools/call when the burst allowance is 1', async () => {
    // R3-W2 through the real route, which is where it was reported and where no test looked.
    // `POST /message` builds a fresh BookStackMCPServer, and so a fresh BookStackClient, per
    // request; when the bucket belonged to that client, every RPC arrived with a full one and
    // RATE_LIMIT_* bounded nothing at all. The existing transport tests all run wide-open
    // limits and assert no timing, so they cannot see this either way.
    const appConfig = reconfigure(upstream.baseUrl, 1, 60);
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );
    const body = callToolRequest('bookstack_books_list', { count: 1 });

    const first = await postMessage(url, body, { authToken: TEST_AUTH_TOKEN });
    expect(first.status).toBe(200);

    const startedAt = Date.now();
    const second = await postMessage(url, body, { authToken: TEST_AUTH_TOKEN });
    const elapsedMs = Date.now() - startedAt;

    expect(second.status).toBe(200);
    // 60/minute is one token per second, and the first request took the only one. A
    // per-request bucket answers this in single-digit milliseconds.
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    // Queued, not dropped: both requests did reach BookStack, in order.
    expect(upstream.toolCalls).toEqual(['/api/books', '/api/books']);
  }, 15_000);

  it('does not queue when the burst allowance covers both calls', async () => {
    // The control the timing assertion above needs: same route, same two requests, and the
    // ONLY difference is the configured burst. Without this, "slow" could be anything.
    const appConfig = reconfigure(upstream.baseUrl, 10, 60);
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );
    const body = callToolRequest('bookstack_books_list', { count: 1 });

    const startedAt = Date.now();
    await postMessage(url, body, { authToken: TEST_AUTH_TOKEN });
    await postMessage(url, body, { authToken: TEST_AUTH_TOKEN });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(900);
    expect(upstream.toolCalls).toEqual(['/api/books', '/api/books']);
  }, 15_000);
});

/**
 * Run `body` with the clock the readiness route ages its cache on advanced by `offsetMs`.
 *
 * `performance.now`, not `Date.now`: the route measures every bound - the TTL and the stale
 * bound - on the monotonic clock (see monotonicNow() in src/server.ts), keeping wall time
 * for `checked_at` alone. Moving time rather than sleeping through it is what lets a 30-second
 * bound be tested in milliseconds; only shifting it (never freezing it) keeps the rest of the
 * HTTP stack undisturbed.
 */
async function withMonotonicOffset<T>(offsetMs: number, body: () => Promise<T>): Promise<T> {
  const realNow = performance.now.bind(performance);
  performance.now = () => realNow() + offsetMs;
  try {
    return await body();
  } finally {
    performance.now = realNow;
  }
}

describe('unauthenticated /health cannot monopolise the outbound budget', () => {
  /** Mirrors HEALTH_MAX_WAITERS in src/server.ts. */
  const HEALTH_MAX_WAITERS = 32;
  /** Mirrors HEALTH_MAX_STALE_MS in src/server.ts. */
  const HEALTH_MAX_STALE_MS = 30_000;
  /** Comfortably more than the waiter cap, so the shed path runs too. */
  const FLOOD = 50;

  let upstream: StubUpstream;

  beforeAll(() => {
    upstream = startStubUpstream();
  });

  afterAll(() => {
    upstream.stop();
    restoreSuiteEnv();
    resetSharedRateLimiters();
  });

  beforeEach(() => {
    upstream.reset();
    resetSharedRateLimiters();
  });

  it('collapses a flood of anonymous probes onto one upstream check, and lets authenticated work through', async () => {
    // R4-W2. /health is unauthenticated and performs a live GET /system through the cached
    // server. Once the outbound bucket became genuinely shared, every anonymous probe queued
    // its own check in the SAME FIFO as authenticated tool calls - so any peer that could
    // reach the port could push unbounded work in front of real traffic, and each waiter
    // pinned a request and a promise. Holding /system open is what exposes it: without
    // coalescing, FLOOD probes are FLOOD upstream calls and the tools/call below is stuck
    // behind ~46 refills, i.e. the better part of a minute.
    const appConfig = reconfigure(upstream.baseUrl, 4, 60);
    upstream.hold();
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );

    const flood = Array.from({ length: FLOOD }, () => fetch(`${url}/health`));
    // Long enough for every probe to have reached the handler while the check is held open.
    await Bun.sleep(250);

    // One HTTP request must not equal one queued upstream check.
    expect(upstream.systemCalls).toBe(1);

    const startedAt = Date.now();
    const response = await postMessage(url, callToolRequest('bookstack_books_list', { count: 1 }), {
      authToken: TEST_AUTH_TOKEN,
    });
    const elapsedMs = Date.now() - startedAt;

    // The authenticated caller is served while FLOOD anonymous probes are outstanding.
    expect(response.status).toBe(200);
    expect(elapsedMs).toBeLessThan(3_000);
    expect(upstream.toolCalls).toEqual(['/api/books']);

    upstream.release();
    const statuses = (await Promise.all(flood)).map((probe) => probe.status);

    // Still one check for the whole flood, now that it has drained.
    expect(upstream.systemCalls).toBe(1);
    // Every probe got a real answer: either the check's result, or a 503 saying the
    // readiness check is saturated. Nothing hung, and nothing invented a verdict.
    expect(statuses.every((status) => status === 200 || status === 503)).toBe(true);
    // BookStack is reachable here, so the check that ran said so.
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(0);
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(
      HEALTH_MAX_WAITERS
    );
  }, 20_000);

  it('sheds an over-cap probe with a truthful reason rather than parking it', async () => {
    const appConfig = reconfigure(upstream.baseUrl, 4, 60);
    upstream.hold();
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );

    const flood = Array.from({ length: FLOOD }, () => fetch(`${url}/health`));
    await Bun.sleep(250);
    const shed = await fetch(`${url}/health`);
    const payload = (await shed.json()) as { status?: string; error?: string };

    expect(shed.status).toBe(503);
    // It says the probe was shed - it does NOT claim to have checked BookStack and found
    // it wanting, which is what a bare 'unhealthy' would imply.
    expect(payload.error).toContain('saturated');
    expect(payload.error).toContain('GET /');
    expect(upstream.systemCalls).toBe(1);

    upstream.release();
    await Promise.all(flood);
  }, 20_000);

  it('serves a repeat probe from the short-lived cache, disclosing how old it is', async () => {
    const appConfig = reconfigure(upstream.baseUrl, 4, 60);
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );

    const first = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
    const second = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;

    expect(upstream.systemCalls).toBe(1);
    expect(first).toMatchObject({ status: 'healthy' });
    expect(second).toMatchObject({ status: 'healthy' });
    // A cached verdict must say when it was true, or it is indistinguishable from a fresh
    // one and the TTL becomes a silent lie.
    expect(typeof second.checked_at).toBe('string');
    expect(typeof second.age_ms).toBe('number');
    expect(second.checked_at).toBe(first.checked_at as string);
  }, 20_000);

  it('re-checks once the TTL has passed, so it cannot report stale health indefinitely', async () => {
    const appConfig = reconfigure(upstream.baseUrl, 4, 60);
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );

    await fetch(`${url}/health`);
    await fetch(`${url}/health`);
    expect(upstream.systemCalls).toBe(1);

    // Jump past the 5s TTL instead of sleeping through it.
    const refreshed = await withMonotonicOffset(6_000, () => fetch(`${url}/health`));
    expect(refreshed.status).toBe(200);

    // A cache that never expires would still be reporting the first verdict.
    expect(upstream.systemCalls).toBe(2);
  }, 20_000);

  it('will not serve a shed caller a snapshot older than the stale bound', async () => {
    // R5-W5. The 30s bound had no test at all: the shedding test starts with no cache, the
    // cache test stays inside the 5s TTL, and the expiry test is not saturated - so deleting
    // the age condition and serving `lastCheck` forever under saturation left every health
    // test green. This is the branch that stops an anonymous flood, arriving while BookStack
    // is slowly failing, from turning one old healthy result into an indefinite 200.
    const appConfig = reconfigure(upstream.baseUrl, 4, 60);
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );

    // A genuine 'healthy' snapshot, taken while BookStack was answering. This is the
    // comfortable old answer the bound exists to stop being served forever.
    const seeded = await fetch(`${url}/health`);
    expect(seeded.status).toBe(200);
    expect(upstream.systemCalls).toBe(1);

    // Now BookStack stops answering, and the snapshot ages out of the bound.
    upstream.hold();
    try {
      await withMonotonicOffset(HEALTH_MAX_STALE_MS + 1_000, async () => {
        const flood = Array.from({ length: FLOOD }, () => fetch(`${url}/health`));
        await Bun.sleep(250);
        // Past the TTL, so a replacement check started - and it is held open, which is what
        // keeps the waiters parked and the cap full.
        expect(upstream.systemCalls).toBe(2);

        const shed = await fetch(`${url}/health`);
        const payload = (await shed.json()) as { status?: string; error?: string };

        // 31 seconds old, upstream not answering, nothing honest to say: so say that.
        expect(shed.status).toBe(503);
        expect(payload.status).toBe('unhealthy');
        expect(payload.error).toContain('saturated');
        // It must not quietly become the stale 200 the control below asserts.
        expect(payload.error).not.toContain('healthy');

        upstream.release();
        await Promise.all(flood);
      });
    } finally {
      upstream.release();
    }
  }, 20_000);

  it('does serve a shed caller the stale snapshot while it is INSIDE the stale bound', async () => {
    // The control the test above needs, and the reason it cannot be satisfied by shedding
    // everything with a blanket 503: inside the bound, an old answer that says how old it is
    // beats no answer, and that is the behaviour being bounded rather than removed.
    const appConfig = reconfigure(upstream.baseUrl, 4, 60);
    const { url } = await startApp(
      { bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
      appConfig
    );

    const seeded = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
    expect(upstream.systemCalls).toBe(1);

    upstream.hold();
    try {
      // Past the 5s TTL - so this caller is not being served from the cache's normal path -
      // but well inside the 30s bound.
      await withMonotonicOffset(10_000, async () => {
        const flood = Array.from({ length: FLOOD }, () => fetch(`${url}/health`));
        await Bun.sleep(250);
        expect(upstream.systemCalls).toBe(2);

        const shed = await fetch(`${url}/health`);
        const payload = (await shed.json()) as Record<string, unknown>;

        expect(shed.status).toBe(200);
        expect(payload.status).toBe('healthy');
        // The same snapshot, disclosed as the age it actually is. `checked_at` is unchanged
        // across a monotonic jump because it is wall time, which is the split working.
        expect(payload.checked_at).toBe(seeded.checked_at as string);
        expect(payload.age_ms as number).toBeGreaterThanOrEqual(9_000);
        expect(payload.age_ms as number).toBeLessThan(HEALTH_MAX_STALE_MS);

        upstream.release();
        await Promise.all(flood);
      });
    } finally {
      upstream.release();
    }
  }, 20_000);
});

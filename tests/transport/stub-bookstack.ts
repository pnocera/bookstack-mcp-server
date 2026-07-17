/**
 * A deterministic, in-process stand-in for the BookStack REST API.
 *
 * Why this exists. CI deliberately does not run the live integration suite
 * (RUN_INTEGRATION=0), which left the published tool surface untested: `initialize` is
 * answered by the MCP SDK out of the server's own capabilities and never touches a tool
 * handler, so tool registration or dispatch could break entirely and CI would stay green.
 * This stub closes that gap without Docker - a `tools/call` can run end to end, through
 * validation, the axios client, retry and the response path, against a server that
 * answers like BookStack does.
 *
 * It is not a BookStack emulator. It serves the handful of read-only endpoints the
 * transport tests exercise, and answers anything else with a BookStack-shaped 404, so a
 * test that silently starts calling an unimplemented endpoint fails rather than passes.
 *
 * Every request is recorded. That is what makes assertions about *transmission* possible:
 * a `count=2` that never reached the wire is a real bug this records the absence of.
 */

/** One request the stub received, reduced to what a test might reasonably assert on. */
export interface RecordedRequest {
  method: string;
  /** Path with the /api prefix stripped, e.g. "/books". */
  path: string;
  /** Query string parsed into a plain object; repeated keys keep the last value. */
  query: Record<string, string>;
  authorization: string | undefined;
}

export interface BookStackStub {
  /** Value for BOOKSTACK_BASE_URL: includes the /api suffix, as the real one does. */
  baseUrl: string;
  /** Value for BOOKSTACK_API_TOKEN. The stub rejects anything else with a 401. */
  apiToken: string;
  /** Requests seen so far, oldest first. */
  readonly requests: RecordedRequest[];
  stop(): Promise<void>;
}

/** The token the stub accepts, in BookStack's `<id>:<secret>` form. */
const STUB_API_TOKEN = 'stub-token-id:stub-token-secret';

/**
 * Fixture books. Two of them, so a `count=1` that is honoured is distinguishable from a
 * `count` that was dropped on the way out - the latter would return both.
 */
const BOOKS = [
  {
    id: 1,
    name: 'Stub Handbook',
    slug: 'stub-handbook',
    description: 'First fixture book served by the local BookStack stub.',
    created_at: '2026-01-01T00:00:00.000000Z',
    updated_at: '2026-01-02T00:00:00.000000Z',
    created_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
    updated_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
    owned_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
  },
  {
    id: 2,
    name: 'Stub Runbook',
    slug: 'stub-runbook',
    description: 'Second fixture book served by the local BookStack stub.',
    created_at: '2026-01-03T00:00:00.000000Z',
    updated_at: '2026-01-04T00:00:00.000000Z',
    created_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
    updated_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
    owned_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
  },
] as const;

/** What GET /api/system answers - the endpoint the health check probes. */
const SYSTEM_INFO = {
  version: 'v26.05.2',
  instance_id: 'stub-instance',
  app_name: 'BookStack Stub',
  app_logo: '',
  base_url: 'http://127.0.0.1/stub',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** BookStack's error envelope, which the client's error handler expects to find. */
function apiError(code: number, message: string): Response {
  return json({ error: { code, message } }, code);
}

/**
 * Start the stub on an ephemeral loopback port.
 *
 * Bun.serve rather than Express: no dependency, and it is a genuinely separate HTTP
 * server from the app under test, so the tool call really does cross a socket.
 */
export function startBookStackStub(): BookStackStub {
  const requests: RecordedRequest[] = [];

  // Untyped binding on purpose: `Bun.serve`'s return type is generic in its WebSocket
  // data, and annotating it as a bare `Server` fails to compile.
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request: Request): Response {
      const url = new URL(request.url);
      const authorization = request.headers.get('authorization') ?? undefined;
      const path = url.pathname.replace(/^\/api/, '');

      requests.push({
        method: request.method,
        path,
        query: Object.fromEntries(url.searchParams),
        authorization,
      });

      // The client sends `Authorization: Token <id>:<secret>`. Checking it here is what
      // makes a tool call prove the outbound credential was actually attached: without
      // this the stub would answer a request that forgot to authenticate.
      if (authorization !== `Token ${STUB_API_TOKEN}`) {
        return apiError(401, 'Unauthorized');
      }

      if (request.method === 'GET' && path === '/system') {
        return json(SYSTEM_INFO);
      }

      if (request.method === 'GET' && path === '/books') {
        const count = Number(url.searchParams.get('count') ?? BOOKS.length);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const page = BOOKS.slice(offset, offset + count);
        // `total` is the unpaginated total, as BookStack reports it.
        return json({ data: page, total: BOOKS.length });
      }

      const bookMatch = path.match(/^\/books\/(\d+)$/);
      if (request.method === 'GET' && bookMatch) {
        const book = BOOKS.find((candidate) => candidate.id === Number(bookMatch[1]));
        return book ? json(book) : apiError(404, 'Book not found');
      }

      // Anything else is out of scope on purpose - see the file header.
      return apiError(404, `The stub does not implement ${request.method} ${url.pathname}`);
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/api`,
    apiToken: STUB_API_TOKEN,
    requests,
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}

/** The fixture data the stub serves, for tests that assert on what came back. */
export const STUB_BOOKS = BOOKS;
export const STUB_SYSTEM_INFO = SYSTEM_INFO;

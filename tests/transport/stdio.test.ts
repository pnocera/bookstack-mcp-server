/**
 * Transport tests: the real stdio entry point, spawned as a process.
 *
 * Why this file exists. Under MCP's stdio transport, stdout *is* the protocol: it carries
 * newline-delimited JSON-RPC and nothing else. Anything else a dependency decides to
 * print - a banner, a log line, a stray console.log - lands mid-stream and corrupts the
 * session before it starts. This repo has shipped that bug twice: Winston logging to
 * stdout (fixed in d78b150), and dotenv v17 announcing "◇ injected env (N) from .env"
 * via console.log (fixed with `quiet: true` in src/config/manager.ts).
 *
 * No in-process test can catch either. `createHttpApp()` never runs the stdio branch, and
 * importing the module inside the test runner shares the runner's own stdout. So this
 * suite spawns `bun run src/server.ts` with MCP_TRANSPORT=stdio exactly as an MCP client
 * would, talks to it over stdin/stdout, and asserts that *every* byte it wrote to stdout
 * is valid MCP JSON.
 *
 * No live BookStack, no Docker: BOOKSTACK_BASE_URL points at the in-process stub.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { type BookStackStub, startBookStackStub } from './stub-bookstack';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SERVER_ENTRY = join(REPO_ROOT, 'src', 'server.ts');

/** Generous: a cold `bun run` of the entry point plus MCP handshake. */
const REPLY_TIMEOUT_MS = 20_000;

let stub: BookStackStub;

beforeAll(() => {
  stub = startBookStackStub();
});

/** The JSON-RPC shapes this suite reads back. */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: {
    serverInfo?: { name?: string; version?: string };
    tools?: Array<{ name: string }>;
  };
  error?: { code: number; message: string };
}

/** A spawned stdio server, with its output split into lines as they arrive. */
interface StdioServer {
  send(message: Record<string, unknown>): void;
  /** Resolve with the next line stdout produces, verbatim and unparsed. */
  nextStdoutLine(): Promise<string>;
  /** Every line stdout has produced so far. */
  stdoutLines(): string[];
  stderrText(): string;
  stop(): Promise<void>;
}

/**
 * A stream of output lines that can be both replayed in full and consumed one at a time.
 *
 * Deliberately dumb: it does not know what a JSON-RPC message looks like, so a banner
 * line is captured exactly like a protocol line. Filtering here - "skip lines that don't
 * parse" - would reintroduce the very bug this file exists to catch.
 */
class LineReader {
  /** Every line seen, in order. Never consumed, so tests can audit the whole stream. */
  private readonly lines: string[] = [];
  /** How many lines `next()` has handed out; the read cursor into `lines`. */
  private cursor = 0;
  private readonly waiters: Array<(line: string) => void> = [];

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.pump(stream);
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          this.emit(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      // A trailing write with no newline still counts as output.
      if (buffer.length > 0) {
        this.emit(buffer);
      }
    } catch {
      // The stream tears down when the child is killed in stop(); nothing to report.
    }
  }

  private emit(line: string): void {
    this.lines.push(line);
    const waiter = this.waiters.shift();
    if (waiter) {
      this.cursor += 1;
      waiter(line);
    }
  }

  /** All lines seen so far, including ones already handed out by next(). */
  all(): string[] {
    return [...this.lines];
  }

  text(): string {
    return this.lines.join('\n');
  }

  /** The next unread line, waiting for it if it has not arrived yet. */
  next(timeoutMs: number, describeState: () => string): Promise<string> {
    if (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor] as string;
      this.cursor += 1;
      return Promise.resolve(line);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`No line within ${timeoutMs}ms. ${describeState()}`));
      }, timeoutMs);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }
}

const spawned: StdioServer[] = [];

/**
 * Spawn the real entry point under the stdio transport.
 *
 * The environment is built explicitly rather than spread from `process.env`: sibling
 * suites in this same runner process mutate BOOKSTACK_* while they run, and inheriting
 * that would make what the child is configured with depend on test order.
 */
function spawnStdioServer(extraEnv: Record<string, string> = {}): StdioServer {
  const proc: Subprocess<'pipe', 'pipe', 'pipe'> = Bun.spawn({
    cmd: [process.execPath, 'run', SERVER_ENTRY],
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      MCP_TRANSPORT: 'stdio',
      BOOKSTACK_BASE_URL: stub.baseUrl,
      BOOKSTACK_API_TOKEN: stub.apiToken,
      // The noisiest setting on purpose. Every logger call the handshake makes is a
      // chance to write to the wrong stream, and a guard that runs with logging off
      // would not have caught the Winston-on-stdout bug it is here to prevent.
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'json',
      ...extraEnv,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = new LineReader(proc.stdout);
  const stderr = new LineReader(proc.stderr);

  const server: StdioServer = {
    send(message: Record<string, unknown>): void {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    },
    nextStdoutLine(): Promise<string> {
      return stdout.next(
        REPLY_TIMEOUT_MS,
        () =>
          `stdio server produced no further stdout. stdout so far: ` +
          `${JSON.stringify(stdout.all())}. stderr so far: ${stderr.text()}`
      );
    },
    stdoutLines: () => stdout.all(),
    stderrText: () => stderr.text(),
    async stop(): Promise<void> {
      proc.kill();
      await proc.exited;
    },
  };

  spawned.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((server) => server.stop()));
});

/**
 * Every log line the server wrote, decoded.
 *
 * These suites run the child with LOG_FORMAT=json, so each stderr line is one Winston
 * record: `{level, message, timestamp, ...redacted meta}`. Reading them as records rather
 * than grepping the text is what lets the assertions below say "this line carries
 * `query_length` and NOT `query`" - a substring search cannot tell the two apart, since the
 * redacted form of `query` contains neither the marker nor anything else distinctive.
 *
 * A line that is not JSON is skipped rather than fatal: stdout purity is this file's
 * subject, stderr's is not, and a stray banner on stderr would be a different test's news.
 */
function logEntries(stderrText: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of stderrText.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        entries.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a log record; not this file's business.
    }
  }
  return entries;
}

/** Parse a stdout line, failing with the raw text when it is not JSON at all. */
function parseProtocolLine(line: string): JsonRpcMessage {
  try {
    return JSON.parse(line) as JsonRpcMessage;
  } catch (error) {
    throw new Error(
      `stdout carried a line that is not JSON, which corrupts the MCP stream: ` +
        `${JSON.stringify(line)} (${(error as Error).message})`
    );
  }
}

/** Drive the MCP handshake and return the initialize reply. */
async function initialize(server: StdioServer): Promise<JsonRpcMessage> {
  server.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stdio-transport-test', version: '1.0.0' },
    },
  });
  const reply = parseProtocolLine(await server.nextStdoutLine());
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return reply;
}

describe('stdio entry point', () => {
  it(
    'completes an MCP handshake and lists all 56 tools',
    async () => {
      // Proof the spawned process is a working MCP server, not merely a quiet one: a
      // process that printed nothing at all would pass a stdout-purity check by itself.
      const server = spawnStdioServer();

      const initReply = await initialize(server);
      expect(initReply.error).toBeUndefined();
      expect(initReply.result?.serverInfo?.name).toBe('bookstack-mcp-server');

      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const listReply = parseProtocolLine(await server.nextStdoutLine());

      expect(listReply.id).toBe(2);
      expect(listReply.result?.tools).toHaveLength(56);
      expect(listReply.result?.tools?.map((tool) => tool.name)).toContain('bookstack_books_list');
    },
    REPLY_TIMEOUT_MS + 5_000
  );

  it(
    'writes nothing but MCP JSON to stdout',
    async () => {
      // The regression guard. dotenv v17 prints "◇ injected env (N) from .env" through
      // console.log whether or not a .env file exists, and Winston defaults to stdout;
      // either lands here as a line that is not JSON-RPC. Asserting over *every* line
      // rather than searching for the good ones is the point - a corrupted stream is
      // corrupted by what is extra, not by what is missing.
      const server = spawnStdioServer();

      await initialize(server);
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await server.nextStdoutLine();

      const lines = server.stdoutLines();
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const message = parseProtocolLine(line);
        expect(message.jsonrpc, `stdout line: ${line}`).toBe('2.0');
      }
    },
    REPLY_TIMEOUT_MS + 5_000
  );

  it(
    'dispatches a tools/call over stdio and returns BookStack data',
    async () => {
      // Registration alone is not dispatch. This runs a handler end to end - validation,
      // axios client, the stub - over the stdio transport specifically.
      const server = spawnStdioServer();
      await initialize(server);

      server.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'bookstack_books_list', arguments: { count: 1 } },
      });
      const reply = parseProtocolLine(await server.nextStdoutLine());

      expect(reply.error).toBeUndefined();
      const content = (reply.result as { content?: Array<{ text: string }> } | undefined)
        ?.content?.[0]?.text;
      expect(content).toBeDefined();
      const payload = JSON.parse(content as string) as { data: Array<{ name: string }> };
      expect(payload.data).toHaveLength(1);
      expect(payload.data[0]?.name).toBe('Stub Handbook');

      // And the whole exchange left stdout uncorrupted.
      for (const line of server.stdoutLines()) {
        expect(parseProtocolLine(line).jsonrpc, `stdout line: ${line}`).toBe('2.0');
      }
    },
    REPLY_TIMEOUT_MS + 5_000
  );

  it(
    'sends its human-readable startup notice to stderr',
    async () => {
      // The other half of the contract: diagnostics must still be emitted, just not on
      // the protocol stream. If this ever goes quiet, the stdout-purity test above would
      // start passing for the wrong reason.
      const server = spawnStdioServer();

      await initialize(server);

      expect(server.stderrText()).toContain('listening on stdio');
    },
    REPLY_TIMEOUT_MS + 5_000
  );
});

/**
 * Redaction, proved against a real process's real streams.
 *
 * tests/unit/log-redaction.test.ts pins the rules against the Logger's own output; this
 * pins them against the thing an operator actually reads - `docker logs` on the shipped
 * entry point, with real tool dispatch, the real API client, and every log call the
 * handshake and the call path make along the way. Round 4's finding was that no such test
 * existed at all, so the leaks it found were invisible to CI.
 *
 * The markers ride in as tool ARGUMENTS, which is how a secret arrives in real life.
 */
const STDIO_MARKERS = {
  password: 'STDIOPW-marker-a7c3e91f',
  html: 'STDIOHTML-marker-b2f8d64a',
  markdown: 'STDIOMD-marker-c9e1a35b',
  base64: 'STDIOB64-marker-d4a7f28c',
  filePath: 'STDIOPATH-marker-e6b3c91d',
  // R5-W3. The four the round-4 suite never sent, and therefore the four that were still
  // being written when it went green. Each rides in on an ordinary argument under an
  // ordinary name - which is the point: none of them looks like a secret, and all of them
  // are the caller's private text.
  //
  //  - a search term, which is routinely a person, a client or a phrase from the document
  //    being looked for. Logged at INFO, the default level, by bookstack_search.
  //  - a user's name and email address: personal data, and the email is an account
  //    identifier as well. Logged at INFO by bookstack_users_create.
  //  - a list filter's value, logged at DEBUG twice over - by the tool handler and again by
  //    the API client's request interceptor, which used to render the whole query object.
  searchQuery: 'STDIOQUERY-marker-f1a8d37e',
  userName: 'STDIONAME-marker-b6e2c94a',
  userEmail: 'STDIOEMAIL-marker-c3f7a18d',
  filterValue: 'STDIOFILTER-marker-d9b4e26c',
  // R6-W2. Four more shapes the round-5 suite could not see, because every call it made
  // used a real tool name, ordinary argument names, `tools/call` rather than
  // `resources/read`, and strict validation. All four are ordinary caller text that the
  // server wrote to the log at the DEFAULT level with nothing going wrong:
  //
  //  - an unknown tool NAME, interpolated into `Tool called: ${name}` and logged under the
  //    allowlisted `tool` key, both before the name had been compared to anything.
  //  - an unknown argument KEY. A caller who names a field after their own data ships it in
  //    `argument_names`, which was allowlisted as "our schema's vocabulary".
  //  - a search resource URI. `bookstack://search/{query}` carries the caller's query IN ITS
  //    PATH, and the whole URI went into the message on request, success and failure. This
  //    is the one that needs no attacker at all: it is what an ordinary search costs.
  //  - an unknown key in NON-STRICT mode, whose ZodError message quotes the key verbatim -
  //    printed by a raw console.warn that no redactor ever saw.
  unknownTool: 'STDIOTOOL-marker-e8c5b73f',
  unknownArgument: 'STDIOARG-marker-a2d9f461',
  resourceQuery: 'STDIORES-marker-b7e3c85a',
  nonStrictKey: 'STDIOLAX-marker-c4f1d92b',
} as const;

/**
 * WHERE THE URL VECTOR IS PROVED, AND WHY NOT HERE.
 *
 * R4-W3's first marker was a credential in `BOOKSTACK_BASE_URL`'s userinfo, logged at
 * `info` by the API client. It is deliberately absent from this file: `canonicalBaseUrl()`
 * now REFUSES a base URL carrying userinfo, a query or a fragment, so a server configured
 * with one does not start and there is no log line to inspect. Driving it through this
 * transport would prove the config guard, not the redactor.
 *
 * The redactor's URL rules are proved at its own output instead, in
 * tests/unit/log-redaction.test.ts ('URLs are sanitized structurally rather than by key
 * name' and 'keeps the host, path and non-sensitive query of a sanitized URL'). That
 * backstop still matters with the config guard in place: it is what covers a URL reaching
 * a log from anywhere other than that one validated setting.
 *
 * The same goes for R5-W3's delimiter-bearing spellings - `pw)marker`, `pw'marker`,
 * `?api_token={marker}` - which the old matcher truncated before parsing and then printed
 * whole. There is no argument a spawned server would log one through: the base URL cannot
 * carry userinfo, and no tool logs a caller's URL. So they are proved where they can be, at
 * the redactor's real stream output, over both levels and both formats, in the file above.
 * A test here would have had to invent a call site that does not exist in order to watch it
 * behave.
 */

/**
 * The markers that nothing may echo, anywhere, on either stream.
 *
 * `filePath` is deliberately absent. Under stdio the upload guard answers the CALLER with
 * `file_path '<path>' does not exist or is not readable by the server` - the caller's own
 * path, returned to the caller who just sent it, on the protocol stream that exists to
 * answer them. That is the error message doing its job, not a leak. What would be a leak
 * is that same path being written to the operator's LOG, and the stderr assertion below
 * covers it with no exception.
 */
const MARKERS_BANNED_EVERYWHERE: readonly string[] = [
  STDIO_MARKERS.password,
  STDIO_MARKERS.html,
  STDIO_MARKERS.markdown,
  STDIO_MARKERS.base64,
  STDIO_MARKERS.searchQuery,
  STDIO_MARKERS.userName,
  STDIO_MARKERS.userEmail,
  STDIO_MARKERS.filterValue,
];

/** Every marker: none of these may ever reach the log stream. */
const ALL_STDIO_MARKERS: readonly string[] = Object.values(STDIO_MARKERS);

describe('spawned stdio server never logs a secret', () => {
  for (const level of ['info', 'debug'] as const) {
    it(
      `keeps every marker out of the log stream at LOG_LEVEL=${level}`,
      async () => {
        const server = spawnStdioServer({ LOG_LEVEL: level });
        await initialize(server);

        // Each call drives a different rule. All of them fail upstream (the stub serves a
        // read-only slice), which is the interesting case: failure is when this server
        // logs the most.
        server.send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'bookstack_users_create',
            arguments: {
              // The name and the email are markers now too. Round 4 sent 'Marker User' and
              // 'marker@example.com' - real values under keys the redactor did not know
              // about - so the line that wrote both of them out at `info` was in the test's
              // output and matched nothing it asserted on. R5-W3.
              name: STDIO_MARKERS.userName,
              email: `${STDIO_MARKERS.userEmail}@example.com`,
              password: STDIO_MARKERS.password,
            },
          },
        });
        await server.nextStdoutLine();

        server.send({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'bookstack_pages_create',
            arguments: {
              book_id: 1,
              name: 'Marker Page',
              html: `<p>${STDIO_MARKERS.html}</p>`,
              markdown: `# ${STDIO_MARKERS.markdown}`,
            },
          },
        });
        await server.nextStdoutLine();

        server.send({
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: {
            name: 'bookstack_images_create',
            arguments: {
              uploaded_to: 1,
              name: 'Marker Image',
              image: `iVBORw0KGgo${STDIO_MARKERS.base64}`,
            },
          },
        });
        await server.nextStdoutLine();

        // The caller's search term, at the DEFAULT log level. This is the call the round-4
        // suite never made, and `bookstack_search` wrote the whole query on it.
        server.send({
          jsonrpc: '2.0',
          id: 14,
          method: 'tools/call',
          params: {
            name: 'bookstack_search',
            arguments: { query: `"${STDIO_MARKERS.searchQuery}" {type:page}` },
          },
        });
        await server.nextStdoutLine();

        // A list filter's value, which is read TWICE on the way out: the tool handler logged
        // the raw request object, and the API client's request interceptor logged the whole
        // axios `params`. Filtering users by email is how you look a person up, so the value
        // here is the same personal data the create call carries.
        server.send({
          jsonrpc: '2.0',
          id: 15,
          method: 'tools/call',
          params: {
            name: 'bookstack_users_list',
            arguments: { filter: { email: `${STDIO_MARKERS.filterValue}@example.com` } },
          },
        });
        await server.nextStdoutLine();

        // The upload guard interpolates the caller's path into its error message; the
        // tool boundary then logs that message and its stack.
        server.send({
          jsonrpc: '2.0',
          id: 13,
          method: 'tools/call',
          params: {
            name: 'bookstack_attachments_create',
            arguments: {
              uploaded_to: 1,
              name: 'Marker Attachment',
              file_path: `/nonexistent/${STDIO_MARKERS.filePath}.png`,
            },
          },
        });
        await server.nextStdoutLine();

        // R6-W2: a tool name nobody registered. It went into the message AND into `tool`
        // before the registry was consulted, so the dispatcher wrote the caller's string
        // twice over and then refused the call.
        server.send({
          jsonrpc: '2.0',
          id: 16,
          method: 'tools/call',
          params: { name: `bookstack_${STDIO_MARKERS.unknownTool}`, arguments: {} },
        });
        await server.nextStdoutLine();

        // R6-W2: an argument KEY the schema does not define. Strict validation rejects the
        // call, but the tool boundary logs `argument_names` before any of that happens.
        server.send({
          jsonrpc: '2.0',
          id: 17,
          method: 'tools/call',
          params: {
            name: 'bookstack_books_list',
            arguments: { count: 5, [STDIO_MARKERS.unknownArgument]: 'x' },
          },
        });
        await server.nextStdoutLine();

        // R6-W2, and the one that costs nothing to trigger: an ORDINARY, VALID read of the
        // search resource. The query is in the URI's path, and the URI was the message.
        server.send({
          jsonrpc: '2.0',
          id: 18,
          method: 'resources/read',
          params: {
            uri: `bookstack://search/${encodeURIComponent(`"${STDIO_MARKERS.resourceQuery}" {type:page}`)}`,
          },
        });
        await server.nextStdoutLine();

        // ...and a resource URI that matches no template, which must not echo either.
        server.send({
          jsonrpc: '2.0',
          id: 19,
          method: 'resources/read',
          params: { uri: `bookstack://nosuch/${STDIO_MARKERS.resourceQuery}` },
        });
        await server.nextStdoutLine();

        const stderr = server.stderrText();
        const stdout = server.stdoutLines().join('\n');

        // THE CLAIM: no marker, of any kind, in the operator's log. No exceptions.
        for (const marker of ALL_STDIO_MARKERS) {
          expect(stderr, `${marker} must not reach stderr at LOG_LEVEL=${level}`).not.toContain(
            marker
          );
        }

        for (const marker of MARKERS_BANNED_EVERYWHERE) {
          expect(stdout, `${marker} must not reach stdout at LOG_LEVEL=${level}`).not.toContain(
            marker
          );
        }

        // THE OPPOSITE CLAIM, or every line above passes on a server that logs nothing.
        // The upload really failed, the failure was really reported, and the report still
        // says which tool, that something was withheld, and exactly where it threw.
        //
        // The message is a constant now and the tool is a field beside it - R6-W2: a
        // message is the one string this codebase does not redact, so nothing caller-shaped
        // may be interpolated into one. The fact is not lost, it moved to where the rules
        // apply.
        const failures = logEntries(stderr).filter((entry) => entry.message === 'Tool failed');
        expect(failures.some((entry) => entry.tool === 'bookstack_attachments_create')).toBe(true);
        expect(stderr).toContain('[redacted:');
        // Frames survive: this is the "where", and it is a code location rather than
        // caller text. Losing it would be trading the leak for a blind spot.
        expect(stderr).toContain('resolveRealPath');
        expect(stderr).toContain('client.ts');

        // THE CALL SITES, LINE BY LINE.
        //
        // The central redactor would reduce a logged `query` or `email` to a size on its
        // own, so the marker assertions above stay green whether or not the handlers were
        // ever fixed - they prove the backstop, not the plan. These read the lines as
        // records instead: each one must carry the FACT that replaced the value, which is
        // false the moment a handler goes back to logging the value itself.
        const entries = logEntries(stderr);
        const lineFor = (message: string): Record<string, unknown> | undefined =>
          entries.find((entry) => entry.message === message);

        const searching = lineFor('Searching content');
        expect(searching, 'bookstack_search must still report the search it ran').toBeDefined();
        expect(searching?.query_length).toBe(`"${STDIO_MARKERS.searchQuery}" {type:page}`.length);
        expect(searching?.query).toBeUndefined();

        const creatingUser = lineFor('Creating user');
        expect(creatingUser, 'bookstack_users_create must still report the call').toBeDefined();
        // The argument NAMES, which is what makes this line worth having: an operator can
        // still see that the account was created with a password and without roles.
        expect(creatingUser?.fields).toEqual(['email', 'name', 'password']);
        expect(creatingUser?.roles).toBe(0);
        expect(creatingUser?.name).toBeUndefined();
        expect(creatingUser?.email).toBeUndefined();

        // The tool boundary's own line still names the tool and its arguments.
        const called = entries.find(
          (entry) => entry.message === 'Tool called' && entry.tool === 'bookstack_users_create'
        );
        expect(called?.argument_names).toEqual(['email', 'name', 'password']);

        // R6-W2, CALL SITE BY CALL SITE. Each of these is the FACT that replaced a piece of
        // caller text. The marker assertions above would stay green if the call sites had
        // simply gone quiet - the redactor sizes an unknown string on its own - so these are
        // what say the line is still worth reading.

        // An unknown tool: refused, reported, and described by the only thing about it that
        // is not the caller's - its length. `bookstack_` + the marker.
        const rejected = entries.find(
          (entry) => entry.message === 'Tool call rejected: unknown tool'
        );
        expect(rejected, 'an unknown tool must still be reported').toBeDefined();
        expect(rejected?.tool_name_length).toBe(`bookstack_${STDIO_MARKERS.unknownTool}`.length);
        expect(rejected?.tool).toBeUndefined();

        // An unknown argument key: the schema's own `count` still renders beside a COUNT of
        // the ones that are not the schema's. An operator can see that the caller sent a
        // field this server does not define, which is the diagnostic; which field it was is
        // the caller's text, and is in the validation error they got back.
        const booksListing = entries.find(
          (entry) => entry.message === 'Tool called' && entry.tool === 'bookstack_books_list'
        );
        expect(booksListing, 'the books listing call must still be logged').toBeDefined();
        expect(booksListing?.argument_names).toEqual(['count']);
        expect(booksListing?.unknown_argument_count).toBe(1);

        // The search RESOURCE: the URI template - a constant of the codebase - and the
        // length of what filled it in. Never the URI, which is the query.
        const resourceRead = entries.find(
          (entry) => entry.message === 'Resource requested' && entry.resource !== undefined
        );
        expect(resourceRead, 'a resource read must still be logged').toBeDefined();
        expect(resourceRead?.resource).toBe('bookstack://search/{query}');
        expect(resourceRead?.query_length).toBe(
          encodeURIComponent(`"${STDIO_MARKERS.resourceQuery}" {type:page}`).length
        );
        expect(resourceRead?.uri).toBeUndefined();

        // An unknown resource: the same treatment as an unknown tool.
        const unknownResource = entries.find(
          (entry) => entry.message === 'Resource read rejected: unknown resource'
        );
        expect(unknownResource, 'an unknown resource must still be reported').toBeDefined();
        expect(unknownResource?.uri_length).toBe(
          `bookstack://nosuch/${STDIO_MARKERS.resourceQuery}`.length
        );

        if (level === 'debug') {
          // Which filter was applied, without what was in it - at the handler...
          const listing = lineFor('Listing users');
          expect(listing?.filters).toEqual(['email']);
          expect(listing?.filter).toBeUndefined();

          // ...and again at the API client, which used to render the whole axios `params`
          // object - the second, independent copy of the same filter value.
          // The GET specifically: the create call above is a POST to the same path, and it
          // carries its body in `data` rather than in the query.
          const request = entries.find(
            (entry) =>
              entry.message === 'API request' && entry.url === '/users' && entry.method === 'GET'
          );
          expect(request, 'the users listing must still reach the API client').toBeDefined();
          expect(request?.param_names).toEqual(['count', 'filter', 'offset', 'sort']);
          expect(request?.params).toBeUndefined();
        }

        // And the protocol stream is still nothing but protocol.
        for (const line of server.stdoutLines()) {
          expect(parseProtocolLine(line).jsonrpc, `stdout line: ${line}`).toBe('2.0');
        }
      },
      REPLY_TIMEOUT_MS + 15_000
    );
  }
});

/**
 * The documented mode in which "these names came out of a schema" is simply not true.
 *
 * VALIDATION_STRICT_MODE=false is a supported setting, and what it does is hand the caller's
 * object BACK from validateParams() when the schema rejects it. Everything downstream that
 * reasons about "validated params" is then reasoning about the caller's object: the tool
 * handlers' `fields`/`filters: Object.keys(...)` lines, and the API client's `param_names`.
 *
 * R6-W2 found two leaks along that path, and this proves both directions of the fix at once:
 * the marker never appears, and the warning that replaced the raw console.warn still says
 * which schema failed and how.
 */
describe('spawned stdio server never logs a caller key in non-strict mode', () => {
  for (const level of ['info', 'debug'] as const) {
    it(
      `keeps an unknown key out of the log stream at LOG_LEVEL=${level}`,
      async () => {
        const server = spawnStdioServer({
          LOG_LEVEL: level,
          VALIDATION_STRICT_MODE: 'false',
        });
        await initialize(server);

        server.send({
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'bookstack_books_list',
            arguments: { count: 5, [STDIO_MARKERS.nonStrictKey]: 'x' },
          },
        });
        await server.nextStdoutLine();

        const stderr = server.stderrText();
        const stdout = server.stdoutLines().join('\n');

        // THE CLAIM. On the old code this marker was printed verbatim by console.warn -
        // ZodError's message is `Unrecognized key: "<marker>"` - and again under
        // `argument_names`, which the allowlist rendered.
        expect(
          stderr,
          `${STDIO_MARKERS.nonStrictKey} must not reach stderr at LOG_LEVEL=${level}`
        ).not.toContain(STDIO_MARKERS.nonStrictKey);
        expect(stdout).not.toContain(STDIO_MARKERS.nonStrictKey);

        // THE OPPOSITE CLAIM. The warning is the whole point of non-strict mode - it is how
        // an operator learns their callers are sending things the schema refuses - so it
        // must still be there, still say which of OUR schemas rejected the call, and still
        // say what kind of failure it was.
        const warning = logEntries(stderr).find(
          (entry) =>
            entry.message === 'Validation failed in non-strict mode; forwarding params unvalidated'
        );
        expect(warning, 'the non-strict warning must still be logged').toBeDefined();
        expect(warning?.level).toBe('warn');
        expect(warning?.schema).toBe('booksList');
        expect(warning?.issue_count).toBe(1);
        expect(warning?.issue_codes).toEqual(['unrecognized_keys']);

        // And it is a Winston record on stderr rather than a raw console.warn - which is
        // what makes "every log line goes through the redactor" a true statement again.
        for (const line of server.stdoutLines()) {
          expect(parseProtocolLine(line).jsonrpc, `stdout line: ${line}`).toBe('2.0');
        }
      },
      REPLY_TIMEOUT_MS + 10_000
    );
  }
});

/**
 * R6-W3 at the transport: a credential in the BASE URL's PATH.
 *
 * Why the path and not the query. `canonicalBaseUrl()` refuses userinfo, a query and a
 * fragment, so those three cannot reach a running server at all - which is precisely why
 * the previous rounds' vectors all used them, and why none of them could see this. A PATH is
 * accepted, because an arbitrary reverse-proxy mount is a legitimate deployment
 * (`https://books.example/<capability>/api`), and the path is therefore the one part of a
 * base URL that is both arbitrary and present on a server that starts.
 *
 * Both halves are proved: the URL that is ACCEPTED and logged at startup, and the URL that
 * is REFUSED and whose refusal is logged and printed.
 */
describe('spawned stdio server never logs a base URL path', () => {
  const PATH_MARKER = 'STDIOBASE-marker-f2c7a94e';

  for (const level of ['info', 'debug'] as const) {
    it(
      `withholds the path of an accepted base URL at LOG_LEVEL=${level}`,
      async () => {
        // Port 9 (discard) is never connected to: the handshake makes no upstream request,
        // and what is under test is the startup line, not a call.
        const server = spawnStdioServer({
          LOG_LEVEL: level,
          BOOKSTACK_BASE_URL: `http://127.0.0.1:9/${PATH_MARKER}/api`,
        });
        await initialize(server);

        const stderr = server.stderrText();
        const stdout = server.stdoutLines().join('\n');

        // THE CLAIM: an ordinary startup, nothing failing, no attacker - and the operator's
        // proxy capability is not in the log.
        expect(stderr, `${PATH_MARKER} must not reach stderr`).not.toContain(PATH_MARKER);
        expect(stdout, `${PATH_MARKER} must not reach stdout`).not.toContain(PATH_MARKER);

        // THE OPPOSITE CLAIM: the line still identifies the upstream. Without this, "log
        // nothing" would pass.
        const initialized = logEntries(stderr).find(
          (entry) => entry.message === 'BookStack API client initialized'
        );
        expect(initialized, 'the client must still report which upstream it is on').toBeDefined();
        expect(initialized?.base_origin).toBe('http://127.0.0.1:9/');
        expect(initialized?.base_path_segments).toBe(2);
        expect(initialized?.base_path_digest).toMatch(/^[0-9a-f]{12}$/);
        expect(initialized?.baseUrl).toBeUndefined();
      },
      REPLY_TIMEOUT_MS + 10_000
    );
  }

  it(
    'withholds the path of a refused base URL, while still naming the setting and the fault',
    async () => {
      // The R6-W3 vector exactly: the marker sits in the PATH and the violation is in the
      // QUERY. The old refusal quoted `scheme://host/path` while complaining about the
      // query, so the marker came back verbatim - through the config error, the
      // `config_errors` log line, and the uncaught startup error, all three.
      const server = spawnStdioServer({
        BOOKSTACK_BASE_URL: `https://books.example/${PATH_MARKER}/api?invalid=1`,
      });

      // The process refuses to start, so there is no handshake to wait for. Give it long
      // enough to have written whatever it is going to write.
      await Bun.sleep(2_000);

      const stderr = server.stderrText();
      const stdout = server.stdoutLines().join('\n');

      expect(stderr, `${PATH_MARKER} must not reach stderr`).not.toContain(PATH_MARKER);
      expect(stdout, `${PATH_MARKER} must not reach stdout`).not.toContain(PATH_MARKER);

      // THE OPERATOR'S DIAGNOSTIC, which is the reason this cannot just be silence. They
      // must still be able to answer "which variable, and what is wrong with it" - the two
      // things they cannot look up, as opposed to the value, which is in their own hand.
      expect(stderr).toContain('Configuration validation failed');
      expect(stderr).toContain('bookstack.baseUrl');
      expect(stderr).toContain('must not carry a query string or fragment');
    },
    REPLY_TIMEOUT_MS
  );
});

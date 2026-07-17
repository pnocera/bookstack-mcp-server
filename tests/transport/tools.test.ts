/**
 * Transport tests: the published tool surface, driven over real HTTP.
 *
 * Why this file exists. The suite next door proves the parser and the auth layer, but
 * every request it sends is `initialize` - which the MCP SDK answers from the server's
 * own capabilities without ever entering a tool handler. Deleting every tool, or breaking
 * dispatch outright, left CI green. These tests send `tools/list`, `resources/list` and a
 * real `tools/call`, so registration and dispatch are the subject.
 *
 * No live BookStack, no Docker. BOOKSTACK_BASE_URL points at the in-process stub in
 * ./stub-bookstack.ts, which answers a small read-only slice of the API deterministically
 * and records what it was asked. That is what lets a `tools/call` run all the way through
 * validation, the axios client and the response path in a plain `bun test`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv from 'ajv';
import { type Config, ConfigManager } from '../../src/config/manager';
import { createHttpApp } from '../../src/server';
import { type BookStackStub, STUB_BOOKS, startBookStackStub } from './stub-bookstack';

const TEST_AUTH_TOKEN = 'tools-inbound-secret-0123456789';
const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * The complete published tool surface, spelled out rather than derived.
 *
 * Deriving this list from the server would make the test a tautology - it would agree
 * with whatever the server happened to register, including nothing. Written out, it is a
 * contract: adding, removing or renaming a tool fails here and the diff says exactly what
 * changed to a client's view of the server.
 */
const EXPECTED_TOOLS = [
  'bookstack_attachments_create',
  'bookstack_attachments_delete',
  'bookstack_attachments_list',
  'bookstack_attachments_read',
  'bookstack_attachments_update',
  'bookstack_audit_log_list',
  'bookstack_books_create',
  'bookstack_books_delete',
  'bookstack_books_export',
  'bookstack_books_list',
  'bookstack_books_read',
  'bookstack_books_update',
  'bookstack_chapters_create',
  'bookstack_chapters_delete',
  'bookstack_chapters_export',
  'bookstack_chapters_list',
  'bookstack_chapters_read',
  'bookstack_chapters_update',
  'bookstack_error_guides',
  'bookstack_help',
  'bookstack_images_create',
  'bookstack_images_delete',
  'bookstack_images_list',
  'bookstack_images_read',
  'bookstack_images_update',
  'bookstack_pages_create',
  'bookstack_pages_delete',
  'bookstack_pages_export',
  'bookstack_pages_list',
  'bookstack_pages_read',
  'bookstack_pages_update',
  'bookstack_permissions_read',
  'bookstack_permissions_update',
  'bookstack_recyclebin_delete_permanently',
  'bookstack_recyclebin_list',
  'bookstack_recyclebin_restore',
  'bookstack_roles_create',
  'bookstack_roles_delete',
  'bookstack_roles_list',
  'bookstack_roles_read',
  'bookstack_roles_update',
  'bookstack_search',
  'bookstack_server_info',
  'bookstack_shelves_create',
  'bookstack_shelves_delete',
  'bookstack_shelves_list',
  'bookstack_shelves_read',
  'bookstack_shelves_update',
  'bookstack_system_info',
  'bookstack_tool_categories',
  'bookstack_usage_examples',
  'bookstack_users_create',
  'bookstack_users_delete',
  'bookstack_users_list',
  'bookstack_users_read',
  'bookstack_users_update',
] as const;

/** Same reasoning as EXPECTED_TOOLS: the resource URIs are a client-visible contract. */
const EXPECTED_RESOURCES = [
  'bookstack://books',
  'bookstack://books/{id}',
  'bookstack://chapters',
  'bookstack://chapters/{id}',
  'bookstack://pages',
  'bookstack://pages/{id}',
  'bookstack://search/{query}',
  'bookstack://shelves',
  'bookstack://shelves/{id}',
  'bookstack://users',
  'bookstack://users/{id}',
] as const;

/**
 * Env keys this suite pins. ConfigManager is a process-wide singleton and bun runs test
 * files in one process, so the originals go back in afterAll - neighbouring suites
 * reload() the same singleton and expect their own environment.
 */
const PINNED_ENV = [
  'BOOKSTACK_BASE_URL',
  'BOOKSTACK_API_TOKEN',
  'LOG_LEVEL',
  'LOG_FORMAT',
] as const;

const savedEnv = new Map<string, string | undefined>();
let config: Config;
let stub: BookStackStub;

/** Minimal shapes of the JSON-RPC replies asserted on below. */
interface ToolListEntry {
  name: string;
  description: string;
  /**
   * Deliberately not typed as `MCPInputSchema`: this is the JSON that came back over the
   * wire, and a client knows nothing of our types. Reading it as an opaque schema object
   * is also what lets ajv treat it exactly as a client's generator would.
   */
  inputSchema: Record<string, unknown> & { type?: string };
}
interface ResourceListEntry {
  uri: string;
  name: string;
}
interface ToolCallContent {
  type: string;
  text: string;
}
interface JsonRpcReply {
  result?: {
    tools?: ToolListEntry[];
    resources?: ResourceListEntry[];
    content?: ToolCallContent[];
  };
  error?: { code: number; message: string };
}

/** The JSON a books list handler returns, once unwrapped from MCP's text content. */
interface BooksListPayload {
  data: Array<{ id: number; name: string; slug: string }>;
  total: number;
}

beforeAll(() => {
  for (const key of PINNED_ENV) {
    savedEnv.set(key, process.env[key]);
  }

  stub = startBookStackStub();
  process.env.BOOKSTACK_BASE_URL = stub.baseUrl;
  process.env.BOOKSTACK_API_TOKEN = stub.apiToken;
  process.env.LOG_LEVEL = 'error';
  process.env.LOG_FORMAT = 'json';

  // reload() rather than getConfig(): another suite may already have populated the
  // singleton, and /message builds its server from whatever the singleton holds.
  config = ConfigManager.getInstance().reload();
});

afterAll(async () => {
  await stub.stop();
  for (const key of PINNED_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    ConfigManager.getInstance().reload();
  } catch {
    // The restored environment need not validate on its own (a plain `bun test` has no
    // BOOKSTACK_API_TOKEN). That is the state this suite found, so leave it there.
  }
});

const running: Server[] = [];

async function startApp(): Promise<string> {
  const app = createHttpApp({
    config,
    http: { bodyLimitBytes: BODY_LIMIT_BYTES, authToken: TEST_AUTH_TOKEN },
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  running.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  stub.requests.length = 0;
});

/** Send one JSON-RPC request to /message and return the decoded reply. */
async function rpc(
  url: string,
  method: string,
  params?: Record<string, unknown>
): Promise<{ status: number; reply: JsonRpcReply }> {
  const response = await fetch(`${url}/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The Streamable HTTP transport requires both media types on POST.
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TEST_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, reply: (await response.json()) as JsonRpcReply };
}

/**
 * A JSON Schema validator built from nothing but the published contract - the same
 * position an MCP client is in when it generates a call from `tools/list`.
 *
 * `strictSchema` is off because ajv's strict mode is a schema-authoring linter rather than
 * a JSON Schema conformance check: it objects to a `required` inside a `not` branch naming
 * properties that branch does not itself declare, which is precisely how the exactly-one
 * rules are (validly) written. `validateFormats` is off for the same reason it is off in
 * JSON Schema itself - `format` is an annotation unless a vocabulary is loaded, and none of
 * the conditional rules under test is expressed with one.
 */
const ajv = new Ajv({ allErrors: true, strictSchema: false, validateFormats: false });

/** One input, and the verdict the tool's contract should reach on it. */
interface AgreementRow {
  /** Names the case in the failure diff. */
  label: string;
  input: Record<string, unknown>;
  /** True when BOTH halves of the contract should accept it. */
  accepted: boolean;
}

/** What each half of the contract actually did with one row. */
interface AgreementOutcome {
  label: string;
  /** Accepted by the JSON Schema published on `tools/list`. */
  schema: boolean;
  /** Accepted by the strict runtime validator inside the real handler. */
  runtime: boolean;
}

async function publishedInputSchema(url: string, toolName: string): Promise<ToolListEntry> {
  const { reply } = await rpc(url, 'tools/list');
  const tool = (reply.result?.tools ?? []).find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`${toolName} is not published on tools/list`);
  }
  return tool;
}

/**
 * Did the real handler's validator accept this input?
 *
 * Whether the call reached BookStack is the signal, and it has to be: validation runs
 * before the client, so a recorded request means the input got through it and no recorded
 * request means it did not. The reply itself cannot answer the question - the stub 404s a
 * page create, so an accepted input and a rejected one both come back as JSON-RPC errors,
 * and reading their prose would test the error text rather than the decision.
 */
async function runtimeAccepts(
  url: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<boolean> {
  stub.requests.length = 0;
  const { reply } = await rpc(url, 'tools/call', { name: toolName, arguments: input });
  const reachedBookStack = stub.requests.length > 0;

  // A call that neither reached BookStack nor reported anything would read as a clean
  // rejection here while actually being a hole in dispatch.
  if (!reachedBookStack && reply.error === undefined) {
    throw new Error(
      `${toolName} neither called BookStack nor errored for ${JSON.stringify(input)}`
    );
  }
  return reachedBookStack;
}

/** Run every row through both halves of the contract and report what each one did. */
async function agreementMatrix(
  url: string,
  toolName: string,
  rows: readonly AgreementRow[]
): Promise<AgreementOutcome[]> {
  const validateSchema = ajv.compile(
    await publishedInputSchema(url, toolName).then((t) => t.inputSchema)
  );

  const outcomes: AgreementOutcome[] = [];
  for (const row of rows) {
    outcomes.push({
      label: row.label,
      schema: validateSchema(row.input),
      runtime: await runtimeAccepts(url, toolName, row.input),
    });
  }
  return outcomes;
}

/** The contract as intended: each half reaching the row's verdict, and so agreeing. */
function intendedOutcomes(rows: readonly AgreementRow[]): AgreementOutcome[] {
  return rows.map((row) => ({ label: row.label, schema: row.accepted, runtime: row.accepted }));
}

describe('tools/list over HTTP', () => {
  it('publishes exactly the expected tool surface', async () => {
    const url = await startApp();

    const { status, reply } = await rpc(url, 'tools/list');

    expect(status).toBe(200);
    const names = (reply.result?.tools ?? []).map((tool) => tool.name).sort();
    // Count first: a bare length mismatch reports far more clearly than a 56-entry diff.
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    expect(names).toHaveLength(56);
    expect(names).toEqual([...EXPECTED_TOOLS]);
  });

  it('publishes a usable JSON Schema and description for every tool', async () => {
    // A registered-but-unusable tool (empty schema, blank description) would satisfy the
    // name check above while being undiscoverable to a client generating calls from the
    // machine contract.
    const url = await startApp();

    const { reply } = await rpc(url, 'tools/list');

    for (const tool of reply.result?.tools ?? []) {
      expect(tool.inputSchema.type, `${tool.name} inputSchema.type`).toBe('object');
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(0);
      // Every published schema must be a schema a client can actually build a validator
      // from: a mistyped keyword or a malformed branch fails here rather than silently
      // becoming an annotation the client ignores.
      expect(
        () => ajv.compile(tool.inputSchema),
        `${tool.name} inputSchema compiles`
      ).not.toThrow();
    }
  });
});

/**
 * The published schema and the runtime validator, held against each other.
 *
 * MCP clients generate calls from `tools/list` and never see the zod schemas, so where the
 * two disagree the client emits payloads the server rejects - and the disagreement is
 * invisible to a test that checks only that a schema exists. Both of these tools carry a
 * conditional requirement that was enforced at runtime and absent from the contract:
 * `bookstack_permissions_update` advertised `{ inheriting: false }` as complete when
 * BookStack demands all four action flags with it, and `bookstack_pages_create` advertised
 * `name` as the only requirement when a page needs a parent and content too.
 *
 * Each row therefore goes through BOTH halves - ajv over the schema exactly as published,
 * and the real handler over HTTP - and the two must reach the same verdict, and the right
 * one. Asserting the whole matrix in one `toEqual` makes a regression report which rows
 * moved and which way.
 */
describe('published JSON Schema agrees with runtime validation', () => {
  /**
   * BookStack states the fallback flags as
   * `required_if:fallback_permissions.inheriting,false`, and nulls all four when
   * inheriting - so `inheriting` selects the property set, in both directions.
   */
  const PERMISSIONS_ROWS: readonly AgreementRow[] = [
    {
      label: 'inheriting:false alone - the four flags it requires are missing',
      input: { content_type: 'book', content_id: 5, fallback_permissions: { inheriting: false } },
      accepted: false,
    },
    {
      label: 'inheriting:false with only one of the four flags',
      input: {
        content_type: 'book',
        content_id: 5,
        fallback_permissions: { inheriting: false, view: true },
      },
      accepted: false,
    },
    {
      label: 'inheriting:false with all four flags',
      input: {
        content_type: 'book',
        content_id: 5,
        fallback_permissions: {
          inheriting: false,
          view: true,
          create: false,
          update: false,
          delete: false,
        },
      },
      accepted: true,
    },
    {
      label: 'inheriting:true alone',
      input: { content_type: 'book', content_id: 5, fallback_permissions: { inheriting: true } },
      accepted: true,
    },
    {
      label: 'inheriting:true with a flag - inherited permissions cannot be overridden',
      input: {
        content_type: 'book',
        content_id: 5,
        fallback_permissions: { inheriting: true, view: true },
      },
      accepted: false,
    },
    {
      label: 'no fallback_permissions at all - the category is left untouched',
      input: { content_type: 'book', content_id: 5, owner_id: 3 },
      accepted: true,
    },
    {
      label: 'inheriting:false, all four flags, plus an unknown flag',
      input: {
        content_type: 'book',
        content_id: 5,
        fallback_permissions: {
          inheriting: false,
          view: true,
          create: false,
          update: false,
          delete: false,
          admin: true,
        },
      },
      accepted: false,
    },
  ];

  /**
   * BookStack states both rules as `required_without` (`book_id`/`chapter_id` and
   * `html`/`markdown`), and Laravel counts an empty string as absent - hence the empty-html
   * rows, which are the boundary the `minLength` inside the content branches encodes.
   */
  const PAGE_CREATE_ROWS: readonly AgreementRow[] = [
    { label: 'name only - no parent, no content', input: { name: 'P' }, accepted: false },
    { label: 'name + book_id - no content', input: { name: 'P', book_id: 1 }, accepted: false },
    {
      label: 'name + chapter_id - no content',
      input: { name: 'P', chapter_id: 1 },
      accepted: false,
    },
    {
      label: 'name + html - no parent',
      input: { name: 'P', html: '<p>Body</p>' },
      accepted: false,
    },
    {
      label: 'name + book_id + html',
      input: { name: 'P', book_id: 1, html: '<p>Body</p>' },
      accepted: true,
    },
    {
      label: 'name + book_id + markdown',
      input: { name: 'P', book_id: 1, markdown: '# Body' },
      accepted: true,
    },
    {
      label: 'name + chapter_id + markdown',
      input: { name: 'P', chapter_id: 1, markdown: '# Body' },
      accepted: true,
    },
    {
      label: 'name + book_id + both html and markdown',
      input: { name: 'P', book_id: 1, html: '<p>Body</p>', markdown: '# Body' },
      accepted: true,
    },
    {
      label: 'name + book_id + empty html - an empty string is not content',
      input: { name: 'P', book_id: 1, html: '' },
      accepted: false,
    },
    {
      label: 'name + book_id + empty html + markdown - markdown carries the content',
      input: { name: 'P', book_id: 1, html: '', markdown: '# Body' },
      accepted: true,
    },
    {
      label: 'name + book_id:0 + html - 0 is not a book',
      input: { name: 'P', book_id: 0, html: '<p>Body</p>' },
      accepted: false,
    },
    {
      label: 'name + book_id:0 + chapter_id + html - the chapter does not excuse the book_id',
      input: { name: 'P', book_id: 0, chapter_id: 1, html: '<p>Body</p>' },
      accepted: false,
    },
    {
      label: 'name + book_id + html + unknown property',
      input: { name: 'P', book_id: 1, html: '<p>Body</p>', publish: true },
      accepted: false,
    },
  ];

  it('agrees on bookstack_permissions_update fallback_permissions', async () => {
    const url = await startApp();

    const outcomes = await agreementMatrix(url, 'bookstack_permissions_update', PERMISSIONS_ROWS);

    expect(outcomes).toEqual(intendedOutcomes(PERMISSIONS_ROWS));
  });

  it('agrees on bookstack_pages_create parent and content requirements', async () => {
    const url = await startApp();

    const outcomes = await agreementMatrix(url, 'bookstack_pages_create', PAGE_CREATE_ROWS);

    expect(outcomes).toEqual(intendedOutcomes(PAGE_CREATE_ROWS));
  });

  /**
   * The `examples[].input` of both tools, which is what an LLM copies. An example the
   * contract rejects teaches a call shape the server refuses, and an example neither half
   * accepts would be the loudest possible symptom of the two drifting apart again.
   */
  const EXAMPLE_ROWS: readonly { tool: string; rows: readonly AgreementRow[] }[] = [
    {
      tool: 'bookstack_permissions_update',
      rows: [
        {
          label: 'example: restrict a book to a single role',
          input: {
            content_type: 'book',
            content_id: 5,
            fallback_permissions: {
              inheriting: false,
              view: false,
              create: false,
              update: false,
              delete: false,
            },
            role_permissions: [
              { role_id: 3, view: true, create: false, update: false, delete: false },
            ],
          },
          accepted: true,
        },
        {
          label: 'example: hand an item back to inheriting from its parent',
          input: {
            content_type: 'book',
            content_id: 5,
            fallback_permissions: { inheriting: true },
          },
          accepted: true,
        },
        {
          label: 'example: transfer ownership without touching permissions',
          input: { content_type: 'book', content_id: 5, owner_id: 12 },
          accepted: true,
        },
      ],
    },
    {
      tool: 'bookstack_pages_create',
      rows: [
        {
          label: 'example: create a markdown page in a book',
          input: {
            book_id: 5,
            name: 'Installation Guide',
            markdown: '# Installation\n\nRun `npm install` to get started.',
          },
          accepted: true,
        },
      ],
    },
  ];

  it('accepts every published example of both tools through schema and handler alike', async () => {
    const url = await startApp();

    for (const { tool, rows } of EXAMPLE_ROWS) {
      const outcomes = await agreementMatrix(url, tool, rows);

      expect(outcomes, `${tool} examples`).toEqual(intendedOutcomes(rows));
    }
  });
});

/**
 * SCALAR CONSTRAINTS, ACROSS THE WHOLE PUBLISHED SURFACE.
 *
 * The matrix above proves two conditionals - the permissions branches and the page
 * parent/content alternatives - and R4-W4 is what was left outside them. Every create tool
 * published `required: ['name']` with no `minLength`, so AJV accepted `name: ''` while the
 * handler rejected it; `language` described its alpha-dash rule in prose only.
 *
 * And both halves were wrong together about blanks. `minLength: 1` and zod's `.min(1)`
 * count CHARACTERS, so `name: '   '` and `html: '   '` satisfied both - while BookStack
 * trims the body before validating and rejects them as missing. Verified live on
 * v26.05.2 rather than reasoned about (see NONBLANK_PATTERN in src/types.ts):
 *
 *   POST /api/books  {"name":"   "}                        -> 422 name required
 *   POST /api/pages  {"book_id":N,"name":"P","html":"   "} -> 422 html required when
 *                                                                 markdown not present
 *
 * The old test suite had an `html: ''` row and no whitespace row, so it passed while
 * locking in the incomplete reading. Every whitespace row below is that gap.
 *
 * A VALID CONTROL FOR EVERY TOOL. Each entry carries at least one row that must be
 * ACCEPTED, enforced by the `every case offers a control` test. Without it a tool whose
 * name was misspelled, or whose handler rejected everything, would pass the whole matrix
 * on rejections that had nothing to do with the constraint under test.
 */
describe('published JSON Schema agrees with runtime validation on scalar constraints', () => {
  /** A string of `length` ordinary characters. */
  const chars = (length: number): string => 'x'.repeat(length);

  interface ScalarCase {
    tool: string;
    rows: readonly AgreementRow[];
  }

  /**
   * `name`, as every entity create publishes it: required, 1..255, and not just spaces.
   * Written once because the four tools state the identical rule and drift apart when
   * their rows are maintained separately.
   */
  const entityNameRows = (rest: Record<string, unknown>): readonly AgreementRow[] => [
    { label: 'control: a valid name', input: { ...rest, name: 'Valid Name' }, accepted: true },
    { label: 'empty name', input: { ...rest, name: '' }, accepted: false },
    { label: 'whitespace-only name', input: { ...rest, name: '   ' }, accepted: false },
    { label: 'tab/newline-only name', input: { ...rest, name: '\t\n' }, accepted: false },
    {
      label: 'name at the 255-character maximum',
      input: { ...rest, name: chars(255) },
      accepted: true,
    },
    {
      label: 'name one character over the maximum',
      input: { ...rest, name: chars(256) },
      accepted: false,
    },
  ];

  const SCALAR_CASES: readonly ScalarCase[] = [
    { tool: 'bookstack_books_create', rows: entityNameRows({}) },
    { tool: 'bookstack_shelves_create', rows: entityNameRows({}) },
    { tool: 'bookstack_chapters_create', rows: entityNameRows({ book_id: 1 }) },
    {
      tool: 'bookstack_pages_create',
      rows: entityNameRows({ book_id: 1, html: '<p>Body</p>' }),
    },
    // The update side. Upstream does NOT reject a whitespace-only name here - it accepts
    // it and blanks the entity (PUT /api/books/N {"name":"   "} -> 200, name now '',
    // verified live). These rows pin the deliberate choice to refuse instead.
    { tool: 'bookstack_books_update', rows: entityNameRows({ id: 1 }) },
    { tool: 'bookstack_shelves_update', rows: entityNameRows({ id: 1 }) },
    { tool: 'bookstack_chapters_update', rows: entityNameRows({ id: 1 }) },
    { tool: 'bookstack_pages_update', rows: entityNameRows({ id: 1 }) },
    {
      tool: 'bookstack_pages_create',
      rows: [
        {
          label: 'control: real html content',
          input: { book_id: 1, name: 'P', html: '<p>Body</p>' },
          accepted: true,
        },
        {
          label: 'whitespace-only html, no markdown - BookStack trims it to nothing',
          input: { book_id: 1, name: 'P', html: '   ' },
          accepted: false,
        },
        {
          label: 'newline/tab-only markdown, no html',
          input: { book_id: 1, name: 'P', markdown: '\n\t ' },
          accepted: false,
        },
        {
          label: 'whitespace-only html alongside real markdown - markdown carries it',
          input: { book_id: 1, name: 'P', html: '   ', markdown: '# Body' },
          accepted: true,
        },
        {
          label: 'both blank',
          input: { book_id: 1, name: 'P', html: '   ', markdown: '  ' },
          accepted: false,
        },
      ],
    },
    {
      tool: 'bookstack_users_create',
      rows: [
        {
          label: 'control: a valid user',
          input: { name: 'Valid User', email: 'valid@example.com' },
          accepted: true,
        },
        { label: 'empty name', input: { name: '', email: 'v@example.com' }, accepted: false },
        {
          label: 'whitespace-only name',
          input: { name: '   ', email: 'v@example.com' },
          accepted: false,
        },
        {
          label: 'name at the 100-character maximum',
          input: { name: chars(100), email: 'v@example.com' },
          accepted: true,
        },
        {
          label: 'name one character over the maximum',
          input: { name: chars(101), email: 'v@example.com' },
          accepted: false,
        },
        {
          label: 'control: a well-formed language',
          input: { name: 'U', email: 'v@example.com', language: 'pt_BR' },
          accepted: true,
        },
        {
          label: 'language with a space - alpha_dash rejects it upstream',
          input: { name: 'U', email: 'v@example.com', language: 'fr FR' },
          accepted: false,
        },
        {
          label: 'language with a dot',
          input: { name: 'U', email: 'v@example.com', language: 'fr.FR' },
          accepted: false,
        },
        {
          label: 'empty language',
          input: { name: 'U', email: 'v@example.com', language: '' },
          accepted: false,
        },
        {
          label: 'whitespace-only language',
          input: { name: 'U', email: 'v@example.com', language: '   ' },
          accepted: false,
        },
        {
          label: 'language at the 15-character maximum',
          input: { name: 'U', email: 'v@example.com', language: chars(15) },
          accepted: true,
        },
        {
          label: 'language one character over the maximum',
          input: { name: 'U', email: 'v@example.com', language: chars(16) },
          accepted: false,
        },
      ],
    },
    {
      tool: 'bookstack_users_update',
      rows: [
        { label: 'control: a rename', input: { id: 1, name: 'New Name' }, accepted: true },
        { label: 'whitespace-only name', input: { id: 1, name: '   ' }, accepted: false },
        {
          label: 'malformed language',
          input: { id: 1, language: 'fr FR' },
          accepted: false,
        },
      ],
    },
    {
      tool: 'bookstack_roles_create',
      rows: [
        {
          label: 'control: a valid display_name',
          input: { display_name: 'Editors' },
          accepted: true,
        },
        { label: 'empty display_name', input: { display_name: '' }, accepted: false },
        {
          label: 'whitespace-only display_name',
          input: { display_name: '   ' },
          accepted: false,
        },
        {
          label: 'display_name below the 3-character minimum',
          input: { display_name: 'ab' },
          accepted: false,
        },
        {
          label: 'display_name at the 3-character minimum',
          input: { display_name: 'abc' },
          accepted: true,
        },
        {
          label: 'display_name at the 180-character maximum',
          input: { display_name: chars(180) },
          accepted: true,
        },
        {
          label: 'display_name one character over the maximum',
          input: { display_name: chars(181) },
          accepted: false,
        },
        // THE MINIMUM IS JUDGED ON WHAT BOOKSTACK VALIDATES, NOT ON WHAT WAS TYPED.
        //
        // This row used to read `accepted: true`, with a comment calling the disagreement a
        // known limit of JSON Schema. R5-W4 is right that it was neither: upstream answers
        // 422 here, so the row recorded agreement with a bug, and "at least three characters
        // after trimming" IS expressible as a pattern - see trimmedMinLengthPattern in
        // src/types.ts, which both halves now compile from. Verified live on v26.05.2:
        //
        //   POST /api/roles {"display_name":"   a"}   -> 422 min:3 (1 character kept)
        //   POST /api/roles {"display_name":"  ab  "} -> 422 min:3 (2 characters kept)
        {
          label: 'padded short display_name - upstream 422s on the trimmed length',
          input: { display_name: '   a' },
          accepted: false,
        },
        {
          label: 'padded two-character display_name - 6 raw characters, 2 after trimming',
          input: { display_name: '  ab  ' },
          accepted: false,
        },
        {
          label: 'control: padding around a long-enough name is not itself a problem',
          input: { display_name: '  Editors  ' },
          accepted: true,
        },
        {
          label: 'control: three characters that survive trimming, one of them a space',
          input: { display_name: 'a b' },
          accepted: true,
        },
      ],
    },
    {
      tool: 'bookstack_roles_update',
      rows: [
        { label: 'control: a rename', input: { id: 1, display_name: 'Editors' }, accepted: true },
        {
          label: 'whitespace-only display_name',
          input: { id: 1, display_name: '   ' },
          accepted: false,
        },
        // The update side of the same rule, and it is not a copy: BookStack's update rule
        // carries no `required`, so the two ends behave differently and both were checked.
        // Verified live on v26.05.2:
        //
        //   PUT /api/roles/2 {"display_name":"   a"} -> 422 min:3, role name unchanged
        {
          label: 'padded short display_name - upstream 422s on the trimmed length here too',
          input: { id: 1, display_name: '   a' },
          accepted: false,
        },
        {
          label: 'display_name below the 3-character minimum',
          input: { id: 1, display_name: 'ab' },
          accepted: false,
        },
        {
          label: 'control: padding around a long-enough name',
          input: { id: 1, display_name: '  Editors  ' },
          accepted: true,
        },
      ],
    },
    {
      tool: 'bookstack_images_create',
      rows: [
        {
          label: 'control: a named gallery image',
          input: { uploaded_to: 1, name: 'Diagram', image: 'aGVsbG8=' },
          accepted: true,
        },
        {
          label: 'empty name - optional upstream, but not blank when given',
          input: { uploaded_to: 1, name: '', image: 'aGVsbG8=' },
          accepted: false,
        },
        {
          label: 'name at the 180-character maximum',
          input: { uploaded_to: 1, name: chars(180), image: 'aGVsbG8=' },
          accepted: true,
        },
        {
          label: 'name one character over the maximum',
          input: { uploaded_to: 1, name: chars(181), image: 'aGVsbG8=' },
          accepted: false,
        },
      ],
    },
    {
      tool: 'bookstack_attachments_create',
      rows: [
        {
          label: 'control: a base64 attachment',
          input: { uploaded_to: 1, name: 'Spec', file: 'aGVsbG8=' },
          accepted: true,
        },
        {
          label: 'empty name',
          input: { uploaded_to: 1, name: '', file: 'aGVsbG8=' },
          accepted: false,
        },
        {
          label: 'name at the 255-character maximum',
          input: { uploaded_to: 1, name: chars(255), file: 'aGVsbG8=' },
          accepted: true,
        },
        {
          label: 'name one character over the maximum',
          input: { uploaded_to: 1, name: chars(256), file: 'aGVsbG8=' },
          accepted: false,
        },
      ],
    },
    {
      // `query` is `['required']` upstream, and Laravel's `required` is judged after the
      // TrimStrings middleware - so a query of spaces is MISSING, not short. The matrix
      // tested only `''` and stayed green while both halves accepted `'   '` and forwarded
      // it. Verified live on v26.05.2 (R5-W4):
      //
      //   GET /api/search?query=%20%20%20 -> 422 "The query field is required."
      //   GET /api/search?query=%09%0A    -> 422 "The query field is required."
      //   GET /api/search?query=a         -> 200
      tool: 'bookstack_search',
      rows: [
        { label: 'control: a real query', input: { query: 'installation' }, accepted: true },
        { label: 'empty query', input: { query: '' }, accepted: false },
        { label: 'whitespace-only query', input: { query: '   ' }, accepted: false },
        { label: 'tab/newline-only query', input: { query: '\t\n' }, accepted: false },
        {
          label: 'control: a single character is a legitimate query',
          input: { query: 'a' },
          accepted: true,
        },
        {
          label: 'control: a padded query - the term survives trimming',
          input: { query: '  installation  ' },
          accepted: true,
        },
      ],
    },
  ];

  it('every scalar case offers a valid control', () => {
    // The guard on the guard. A case made only of rejections would pass its own matrix
    // even if the tool rejected everything for an unrelated reason - a typo'd tool name,
    // a handler that always throws. Requiring an accepted row makes each matrix prove
    // that the tool works AND that the constraint bites, rather than only the latter.
    for (const { tool, rows } of SCALAR_CASES) {
      expect(
        rows.some((row) => row.accepted),
        `${tool} has no accepted control row`
      ).toBe(true);
    }
  });

  for (const { tool, rows } of SCALAR_CASES) {
    it(`agrees on ${tool}: ${rows.length} scalar rows`, async () => {
      const url = await startApp();

      const outcomes = await agreementMatrix(url, tool, rows);

      expect(outcomes).toEqual(intendedOutcomes(rows));
    });
  }
});

/**
 * The strict boundary, over the real HTTP route rather than a direct handler call.
 *
 * tests/unit/strict-validation.test.ts drives these classes through the tool handlers on a
 * fake client, which is where the breadth lives. This is the same claim carried across the
 * transport an MCP client actually speaks: real `tools/call` dispatch, the real strict
 * validator, the real axios client - and a stub that records every request it receives, so
 * "no client call occurred" is observed rather than inferred.
 *
 * `runtimeAccepts` reads the verdict off `stub.requests`, which is what separates "validation
 * stopped it" from "BookStack rejected it". The stub would 404 most of these, so a test that
 * read the error text instead would pass whether or not the request ever left the process.
 */
describe('malformed tools/call arguments are refused before BookStack is contacted', () => {
  /**
   * Ids, over both halves of the contract. The `minimum: 1` rows are the ones that used to
   * disagree: `entityId` is `.int().positive()`, but the published schema said only
   * `type: 'integer'`, so a client generating from `tools/list` read 0 as a legal book id.
   */
  const ID_ROWS: readonly AgreementRow[] = [
    { label: 'books_read: a valid id', input: { id: 1 }, accepted: true },
    { label: 'books_read: id 0 - not an entity id', input: { id: 0 }, accepted: false },
    { label: 'books_read: negative id', input: { id: -1 }, accepted: false },
    { label: 'books_read: fractional id', input: { id: 1.5 }, accepted: false },
    { label: 'books_read: numeric string id', input: { id: '1' }, accepted: false },
    {
      label: 'books_read: unknown sibling key alongside a valid id',
      input: { id: 1, nmae: 'typo' },
      accepted: false,
    },
  ];

  it('agrees with the published schema on bookstack_books_read ids', async () => {
    const url = await startApp();

    const outcomes = await agreementMatrix(url, 'bookstack_books_read', ID_ROWS);

    expect(outcomes).toEqual(intendedOutcomes(ID_ROWS));
  });

  it('sends nothing to BookStack for a malformed export format', async () => {
    const url = await startApp();

    // The enum is all that stands between a typo and BookStack's export controller, and the
    // format used to be cast rather than validated.
    expect(await runtimeAccepts(url, 'bookstack_books_export', { id: 1, format: 'docx' })).toBe(
      false
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('sends nothing to BookStack for an argument to a no-argument tool', async () => {
    const url = await startApp();

    // `bookstack_system_info` is the one tool whose handler could be made permissive without
    // any schema to contradict it - "takes no parameters" is only true if an empty strict
    // object is actually applied.
    expect(await runtimeAccepts(url, 'bookstack_system_info', { book_id: 5 })).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  it('sends no search for a query BookStack would reject as missing', async () => {
    const url = await startApp();

    // The deterministic 422 R5-W4 names, stopped before it is spent. `query` is `required`
    // upstream and Laravel trims first, so '   ' is missing rather than short: the live API
    // answers 422 "The query field is required." for it (v26.05.2). An empty `stub.requests`
    // is what says this server no longer makes that round trip on the caller's behalf.
    expect(await runtimeAccepts(url, 'bookstack_search', { query: '   ' })).toBe(false);
    expect(await runtimeAccepts(url, 'bookstack_search', { query: '\t\n' })).toBe(false);
    expect(stub.requests).toHaveLength(0);

    // The control, on the same route: a real query does leave the process.
    expect(await runtimeAccepts(url, 'bookstack_search', { query: 'installation' })).toBe(true);
  });

  it('sends no role write for a display_name that is too short once trimmed', async () => {
    const url = await startApp();

    // '   a' has four characters and BookStack keeps one of them, so `min:3` fails upstream
    // on create and on update alike (both verified live on v26.05.2). Counting the padding
    // is what made both halves agree to forward it.
    expect(await runtimeAccepts(url, 'bookstack_roles_create', { display_name: '   a' })).toBe(
      false
    );
    expect(
      await runtimeAccepts(url, 'bookstack_roles_update', { id: 1, display_name: '   a' })
    ).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  it('sends no DELETE for a user named as its own ownership heir', async () => {
    const url = await startApp();

    // The destructive case R3-W1 named. Upstream would accept it: BookStack deletes the row
    // before looking the heir up, answers 204, and leaves every book the account owned with
    // no owner. So the only place it can be stopped is before the request - which is what an
    // empty `stub.requests` is testifying to here.
    //
    // Deliberately not an `agreementMatrix` row: JSON Schema has no way to say "this integer
    // must differ from that one", so the published contract cannot express this constraint
    // and states it in the property description instead. The two halves genuinely disagree
    // here, and asserting agreement would be asserting something false.
    expect(
      await runtimeAccepts(url, 'bookstack_users_delete', { id: 5, migrate_ownership_id: 5 })
    ).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('resources/list over HTTP', () => {
  it('publishes exactly the expected resource surface', async () => {
    const url = await startApp();

    const { status, reply } = await rpc(url, 'resources/list');

    expect(status).toBe(200);
    const uris = (reply.result?.resources ?? []).map((resource) => resource.uri).sort();
    expect(uris).toHaveLength(11);
    expect(uris).toEqual([...EXPECTED_RESOURCES]);
  });
});

describe('tools/call over HTTP', () => {
  it('dispatches a read-only call through to BookStack and returns its data', async () => {
    // The end-to-end path `initialize` never touches: MCP dispatch -> tool handler ->
    // validation -> axios client -> BookStack -> JSON back through MCP content.
    const url = await startApp();

    const { status, reply } = await rpc(url, 'tools/call', {
      name: 'bookstack_books_list',
      arguments: { count: 2 },
    });

    expect(status).toBe(200);
    expect(reply.error).toBeUndefined();
    const text = reply.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const payload = JSON.parse(text as string) as BooksListPayload;
    expect(payload.total).toBe(STUB_BOOKS.length);
    expect(payload.data.map((book) => book.name)).toEqual(STUB_BOOKS.map((book) => book.name));

    // The call really left the process.
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.method).toBe('GET');
    expect(stub.requests[0]?.path).toBe('/books');
  });

  it('transmits list parameters to BookStack rather than dropping them', async () => {
    // `count: 1` against two fixture books: a dropped parameter comes back with both, so
    // this fails rather than quietly passing on the full list.
    const url = await startApp();

    const { reply } = await rpc(url, 'tools/call', {
      name: 'bookstack_books_list',
      arguments: { count: 1, offset: 1 },
    });

    const payload = JSON.parse(reply.result?.content?.[0]?.text as string) as BooksListPayload;
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]?.id).toBe(STUB_BOOKS[1].id);
    expect(stub.requests[0]?.query).toMatchObject({ count: '1', offset: '1' });
  });

  it('attaches the outbound BookStack credential', async () => {
    // The stub 401s an unauthenticated request, so a green assertion on the body already
    // implies the header; asserting it directly says *which* credential was spent.
    const url = await startApp();

    await rpc(url, 'tools/call', { name: 'bookstack_books_list', arguments: { count: 1 } });

    expect(stub.requests[0]?.authorization).toBe(`Token ${config.bookstack.apiToken}`);
  });

  it('reports an unknown tool as a JSON-RPC error, not a crash', async () => {
    const url = await startApp();

    const { status, reply } = await rpc(url, 'tools/call', {
      name: 'bookstack_not_a_tool',
      arguments: {},
    });

    expect(status).toBe(200);
    expect(reply.result).toBeUndefined();
    expect(reply.error?.message).toContain('bookstack_not_a_tool');
    // Nothing should have been forwarded to BookStack on an unknown name.
    expect(stub.requests).toHaveLength(0);
  });
});

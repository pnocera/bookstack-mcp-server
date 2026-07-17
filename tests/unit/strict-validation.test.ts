/**
 * The strict boundary, held against a client that records whether it was ever reached.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A MOCK-INTERACTION TEST.
 *
 * The projected-validation fix (handlers validate the WHOLE request object through a strict
 * schema, `validateId()` and its `Number()` coercion deleted) is implemented, but until now
 * it was guarded mainly by tests that MOCK `validateParams` and assert the mock was handed
 * an object. That asserts the wiring and nothing else: a mock validator accepts everything,
 * so reintroducing a projection, a coercion or a permissive no-argument handler would leave
 * those tests green. `tests/unit/books.test.ts` keeps that wiring check, deliberately - it
 * answers "was the whole object passed, under which schema name", which is a different
 * question from the one here.
 *
 * This suite uses the REAL `ValidationHandler`, in the strict mode the server ships (see
 * `strictMode: z.boolean().default(true)` in src/config/manager.ts, pinned by a test below
 * so this whole file cannot come to guard a mode nobody runs). No BookStack, no Docker, no
 * HTTP: the tools are built on a fake client, so a plain `bun test` runs it.
 *
 * WHAT "REJECTED" HAS TO MEAN HERE.
 *
 * That the handler threw is NOT sufficient evidence that validation stopped anything. A
 * request can leave the process and come back as a 404 or a 422, and the handler throws
 * either way - which is exactly how this repo previously carried a test named "rejects at
 * validation time" over a call that really did go out and really was rejected by BookStack.
 * The distinguishing signal is whether the client was called at all, so every row below
 * asserts the recorded call count alongside the verdict. A rejection that reached the client
 * fails here rather than reading as a pass.
 *
 * The positive control rows exist for the mirror-image failure: a harness that rejected
 * everything - a broken tool lookup, a fake client that throws - would satisfy every
 * rejection assertion in the file while proving nothing. The accepted rows are what make a
 * green run meaningful.
 */

import { describe, expect, it } from 'bun:test';
import { ConfigManager } from '../../src/config/manager';
import { buildTools, createRecordingClient, requireTool } from '../helpers/strict-tools';

/** One request, and the verdict the strict boundary should reach on it. */
interface Row {
  /** Names the case in the failure diff. */
  label: string;
  tool: string;
  input: unknown;
  /** True when the request is well-formed and should reach the client. */
  accepted: boolean;
}

/** What actually happened to one row. */
interface Outcome {
  label: string;
  /** The handler did not throw. */
  accepted: boolean;
  /**
   * How many times the client was called. This is the load-bearing field: `accepted: false`
   * with a non-zero count is a request that went out and was rejected somewhere else, which
   * is precisely the false green this file exists to make impossible.
   */
  clientCalls: number;
}

async function runRow(row: Row): Promise<Outcome> {
  // Rebuilt per row, so the recorded calls belong to exactly one request.
  const { calls, client } = createRecordingClient();
  const tool = requireTool(buildTools(client), row.tool);

  let accepted = true;
  try {
    await tool.handler(row.input);
  } catch {
    accepted = false;
  }

  return { label: row.label, accepted, clientCalls: calls.length };
}

async function runRows(rows: readonly Row[]): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const row of rows) {
    outcomes.push(await runRow(row));
  }
  return outcomes;
}

/**
 * The intended result of each row: the stated verdict, and a client that was reached only
 * if the request was accepted.
 */
function intended(rows: readonly Row[]): Outcome[] {
  return rows.map((row) => ({
    label: row.label,
    accepted: row.accepted,
    clientCalls: row.accepted ? 1 : 0,
  }));
}

describe('the shipped validation default', () => {
  /**
   * Env this test pins. ConfigManager is a process-wide singleton and bun runs test files in
   * one process, so the originals go back afterwards - neighbouring suites reload() the same
   * singleton and expect their own environment.
   *
   * The two BookStack keys are here only because ConfigManager refuses to build a config at
   * all without a token, and a plain `bun test` has none. They point nowhere: nothing in this
   * file makes a request.
   */
  const PINNED_ENV = ['BOOKSTACK_BASE_URL', 'BOOKSTACK_API_TOKEN', 'VALIDATION_STRICT_MODE'];

  it('is strict, which is the mode every row in this file assumes', () => {
    // Without this, VALIDATION_STRICT_MODE could default to false - reinstating
    // log-and-forward for every schema in the server - and this entire suite would sail on
    // green, because it constructs its own strict ValidationHandler.
    const saved = new Map(PINNED_ENV.map((key) => [key, process.env[key]]));

    process.env.BOOKSTACK_BASE_URL = 'http://127.0.0.1:9/api';
    process.env.BOOKSTACK_API_TOKEN = 'strict-default-id:strict-default-secret';
    delete process.env.VALIDATION_STRICT_MODE;

    try {
      expect(ConfigManager.getInstance().reload().validation.strictMode).toBe(true);
    } finally {
      for (const [key, value] of saved) {
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
        // BOOKSTACK_API_TOKEN). That is the state this file found it in, so leave it there.
      }
    }
  });
});

/**
 * Read and delete, addressed by a single `id`.
 *
 * These are the tools R2-W1 named: each used to run its id through `validateId()`, which
 * took the id ALONE - so no sibling key was ever in front of a schema - and ran `Number()`
 * over it, so '5', '5.0' and ' 5 ' all became 5 behind the caller's back. Both halves of
 * that are what these rows pin.
 */
const ID_ROWS: readonly Row[] = [
  {
    label: 'books_read: a valid id',
    tool: 'bookstack_books_read',
    input: { id: 1 },
    accepted: true,
  },
  {
    label: 'books_read: unknown sibling key alongside a valid id',
    tool: 'bookstack_books_read',
    input: { id: 1, nmae: 'typo' },
    accepted: false,
  },
  {
    label: 'books_read: numeric string id',
    tool: 'bookstack_books_read',
    input: { id: '1' },
    accepted: false,
  },
  {
    label: 'books_read: numeric string id with surrounding space - Number() would take it',
    tool: 'bookstack_books_read',
    input: { id: ' 1 ' },
    accepted: false,
  },
  {
    label: 'books_read: fractional id',
    tool: 'bookstack_books_read',
    input: { id: 1.5 },
    accepted: false,
  },
  {
    label: 'books_read: id of 0 - not an entity id',
    tool: 'bookstack_books_read',
    input: { id: 0 },
    accepted: false,
  },
  {
    label: 'books_read: negative id',
    tool: 'bookstack_books_read',
    input: { id: -1 },
    accepted: false,
  },
  {
    label: 'books_read: null id',
    tool: 'bookstack_books_read',
    input: { id: null },
    accepted: false,
  },
  {
    label: 'books_read: no id at all',
    tool: 'bookstack_books_read',
    input: {},
    accepted: false,
  },
  {
    label: 'books_delete: a valid id',
    tool: 'bookstack_books_delete',
    input: { id: 7 },
    accepted: true,
  },
  {
    label: 'books_delete: unknown sibling key - a delete must not be widened by a typo',
    tool: 'bookstack_books_delete',
    input: { id: 7, cascade: true },
    accepted: false,
  },
  {
    label: 'books_delete: numeric string id',
    tool: 'bookstack_books_delete',
    input: { id: '7' },
    accepted: false,
  },
  {
    label: 'pages_delete: fractional id',
    tool: 'bookstack_pages_delete',
    input: { id: 2.5 },
    accepted: false,
  },
  {
    label: 'pages_delete: unknown sibling key',
    tool: 'bookstack_pages_delete',
    input: { id: 2, force: true },
    accepted: false,
  },
  {
    label: 'users_read: a valid id',
    tool: 'bookstack_users_read',
    input: { id: 3 },
    accepted: true,
  },
  {
    label: 'users_read: numeric string id',
    tool: 'bookstack_users_read',
    input: { id: '3' },
    accepted: false,
  },
];

/**
 * Export: an id plus an enum, which is the pairing that made the projection visible.
 *
 * `bookstack_books_export` validated a rebuilt `{id}` and then CAST `format`, so the enum
 * that exists to catch a typo never saw one. The integration suite covers valid formats and
 * missing books; these are the malformed ids and formats it does not.
 */
const EXPORT_ROWS: readonly Row[] = [
  {
    label: 'books_export: a valid id and format',
    tool: 'bookstack_books_export',
    input: { id: 1, format: 'markdown' },
    accepted: true,
  },
  {
    label: 'books_export: format outside the enum',
    tool: 'bookstack_books_export',
    input: { id: 1, format: 'docx' },
    accepted: false,
  },
  {
    label: 'books_export: format in the wrong case - the published enum is lower case',
    tool: 'bookstack_books_export',
    input: { id: 1, format: 'PDF' },
    accepted: false,
  },
  {
    label: 'books_export: no format at all',
    tool: 'bookstack_books_export',
    input: { id: 1 },
    accepted: false,
  },
  {
    label: 'books_export: numeric string id with a valid format',
    tool: 'bookstack_books_export',
    input: { id: '1', format: 'pdf' },
    accepted: false,
  },
  {
    label: 'books_export: fractional id with a valid format',
    tool: 'bookstack_books_export',
    input: { id: 1.5, format: 'pdf' },
    accepted: false,
  },
  {
    label: 'books_export: unknown sibling key alongside a valid id and format',
    tool: 'bookstack_books_export',
    input: { id: 1, format: 'pdf', pages: 'all' },
    accepted: false,
  },
  {
    label: 'chapters_export: format outside the enum',
    tool: 'bookstack_chapters_export',
    input: { id: 1, format: 'epub' },
    accepted: false,
  },
];

/**
 * Permissions: an enum and an id that together SELECT THE ENDPOINT.
 *
 * `content_type` was cast to `ContentType` rather than validated, so 'shelf' (BookStack
 * calls it 'bookshelf') reached the URL builder - and upstream answers an unknown type with
 * a 500 out of `EntityProvider::get()`, not a 4xx. The secondary ids matter for the same
 * reason: `owner_id: 0` and `role_id: 0` are advertised as integers, and only the runtime
 * rule says they are not entity ids.
 */
const PERMISSION_ROWS: readonly Row[] = [
  {
    label: 'permissions_read: a valid type and id',
    tool: 'bookstack_permissions_read',
    input: { content_type: 'book', content_id: 5 },
    accepted: true,
  },
  {
    label: "permissions_read: 'shelf' - BookStack calls it 'bookshelf' and 500s on this",
    tool: 'bookstack_permissions_read',
    input: { content_type: 'shelf', content_id: 5 },
    accepted: false,
  },
  {
    label: 'permissions_read: content_type in the wrong case',
    tool: 'bookstack_permissions_read',
    input: { content_type: 'BOOK', content_id: 5 },
    accepted: false,
  },
  {
    label: 'permissions_read: unknown sibling key',
    tool: 'bookstack_permissions_read',
    input: { content_type: 'book', content_id: 5, include_inherited: true },
    accepted: false,
  },
  {
    label: 'permissions_read: numeric string content_id',
    tool: 'bookstack_permissions_read',
    input: { content_type: 'book', content_id: '5' },
    accepted: false,
  },
  {
    label: 'permissions_read: content_id of 0',
    tool: 'bookstack_permissions_read',
    input: { content_type: 'book', content_id: 0 },
    accepted: false,
  },
  {
    label: 'permissions_update: a valid owner transfer',
    tool: 'bookstack_permissions_update',
    input: { content_type: 'book', content_id: 5, owner_id: 12 },
    accepted: true,
  },
  {
    label: 'permissions_update: owner_id of 0 - the secondary id the schema advertised as legal',
    tool: 'bookstack_permissions_update',
    input: { content_type: 'book', content_id: 5, owner_id: 0 },
    accepted: false,
  },
  {
    label: 'permissions_update: fractional owner_id',
    tool: 'bookstack_permissions_update',
    input: { content_type: 'book', content_id: 5, owner_id: 12.5 },
    accepted: false,
  },
  {
    label: 'permissions_update: numeric string owner_id',
    tool: 'bookstack_permissions_update',
    input: { content_type: 'book', content_id: 5, owner_id: '12' },
    accepted: false,
  },
  {
    label: 'permissions_update: role_id of 0 inside role_permissions',
    tool: 'bookstack_permissions_update',
    input: {
      content_type: 'book',
      content_id: 5,
      role_permissions: [{ role_id: 0, view: true, create: false, update: false, delete: false }],
    },
    accepted: false,
  },
  {
    label: 'permissions_update: numeric string role_id inside role_permissions',
    tool: 'bookstack_permissions_update',
    input: {
      content_type: 'book',
      content_id: 5,
      role_permissions: [{ role_id: '3', view: true, create: false, update: false, delete: false }],
    },
    accepted: false,
  },
  {
    label: 'permissions_update: unknown key inside a role_permissions entry',
    tool: 'bookstack_permissions_update',
    input: {
      content_type: 'book',
      content_id: 5,
      role_permissions: [
        { role_id: 3, view: true, create: false, update: false, delete: false, admin: true },
      ],
    },
    accepted: false,
  },
  {
    label: 'permissions_update: inheriting:false without the four flags it requires',
    tool: 'bookstack_permissions_update',
    input: { content_type: 'book', content_id: 5, fallback_permissions: { inheriting: false } },
    accepted: false,
  },
  {
    label: 'permissions_update: inheriting:false with all four flags',
    tool: 'bookstack_permissions_update',
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
];

/**
 * User delete: the one destructive tool whose secondary id can be proven wrong locally.
 *
 * The live test covers two DIFFERENT users, which is the case that works. The self-heir case
 * is the one BookStack accepts and gets wrong: `UserRepo::destroy()` deletes the row before
 * it looks the heir up, so equal ids can only resolve to null, and the caller receives a 204
 * over content that is now unowned. There is no id to substitute and nothing to undo, so the
 * only place it can be caught is here - before the client.
 */
const USER_DELETE_ROWS: readonly Row[] = [
  {
    label: 'users_delete: a different user as the heir',
    tool: 'bookstack_users_delete',
    input: { id: 5, migrate_ownership_id: 1 },
    accepted: true,
  },
  {
    label: 'users_delete: no heir - unowned content, deliberately',
    tool: 'bookstack_users_delete',
    input: { id: 5 },
    accepted: true,
  },
  {
    label: 'users_delete: the deleted user named as its own heir',
    tool: 'bookstack_users_delete',
    input: { id: 5, migrate_ownership_id: 5 },
    accepted: false,
  },
  {
    label: 'users_delete: heir of 0 - !empty() reads it as "no heir" while the caller means one',
    tool: 'bookstack_users_delete',
    input: { id: 5, migrate_ownership_id: 0 },
    accepted: false,
  },
  {
    label: 'users_delete: fractional heir',
    tool: 'bookstack_users_delete',
    input: { id: 5, migrate_ownership_id: 1.5 },
    accepted: false,
  },
  {
    label: 'users_delete: numeric string heir',
    tool: 'bookstack_users_delete',
    input: { id: 5, migrate_ownership_id: '1' },
    accepted: false,
  },
  {
    label: 'users_delete: numeric string id',
    tool: 'bookstack_users_delete',
    input: { id: '5', migrate_ownership_id: 1 },
    accepted: false,
  },
  {
    label: 'users_delete: unknown sibling key on an irreversible delete',
    tool: 'bookstack_users_delete',
    input: { id: 5, migrate_ownership_id: 1, migrate_ownership: 2 },
    accepted: false,
  },
];

/**
 * The no-argument tool.
 *
 * "Takes no parameters" is only enforced if an empty strict object is actually applied.
 * `bookstack_system_info` used to accept and discard anything, so a caller who sent
 * `{book_id: 5}` believing they were scoping the request got the whole instance's identity
 * back and no hint their argument meant nothing. The integration suite's counterpart to this
 * builds `strictMode: false` on purpose and asserts the field IS ignored - which is the
 * non-strict contract, and no guard at all for the strict default the server ships.
 */
const NO_ARGUMENT_ROWS: readonly Row[] = [
  {
    label: 'system_info: no arguments, as advertised',
    tool: 'bookstack_system_info',
    input: {},
    accepted: true,
  },
  {
    label: 'system_info: an extraneous field the caller believed was scoping the request',
    tool: 'bookstack_system_info',
    input: { book_id: 5 },
    accepted: false,
  },
  {
    label: 'system_info: an extraneous flag',
    tool: 'bookstack_system_info',
    input: { unexpected: true },
    accepted: false,
  },
];

/**
 * BLANK AND WHITESPACE-ONLY STRINGS, at the real strict boundary.
 *
 * The mirror of the scalar matrix in tests/transport/tools.test.ts: that file proves the
 * PUBLISHED schema and the runtime reach the same verdict, this one proves the runtime's
 * verdict is reached before the client is touched, which is the only thing that keeps a
 * doomed request off the wire.
 *
 * The rule these encode is BookStack's, verified live on v26.05.2 rather than inferred -
 * `required`/`required_without` reject a string that trims to '' (`validateRequired()`:
 * `is_string($value) && trim($value) === '' -> false`), and the global TrimStrings
 * middleware empties a whitespace-only field before the validator ever sees it. See
 * NONBLANK_PATTERN in src/types.ts for the transcript.
 *
 * `.min(1)` counts characters, so every '   ' row below used to sail through to BookStack
 * and come back 422.
 */
const BLANK_STRING_ROWS: readonly Row[] = [
  {
    label: 'books_create: control - a real name',
    tool: 'bookstack_books_create',
    input: { name: 'Real Book' },
    accepted: true,
  },
  {
    label: 'books_create: empty name',
    tool: 'bookstack_books_create',
    input: { name: '' },
    accepted: false,
  },
  {
    label: 'books_create: whitespace-only name - BookStack trims it and 422s',
    tool: 'bookstack_books_create',
    input: { name: '   ' },
    accepted: false,
  },
  {
    label: 'chapters_create: whitespace-only name',
    tool: 'bookstack_chapters_create',
    input: { book_id: 1, name: ' \t ' },
    accepted: false,
  },
  {
    label: 'shelves_create: whitespace-only name',
    tool: 'bookstack_shelves_create',
    input: { name: '\n' },
    accepted: false,
  },
  {
    label: 'pages_create: whitespace-only name',
    tool: 'bookstack_pages_create',
    input: { book_id: 1, name: '   ', html: '<p>Body</p>' },
    accepted: false,
  },
  {
    label: 'pages_create: control - real html',
    tool: 'bookstack_pages_create',
    input: { book_id: 1, name: 'P', html: '<p>Body</p>' },
    accepted: true,
  },
  {
    label: 'pages_create: whitespace-only html and no markdown',
    tool: 'bookstack_pages_create',
    input: { book_id: 1, name: 'P', html: '   ' },
    accepted: false,
  },
  {
    label: 'pages_create: whitespace-only markdown and no html',
    tool: 'bookstack_pages_create',
    input: { book_id: 1, name: 'P', markdown: '\n\t' },
    accepted: false,
  },
  {
    label: 'pages_create: blank html is fine when markdown carries the content',
    tool: 'bookstack_pages_create',
    input: { book_id: 1, name: 'P', html: '   ', markdown: '# Body' },
    accepted: true,
  },
  {
    // The update side is where upstream does NOT protect the caller: it accepts this and
    // blanks the page's name (verified live: PUT /api/pages/N {"name":"   "} -> 200,
    // name now ''). Rejecting here is the difference between an error and a lost title.
    label: 'pages_update: whitespace-only name - upstream would silently blank the title',
    tool: 'bookstack_pages_update',
    input: { id: 1, name: '   ' },
    accepted: false,
  },
  {
    label: 'books_update: whitespace-only name - upstream would silently blank the name',
    tool: 'bookstack_books_update',
    input: { id: 1, name: '   ' },
    accepted: false,
  },
  {
    label: 'users_create: whitespace-only name',
    tool: 'bookstack_users_create',
    input: { name: '  ', email: 'u@example.com' },
    accepted: false,
  },
  {
    label: 'users_create: control - a well-formed language',
    tool: 'bookstack_users_create',
    input: { name: 'U', email: 'u@example.com', language: 'pt_BR' },
    accepted: true,
  },
  {
    label: 'users_create: language with a space - alpha_dash 422s upstream',
    tool: 'bookstack_users_create',
    input: { name: 'U', email: 'u@example.com', language: 'fr FR' },
    accepted: false,
  },
  {
    label: 'users_create: whitespace-only language - upstream ignores it silently',
    tool: 'bookstack_users_create',
    input: { name: 'U', email: 'u@example.com', language: '   ' },
    accepted: false,
  },
  {
    label: 'roles_create: whitespace-only display_name',
    tool: 'bookstack_roles_create',
    input: { display_name: '   ' },
    accepted: false,
  },
  {
    label: 'roles_create: control - a real display_name',
    tool: 'bookstack_roles_create',
    input: { display_name: 'Editors' },
    accepted: true,
  },
  // R5-W4. `display_name` is the only field in this API with a minimum above one, and
  // BookStack applies that minimum to the TRIMMED value - so '   a' is one character to it,
  // not four, and `.min(3)` alone counted the padding and forwarded a guaranteed 422.
  // Verified live on v26.05.2; see trimmedMinLengthPattern in src/types.ts.
  {
    label: 'roles_create: padded short display_name - 4 characters, 1 after trimming',
    tool: 'bookstack_roles_create',
    input: { display_name: '   a' },
    accepted: false,
  },
  {
    label: 'roles_create: padded two-character display_name - 6 characters, 2 after trimming',
    tool: 'bookstack_roles_create',
    input: { display_name: '  ab  ' },
    accepted: false,
  },
  {
    label: 'roles_create: control - padding around a name long enough to survive it',
    tool: 'bookstack_roles_create',
    input: { display_name: '  Editors  ' },
    accepted: true,
  },
  {
    label: 'roles_update: padded short display_name - upstream 422s here too',
    tool: 'bookstack_roles_update',
    input: { id: 1, display_name: '   a' },
    accepted: false,
  },
  {
    label: 'roles_update: control - a rename',
    tool: 'bookstack_roles_update',
    input: { id: 1, display_name: 'Editors' },
    accepted: true,
  },
  // The other half of R5-W4: `query` is `['required']` upstream, which Laravel judges after
  // trimming, so a query of spaces is missing rather than short. Live v26.05.2 answers
  // 422 "The query field is required." for each of these.
  {
    label: 'search: whitespace-only query',
    tool: 'bookstack_search',
    input: { query: '   ' },
    accepted: false,
  },
  {
    label: 'search: tab/newline-only query',
    tool: 'bookstack_search',
    input: { query: '\t\n' },
    accepted: false,
  },
  {
    label: 'search: empty query',
    tool: 'bookstack_search',
    input: { query: '' },
    accepted: false,
  },
  {
    label: 'search: control - a real query',
    tool: 'bookstack_search',
    input: { query: 'installation' },
    accepted: true,
  },
];

describe('strict validation stops a malformed request before the client', () => {
  it('on read and delete tools addressed by id', async () => {
    expect(await runRows(ID_ROWS)).toEqual(intended(ID_ROWS));
  });

  it('on blank and whitespace-only strings, which BookStack counts as missing', async () => {
    expect(await runRows(BLANK_STRING_ROWS)).toEqual(intended(BLANK_STRING_ROWS));
  });

  /**
   * The other half of the nonblank rule: it JUDGES the trimmed value and TRANSMITS the
   * original.
   *
   * A `.trim()` in the schema would satisfy every rejection row above and quietly rewrite
   * the caller's content on the way out - BookStack would store 'Padded Guide' for a
   * caller who wrote '  Padded Guide  ' and this server would never mention it. Upstream
   * trims it anyway; that is upstream's decision to make and its behaviour to own. This
   * asserts the bytes handed to the client are the bytes that arrived.
   */
  it("sends the caller's string unmodified, having judged it on its trimmed length", async () => {
    const { calls, client } = createRecordingClient();
    const tools = buildTools(client);

    await requireTool(tools, 'bookstack_books_create').handler({ name: '  Padded Guide  ' });
    await requireTool(tools, 'bookstack_pages_create').handler({
      book_id: 1,
      name: 'P',
      html: '  <p>Body</p>  ',
    });
    // The R5-W4 rules, which are the ones with something to be tempted by: a `.trim()` in
    // either schema would make '   a' and '   ' pass their new checks, and would ALSO
    // rewrite these two on the way out. The role name is 3 characters only after trimming
    // and the query is a search term with padding - both must arrive upstream exactly as
    // they were written.
    await requireTool(tools, 'bookstack_roles_create').handler({ display_name: '  Editors  ' });
    await requireTool(tools, 'bookstack_search').handler({ query: '  installation  ' });

    expect(calls).toEqual([
      { method: 'createBook', args: [{ name: '  Padded Guide  ' }] },
      { method: 'createPage', args: [{ book_id: 1, name: 'P', html: '  <p>Body</p>  ' }] },
      { method: 'createRole', args: [{ display_name: '  Editors  ' }] },
      { method: 'search', args: [{ query: '  installation  ', page: 1, count: 20 }] },
    ]);
  });

  it('on export tools, over both the id and the format enum', async () => {
    expect(await runRows(EXPORT_ROWS)).toEqual(intended(EXPORT_ROWS));
  });

  it('on the permission tools, over the content type and the secondary ids', async () => {
    expect(await runRows(PERMISSION_ROWS)).toEqual(intended(PERMISSION_ROWS));
  });

  it('on user delete, including the heir that can only ever be unsatisfiable', async () => {
    expect(await runRows(USER_DELETE_ROWS)).toEqual(intended(USER_DELETE_ROWS));
  });

  it('on the no-argument tool', async () => {
    expect(await runRows(NO_ARGUMENT_ROWS)).toEqual(intended(NO_ARGUMENT_ROWS));
  });

  /**
   * The harness checking itself.
   *
   * Every assertion above reads a rejection off `clientCalls === 0`, which is worthless
   * unless a call that SHOULD arrive actually does, with the parsed value. This is also what
   * catches a coercion being reintroduced somewhere other than the schema: `'1'` must not
   * merely be rejected, `1` must arrive as the number 1.
   */
  it('records the client call an accepted request makes, with the parsed arguments', async () => {
    const { calls, client } = createRecordingClient();
    const tools = buildTools(client);

    await requireTool(tools, 'bookstack_books_read').handler({ id: 42 });
    await requireTool(tools, 'bookstack_books_export').handler({ id: 42, format: 'pdf' });
    await requireTool(tools, 'bookstack_users_delete').handler({ id: 5, migrate_ownership_id: 1 });

    expect(calls).toEqual([
      { method: 'getBook', args: [42] },
      { method: 'exportBook', args: [42, 'pdf'] },
      { method: 'deleteUser', args: [5, 1] },
    ]);
  });
});

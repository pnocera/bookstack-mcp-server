/**
 * Every integer the tool surface advertises, held against the rule that actually enforces it.
 *
 * WHY THIS FILE EXISTS.
 *
 * `entityId` is `z.number().int().positive()`, but the JSON Schema the server publishes said
 * only `type: 'integer'` for most id-backed properties. So `content_id: 0`, `owner_id: 0` and
 * `role_id: 0` were advertised as valid and rejected at runtime - the same schema-vs-runtime
 * divergence as the conditional `oneOf` fix, in a different keyword. MCP clients generate
 * calls from `tools/list` and never see the zod schemas, so a client following the published
 * contract could construct a call the server refuses.
 *
 * WHY IT IS TABLE-DRIVEN OVER THE WHOLE SURFACE RATHER THAN OVER THE PROPERTIES THAT WERE
 * BROKEN.
 *
 * A fix applied by hand to the properties someone happened to notice is a fix that decays:
 * the next id property is added with no `minimum` and nothing says so. `RULES` below names
 * every integer property the server publishes, and the completeness test asserts that the
 * published surface contains exactly those - so a new integer property fails here until it
 * is classified, and a classification that stops matching the runtime fails on the probe.
 *
 * Both halves of the contract are exercised for each rule, at the value that separates them:
 *  - the published JSON Schema, through ajv, exactly as a client's generator would read it;
 *  - the real strict `ValidationHandler`, through the real handler, over a recording client.
 *
 * The runtime verdict is read off whether the client was reached, never off the error text:
 * that is the only signal that distinguishes "validation stopped it" from "something further
 * down did". No BookStack, no HTTP.
 */

import { describe, expect, it } from 'bun:test';
import Ajv from 'ajv';
import type { MCPSchemaNode } from '../../src/types';
import { buildTools, createRecordingClient, requireTool } from '../helpers/strict-tools';

/**
 * What an integer property means, and therefore what it must publish.
 *
 * The three rules are distinguished by their verdict on 0, which is where the published
 * contract and the runtime diverged:
 *
 *  - `entity-id`     - `entityId` (`.int().positive()`). A BookStack entity id: 0 is not one.
 *  - `positive-count` - `.min(1)`: a listing that returns nothing is not a request worth making.
 *  - `non-negative`  - `.min(0)` / `.nonnegative()`: 0 is meaningful (`offset: 0` is the first
 *                      page; `default_template_id: 0` CLEARS the template).
 *  - `unbounded`     - `.int()` and nothing more: `priority` is `['integer']` upstream with no
 *                      bounds, and a negative value is a legitimate way to sort first.
 */
type IntegerRule = 'entity-id' | 'positive-count' | 'non-negative' | 'unbounded';

/** The `minimum` each rule obliges the published schema to carry. */
const REQUIRED_MINIMUM: Record<IntegerRule, number | undefined> = {
  'entity-id': 1,
  'positive-count': 1,
  'non-negative': 0,
  unbounded: undefined,
};

/** Whether a rule accepts 0 - the value the whole divergence turns on. */
function acceptsZero(rule: IntegerRule): boolean {
  return rule === 'non-negative' || rule === 'unbounded';
}

/**
 * Every integer property the server publishes, keyed by `<tool>.<json pointer-ish path>`.
 *
 * `[]` denotes descending into an array's items. The paths are exactly the ones the
 * completeness test derives from the published schemas, so this table cannot silently fall
 * behind the surface.
 *
 * Each classification was checked against the runtime rule rather than inferred from the
 * property's name - `default_template_id` looks like an entity id and is not one, because
 * BookStack uses 0 to clear it.
 */
const RULES: Record<string, IntegerRule> = {
  // --- Attachments ---
  'bookstack_attachments_create.uploaded_to': 'entity-id',
  'bookstack_attachments_delete.id': 'entity-id',
  'bookstack_attachments_list.count': 'positive-count',
  'bookstack_attachments_list.filter.uploaded_to': 'entity-id',
  'bookstack_attachments_list.offset': 'non-negative',
  'bookstack_attachments_read.id': 'entity-id',
  'bookstack_attachments_update.id': 'entity-id',
  'bookstack_attachments_update.uploaded_to': 'entity-id',

  // --- Audit log ---
  'bookstack_audit_log_list.count': 'positive-count',
  'bookstack_audit_log_list.filter.loggable_id': 'entity-id',
  'bookstack_audit_log_list.filter.user_id': 'entity-id',
  'bookstack_audit_log_list.offset': 'non-negative',

  // --- Books ---
  // `default_template_id` is `defaultTemplateId` (`.nonnegative()`), NOT `entityId`: 0 clears
  // the setting. Publishing `minimum: 1` here would advertise the clear operation as invalid.
  'bookstack_books_create.default_template_id': 'non-negative',
  'bookstack_books_delete.id': 'entity-id',
  'bookstack_books_export.id': 'entity-id',
  'bookstack_books_list.count': 'positive-count',
  'bookstack_books_list.filter.created_by': 'entity-id',
  'bookstack_books_list.offset': 'non-negative',
  'bookstack_books_read.id': 'entity-id',
  'bookstack_books_update.default_template_id': 'non-negative',
  'bookstack_books_update.id': 'entity-id',

  // --- Chapters ---
  'bookstack_chapters_create.book_id': 'entity-id',
  'bookstack_chapters_create.default_template_id': 'non-negative',
  'bookstack_chapters_create.priority': 'unbounded',
  'bookstack_chapters_delete.id': 'entity-id',
  'bookstack_chapters_export.id': 'entity-id',
  'bookstack_chapters_list.count': 'positive-count',
  'bookstack_chapters_list.filter.book_id': 'entity-id',
  'bookstack_chapters_list.filter.created_by': 'entity-id',
  'bookstack_chapters_list.offset': 'non-negative',
  'bookstack_chapters_read.id': 'entity-id',
  'bookstack_chapters_update.book_id': 'entity-id',
  'bookstack_chapters_update.default_template_id': 'non-negative',
  'bookstack_chapters_update.id': 'entity-id',
  'bookstack_chapters_update.priority': 'unbounded',

  // --- Images ---
  'bookstack_images_create.uploaded_to': 'entity-id',
  'bookstack_images_delete.id': 'entity-id',
  'bookstack_images_list.count': 'positive-count',
  'bookstack_images_list.filter.uploaded_to': 'entity-id',
  'bookstack_images_list.offset': 'non-negative',
  'bookstack_images_read.id': 'entity-id',
  'bookstack_images_update.id': 'entity-id',

  // --- Pages ---
  'bookstack_pages_create.book_id': 'entity-id',
  'bookstack_pages_create.chapter_id': 'entity-id',
  'bookstack_pages_create.priority': 'unbounded',
  'bookstack_pages_delete.id': 'entity-id',
  'bookstack_pages_export.id': 'entity-id',
  'bookstack_pages_list.count': 'positive-count',
  'bookstack_pages_list.filter.book_id': 'entity-id',
  'bookstack_pages_list.filter.chapter_id': 'entity-id',
  'bookstack_pages_list.filter.created_by': 'entity-id',
  'bookstack_pages_list.offset': 'non-negative',
  'bookstack_pages_read.id': 'entity-id',
  'bookstack_pages_update.book_id': 'entity-id',
  // There is no value meaning "no chapter": `pageUpdate.chapter_id` is `entityId`, so 0 is
  // rejected rather than read as "detach". Moving a page to its book root is `book_id` alone.
  'bookstack_pages_update.chapter_id': 'entity-id',
  'bookstack_pages_update.id': 'entity-id',
  'bookstack_pages_update.priority': 'unbounded',

  // --- Permissions ---
  'bookstack_permissions_read.content_id': 'entity-id',
  'bookstack_permissions_update.content_id': 'entity-id',
  'bookstack_permissions_update.owner_id': 'entity-id',
  'bookstack_permissions_update.role_permissions[].role_id': 'entity-id',

  // --- Recycle bin ---
  'bookstack_recyclebin_delete_permanently.id': 'entity-id',
  'bookstack_recyclebin_list.count': 'positive-count',
  'bookstack_recyclebin_list.offset': 'non-negative',
  'bookstack_recyclebin_restore.id': 'entity-id',

  // --- Roles ---
  'bookstack_roles_delete.id': 'entity-id',
  'bookstack_roles_list.count': 'positive-count',
  'bookstack_roles_list.offset': 'non-negative',
  'bookstack_roles_read.id': 'entity-id',
  'bookstack_roles_update.id': 'entity-id',

  // --- Search ---
  'bookstack_search.count': 'positive-count',
  'bookstack_search.page': 'positive-count',

  // --- Shelves ---
  'bookstack_shelves_create.books[]': 'entity-id',
  'bookstack_shelves_delete.id': 'entity-id',
  'bookstack_shelves_list.count': 'positive-count',
  'bookstack_shelves_list.filter.created_by': 'entity-id',
  'bookstack_shelves_list.offset': 'non-negative',
  'bookstack_shelves_read.id': 'entity-id',
  'bookstack_shelves_update.books[]': 'entity-id',
  'bookstack_shelves_update.id': 'entity-id',

  // --- Users ---
  'bookstack_users_create.roles[]': 'entity-id',
  'bookstack_users_delete.id': 'entity-id',
  'bookstack_users_delete.migrate_ownership_id': 'entity-id',
  'bookstack_users_list.count': 'positive-count',
  'bookstack_users_list.offset': 'non-negative',
  'bookstack_users_read.id': 'entity-id',
  'bookstack_users_update.id': 'entity-id',
  'bookstack_users_update.roles[]': 'entity-id',
};

/**
 * A valid request per tool, carrying every one of that tool's integer properties at a legal
 * value. Each probe below takes one of these and overwrites a single property with 0.
 *
 * These must be accepted by BOTH halves as they stand - asserted before any probe runs. A
 * base that was invalid for some unrelated reason would make every probe over it "reject" for
 * the wrong reason, which is a false pass rather than a failure.
 */
const TOOL_BASES: Record<string, Record<string, unknown>> = {
  bookstack_attachments_create: {
    uploaded_to: 1,
    name: 'Probe',
    link: 'https://example.com/doc.pdf',
  },
  bookstack_attachments_delete: { id: 1 },
  bookstack_attachments_list: { count: 20, offset: 0, filter: { uploaded_to: 1 } },
  bookstack_attachments_read: { id: 1 },
  bookstack_attachments_update: { id: 1, uploaded_to: 1 },
  bookstack_audit_log_list: { count: 20, offset: 0, filter: { user_id: 1, loggable_id: 1 } },
  bookstack_books_create: { name: 'Probe', default_template_id: 1 },
  bookstack_books_delete: { id: 1 },
  bookstack_books_export: { id: 1, format: 'pdf' },
  bookstack_books_list: { count: 20, offset: 0, filter: { created_by: 1 } },
  bookstack_books_read: { id: 1 },
  bookstack_books_update: { id: 1, default_template_id: 1 },
  bookstack_chapters_create: { name: 'Probe', book_id: 1, priority: 1, default_template_id: 1 },
  bookstack_chapters_delete: { id: 1 },
  bookstack_chapters_export: { id: 1, format: 'pdf' },
  bookstack_chapters_list: { count: 20, offset: 0, filter: { book_id: 1, created_by: 1 } },
  bookstack_chapters_read: { id: 1 },
  bookstack_chapters_update: { id: 1, book_id: 1, priority: 1, default_template_id: 1 },
  bookstack_images_create: { uploaded_to: 1, name: 'Probe', image: 'aGk=', type: 'gallery' },
  bookstack_images_delete: { id: 1 },
  bookstack_images_list: { count: 20, offset: 0, filter: { uploaded_to: 1 } },
  bookstack_images_read: { id: 1 },
  bookstack_images_update: { id: 1, name: 'Probe' },
  bookstack_pages_create: {
    name: 'Probe',
    book_id: 1,
    chapter_id: 1,
    html: '<p>x</p>',
    priority: 1,
  },
  bookstack_pages_delete: { id: 1 },
  bookstack_pages_export: { id: 1, format: 'pdf' },
  bookstack_pages_list: {
    count: 20,
    offset: 0,
    filter: { book_id: 1, chapter_id: 1, created_by: 1 },
  },
  bookstack_pages_read: { id: 1 },
  bookstack_pages_update: { id: 1, book_id: 1, chapter_id: 1, priority: 1 },
  bookstack_permissions_read: { content_type: 'book', content_id: 1 },
  bookstack_permissions_update: {
    content_type: 'book',
    content_id: 1,
    owner_id: 1,
    role_permissions: [{ role_id: 1, view: true, create: true, update: true, delete: true }],
  },
  bookstack_recyclebin_delete_permanently: { id: 1 },
  bookstack_recyclebin_list: { count: 20, offset: 0 },
  bookstack_recyclebin_restore: { id: 1 },
  bookstack_roles_delete: { id: 1 },
  bookstack_roles_list: { count: 20, offset: 0 },
  bookstack_roles_read: { id: 1 },
  bookstack_roles_update: { id: 1 },
  bookstack_search: { query: 'probe', page: 1, count: 20 },
  bookstack_shelves_create: { name: 'Probe', books: [1] },
  bookstack_shelves_delete: { id: 1 },
  bookstack_shelves_list: { count: 20, offset: 0, filter: { created_by: 1 } },
  bookstack_shelves_read: { id: 1 },
  bookstack_shelves_update: { id: 1, books: [1] },
  bookstack_users_create: { name: 'Probe', email: 'probe@example.com', roles: [1] },
  // A DIFFERENT heir from `id`: equal ids are refused outright, so a base naming itself would
  // be rejected for that reason rather than for the value under probe.
  bookstack_users_delete: { id: 1, migrate_ownership_id: 2 },
  bookstack_users_list: { count: 20, offset: 0 },
  bookstack_users_read: { id: 1 },
  bookstack_users_update: { id: 1, roles: [1] },
};

/**
 * See tests/transport/tools.test.ts for why ajv runs with these two off: `strictSchema` is a
 * schema-authoring linter rather than a conformance check and objects to the (valid) way the
 * exactly-one rules are written, and `format` is an annotation unless a vocabulary is loaded.
 */
const ajv = new Ajv({ allErrors: true, strictSchema: false, validateFormats: false });

/** Walk the published schema and collect every `type: 'integer'` property with its path. */
function collectIntegerPaths(node: MCPSchemaNode, path: string, into: Map<string, MCPSchemaNode>) {
  if (node.type === 'integer') {
    into.set(path, node);
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    collectIntegerPaths(child, path === '' ? key : `${path}.${key}`, into);
  }
  if (node.items) {
    collectIntegerPaths(node.items, `${path}[]`, into);
  }
  // A oneOf/anyOf/allOf/not branch constrains a value whose properties are declared on a
  // sibling schema, so its `properties` restate rather than introduce - descending would
  // double-count the same property under a second path.
}

/** Every integer property on the published surface, keyed exactly as `RULES` is. */
function publishedIntegerProperties(): Map<string, MCPSchemaNode> {
  const { client } = createRecordingClient();
  const found = new Map<string, MCPSchemaNode>();
  for (const tool of buildTools(client).values()) {
    const perTool = new Map<string, MCPSchemaNode>();
    collectIntegerPaths(tool.inputSchema, '', perTool);
    for (const [path, schema] of perTool) {
      found.set(`${tool.name}.${path}`, schema);
    }
  }
  return found;
}

/** Copy `base` with the single property at `path` overwritten by `value`. */
function withValueAt(
  base: Record<string, unknown>,
  path: string,
  value: number
): Record<string, unknown> {
  const clone = structuredClone(base);
  const segments = path.split('.');
  let cursor: Record<string, unknown> = clone;

  segments.forEach((segment, index) => {
    const intoItems = segment.endsWith('[]');
    const key = intoItems ? segment.slice(0, -2) : segment;
    const isLeaf = index === segments.length - 1;

    if (isLeaf && !intoItems) {
      cursor[key] = value;
      return;
    }

    const container = cursor[key];
    if (intoItems) {
      if (!Array.isArray(container) || container.length === 0) {
        throw new Error(`${path}: base has no array element at "${key}" to probe`);
      }
      if (isLeaf) {
        container[0] = value;
        return;
      }
      cursor = container[0] as Record<string, unknown>;
      return;
    }

    if (typeof container !== 'object' || container === null) {
      throw new Error(`${path}: base has no object at "${key}" to descend into`);
    }
    cursor = container as Record<string, unknown>;
  });

  return clone;
}

/** Did the real handler's strict validator let this input through to the client? */
async function runtimeAccepts(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  const { calls, client } = createRecordingClient();
  const tool = requireTool(buildTools(client), toolName);
  try {
    await tool.handler(input);
  } catch {
    // Whether the client was reached is the signal, not the throw: see the file header.
  }
  return calls.length > 0;
}

/** Did the published JSON Schema, read as a client reads it, accept this input? */
function schemaAccepts(toolName: string, input: Record<string, unknown>): boolean {
  const { client } = createRecordingClient();
  const tool = requireTool(buildTools(client), toolName);
  return ajv.validate(tool.inputSchema, input) === true;
}

describe('the integer surface is completely classified', () => {
  it('classifies exactly the integer properties the server publishes', () => {
    // The guard that keeps this file honest as the surface grows: an integer property added
    // without a rule fails here, rather than joining the set nobody checked.
    const published = [...publishedIntegerProperties().keys()].sort();

    expect(published).toEqual(Object.keys(RULES).sort());
  });

  it('covers every tool that has one with a valid base request', () => {
    const toolsWithIntegers = [
      ...new Set([...publishedIntegerProperties().keys()].map((key) => key.split('.')[0])),
    ].sort();

    expect(Object.keys(TOOL_BASES).sort()).toEqual(toolsWithIntegers);
  });
});

describe('every base request is valid before anything is probed over it', () => {
  it('is accepted by the published schema and by the real handler alike', async () => {
    // Without this, a base broken for an unrelated reason would make every probe over it
    // "reject" for that reason instead of the value under test - a false pass, not a failure.
    const outcomes: Record<string, { schema: boolean; runtime: boolean }> = {};
    const intended: Record<string, { schema: boolean; runtime: boolean }> = {};

    for (const [tool, base] of Object.entries(TOOL_BASES)) {
      outcomes[tool] = {
        schema: schemaAccepts(tool, base),
        runtime: await runtimeAccepts(tool, base),
      };
      intended[tool] = { schema: true, runtime: true };
    }

    expect(outcomes).toEqual(intended);
  });
});

describe('the published minimum matches the rule that enforces it', () => {
  it('publishes minimum:1 on every entity-id property, and the right minimum elsewhere', () => {
    // The advertised keyword, asserted directly: this is the half of the contract an MCP
    // client reads, and `type: integer` alone told it that 0 was a legal entity id.
    const published = publishedIntegerProperties();
    const actual: Record<string, number | undefined> = {};
    const expected: Record<string, number | undefined> = {};

    for (const [key, rule] of Object.entries(RULES)) {
      actual[key] = published.get(key)?.minimum;
      expected[key] = REQUIRED_MINIMUM[rule];
    }

    expect(actual).toEqual(expected);
  });
});

describe('schema and runtime agree on 0, the value the rules turn on', () => {
  it('reaches the same verdict on every integer property', async () => {
    // The behavioural half of the same claim: a `minimum` that says one thing while the zod
    // rule says another is exactly the divergence this file exists to close, so both are
    // driven at the boundary value rather than trusting the keyword alone.
    const outcomes: Record<string, { schema: boolean; runtime: boolean }> = {};
    const intended: Record<string, { schema: boolean; runtime: boolean }> = {};

    for (const [key, rule] of Object.entries(RULES)) {
      const separator = key.indexOf('.');
      const tool = key.slice(0, separator);
      const path = key.slice(separator + 1);
      const input = withValueAt(TOOL_BASES[tool] as Record<string, unknown>, path, 0);

      outcomes[key] = {
        schema: schemaAccepts(tool, input),
        runtime: await runtimeAccepts(tool, input),
      };
      const zeroIsLegal = acceptsZero(rule);
      intended[key] = { schema: zeroIsLegal, runtime: zeroIsLegal };
    }

    expect(outcomes).toEqual(intended);
  });
});

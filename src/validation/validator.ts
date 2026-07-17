import { z } from 'zod';
import {
  type ContentType,
  type ExportFormat,
  LANGUAGE_PATTERN,
  NONBLANK_PATTERN,
  trimmedMinLengthPattern,
} from '../types';
import { Logger } from '../utils/logger';

/**
 * WHAT THESE SCHEMAS DESCRIBE: A COMPLETE TOOL REQUEST, NOT AN API BODY.
 *
 * Every schema in `ValidationSchemas` models the whole object a handler receives from
 * `tools/call` - routing fields (`id`, `content_type`) included - and handlers validate
 * BEFORE they destructure. That ordering is the difference between strict validation and
 * the appearance of it: a handler that pulled `id` out first and validated a rebuilt
 * `{id}` could not see its siblings, so `{id: 5, nmae: 'X'}` passed `id`'s strict schema
 * with the typo still in hand, and `bookstack_books_export` cast `format` past the enum
 * that was meant to check it. `z.strictObject` only rejects an unknown key it is actually
 * shown.
 *
 * So the id belongs in the schema, and the handler strips it after parsing:
 *
 *     const { id, ...body } = validator.validateParams<UpdateBookRequest>(params, 'bookUpdate');
 *
 * The tool advertises `type: integer`, so a numeric STRING is a contract violation and is
 * rejected rather than coerced. There is deliberately no coercing entry point left: the
 * previous `validateId()` ran `Number(id)` and turned '5', '5.0' and ' 5 ' into 5 behind
 * the caller's back, which is how a client could believe it was sending integers when it
 * was not.
 *
 * WHY EVERY TOOL-FACING OBJECT HERE IS `z.strictObject`.
 *
 * `z.object` STRIPS unknown keys instead of reporting them, and `strictMode` below can
 * only rethrow errors zod actually raises - so under a plain `z.object` a typo produced
 * no error to rethrow, and strict mode silently dropped the key and carried on. That is
 * the worst possible outcome for a filter: `{filtre: {name: 'X'}}` and
 * `{filter: {nmae: 'X'}}` both used to return a clean, plausible, UNFILTERED page of
 * results, which reads as a successful narrow search. Verified live on v26.05.2 before
 * this change.
 *
 * `z.strictObject` reports an unrecognised key as an error, which strict mode then throws.
 * The nested `filter`/`tag`/`permission` objects matter as much as the top level - a
 * misspelled filter key is the case that actually happens. The advertised JSON Schemas are
 * closed to match, by `withClosedSchemas()` in src/types.ts.
 *
 * WHY THE INTEGER FIELDS SAY `.int()`.
 *
 * Every field below that the MCP schema advertises as `integer` was `z.number()`, which
 * accepts 1.5. `count: 1.5` and `uploaded_to: 1.5` both used to sail through to BookStack.
 */

/** A BookStack entity ID: a positive whole number, never 0 and never fractional. */
const entityId = z.number().int().positive();

/**
 * "Not blank", compiled from the very string the tools publish as their `pattern`.
 *
 * ONE definition, TWO enforcers. The published JSON Schema and this validator have to
 * agree, and the way that agreement rots is two hand-written copies of the same rule. So
 * `NONBLANK_PATTERN` is the source and both sides read it: the schema as a `pattern`
 * keyword, zod as this RegExp. They cannot disagree, because there is nothing to disagree
 * with.
 *
 * `.regex()` matches JSON Schema's `pattern` semantics exactly - unanchored, "is it found
 * in the value" - so `\S` means "holds a non-whitespace character" on both sides.
 *
 * WHY THIS IS A CHECK AND NOT A TRANSFORM. It would be easy to `.trim()` here and make the
 * problem disappear. That would silently send BookStack something the caller did not
 * write: `name: '  Guide  '` would become 'Guide' with no indication that this server
 * edited it. (BookStack trims it upstream anyway - that is ITS decision to make and its
 * behaviour to own.) So the value is judged on its trimmed length and transmitted exactly
 * as it arrived.
 */
const NONBLANK = new RegExp(NONBLANK_PATTERN);

const NONBLANK_MESSAGE =
  'must contain a non-whitespace character: BookStack trims this field before validating, ' +
  'so a value of only spaces is rejected upstream as missing, or - on an update - silently ' +
  'blanks the field instead of changing it';

/** How a minimum above one is explained, since "at least 3 characters" is what it is not. */
function trimmedMinMessage(min: number): string {
  return (
    `must hold at least ${min} characters once trimmed: BookStack trims this field before ` +
    `validating, so leading and trailing whitespace does not count toward its min:${min} ` +
    'and a padded short value is rejected upstream'
  );
}

/**
 * A string BookStack's `required` will accept: present, within `max`, and not just spaces.
 *
 * `.min(1)` alone was the bug R4-W4 names - it counts characters, and a space is one.
 *
 * ...and `.min(3)` alone was R5-W4, which is the same bug one step along: `'   a'` has three
 * characters, none of which BookStack keeps. So the minimum is judged on the TRIMMED length
 * whenever it is above one, by compiling the very pattern the tool publishes - see
 * `trimmedMinLengthPattern` in src/types.ts for the rule, the live evidence and the maximum
 * it deliberately does not apply to. The raw `.min(min)` stays alongside it: the pattern
 * implies it, and stating it keeps zod's error specific about which end was missed.
 */
function nonblankString(max: number, min = 1): z.ZodString {
  const pattern = new RegExp(trimmedMinLengthPattern(min));
  const message = min > 1 ? trimmedMinMessage(min) : NONBLANK_MESSAGE;
  return z.string().min(min).max(max).regex(pattern, message);
}

/** Does this value carry content, by BookStack's reading of `required`? */
function hasContent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * `language`, as BookStack's `['string', 'max:15', 'alpha_dash']`.
 *
 * Compiled from the published pattern for the same anti-drift reason as NONBLANK above.
 */
const language = z
  .string()
  .min(1)
  .max(15)
  .regex(
    new RegExp(LANGUAGE_PATTERN),
    'language may only contain letters, numbers, dashes and underscores'
  );

/** `count` on a listing. 500 is BookStack's own maximum, and it REJECTS more (see below). */
const listCount = z.number().int().min(1).max(500).default(20);

/** `offset` on a listing: 0 is a legitimate value, negatives are not. */
const listOffset = z.number().int().min(0).default(0);

/** Tags, as every entity's create/update accepts them. */
const tagList = z.array(
  z.strictObject({
    name: z.string(),
    value: z.string(),
  })
);

/**
 * `default_template_id` accepts 0, which CLEARS the setting, so it is non-negative rather
 * than positive. See `DefaultTemplateId` in src/types.ts for why nothing stricter than
 * "a whole number" can be enforced: BookStack silently stores null for any id that is not
 * a visible template page, rather than rejecting it.
 */
const defaultTemplateId = z.number().int().nonnegative();

/**
 * The three mutually exclusive ways to give an attachment its content.
 */
type AttachmentSource = 'file' | 'file_path' | 'link';

const ATTACHMENT_SOURCES: readonly AttachmentSource[] = ['file', 'file_path', 'link'];

/** How each source is described back to a caller that got the combination wrong. */
const ATTACHMENT_SOURCE_LABELS: Record<AttachmentSource, string> = {
  file: 'file (base64 content)',
  file_path: 'file_path (a server-local path)',
  link: 'link (an external URL)',
};

/**
 * What makes two sources a conflict rather than a preference, quoted onto the error so the
 * caller learns why their "working" call was destroying data.
 */
const ATTACHMENT_CONFLICT_REASON =
  'BookStack applies the link AFTER storing the upload - it deletes the file it just saved, flips the attachment to external and keeps only the link - so sending both does not prefer one, it silently discards the file and returns something else entirely.';

/** Which content sources a payload actually supplied. */
function providedAttachmentSources(data: Partial<Record<AttachmentSource, unknown>>): {
  sources: AttachmentSource[];
  conflictMessage: string | undefined;
} {
  const sources = ATTACHMENT_SOURCES.filter((field) => data[field] !== undefined);
  if (sources.length <= 1) {
    return { sources, conflictMessage: undefined };
  }

  const named = sources.map((field) => ATTACHMENT_SOURCE_LABELS[field]).join(' and ');
  return {
    sources,
    conflictMessage: `Provide only one of file, file_path or link - received ${named}. ${ATTACHMENT_CONFLICT_REASON}`,
  };
}

/**
 * The request shapes a handler destructures once validation has passed.
 *
 * These live beside the schemas rather than in src/types.ts because they describe the
 * TOOL request - what `tools/call` hands a handler - while src/types.ts describes what
 * BookStack's own API accepts. The two differ by exactly the routing fields a handler
 * strips before calling the client, so each of these composes with an existing
 * `src/types.ts` params type rather than restating it:
 *
 *     type UpdateBookRequest = UpdateBookParams & IdRequest;
 */

/** The complete request of every tool that names one entity by id, and nothing else. */
export interface IdRequest {
  id: number;
}

/** `bookstack_{books,chapters,pages}_export`: the id plus the format enum. */
export interface ExportRequest extends IdRequest {
  format: ExportFormat;
}

/** How the permission tools address an item: by type AND id, since ids repeat per type. */
export interface ContentPermissionsRequest {
  content_type: ContentType;
  content_id: number;
}

/**
 * `bookstack_users_delete`. `migrate_ownership_id` is validated here and nowhere else:
 * BookStack declares a `['integer', 'exists:users,id']` rule for it in
 * `UserApiController::rules()` but its `delete()` never runs that rule - it reads the raw
 * input straight into `UserRepo::destroy()`, which does `if (!empty($newOwnerId))` and
 * silently drops anything that finds no user (read from /app/www on v26.05.2). Upstream
 * will therefore never reject a malformed heir id, and a caller who typed one would learn
 * about it only by noticing their content ended up unowned - after an irreversible delete.
 *
 * The one heir value that is provably wrong without asking BookStack anything is the
 * deleted user itself: `destroy()` deletes the row first and looks the heir up second, so
 * equal ids can only resolve to null. The `userDelete` schema rejects that case; see the
 * comment there for the live 204-and-unowned reproduction.
 */
export interface UserDeleteRequest extends IdRequest {
  migrate_ownership_id?: number;
}

/**
 * Validation schemas for BookStack entities
 */
const ValidationSchemas = {
  // Books
  // BookStack sorts descending when the field is prefixed with `-`, so both
  // directions are accepted here.
  //
  // An unlisted value does NOT error upstream: `ListingResponseBuilder::sortQuery()`
  // reads the direction off the `-` prefix, then falls back to `fields[0]` for any
  // name it does not recognise. `sort=bogusfield` returns a clean HTTP 200 (verified
  // live on v26.05.2), silently sorted by the endpoint's first field - and
  // `-bogusfield` still applies the descending direction to it. The enum is what
  // catches the typo, since upstream never will.
  booksList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum(['name', 'created_at', 'updated_at', '-name', '-created_at', '-updated_at'])
      .default('name'),
    filter: z
      .strictObject({
        name: z.string().optional(),
        created_by: entityId.optional(),
      })
      .optional(),
  }),

  bookCreate: z.strictObject({
    name: nonblankString(255),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: tagList.optional(),
    default_template_id: defaultTemplateId.optional(),
  }),

  bookUpdate: z.strictObject({
    id: entityId,
    name: nonblankString(255).optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: tagList.optional(),
    default_template_id: defaultTemplateId.optional(),
  }),

  // Pages
  // `draft` and `template` are validated as the booleans the tool advertises;
  // `toPagesListParams` maps them onto the 1/0 BookStack's tinyint columns need
  // before the request goes out. See `PagesListParams` for why a raw boolean
  // means the opposite of what it says upstream.
  pagesList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum([
        'name',
        'created_at',
        'updated_at',
        'priority',
        '-name',
        '-created_at',
        '-updated_at',
        '-priority',
      ])
      .default('name'),
    filter: z
      .strictObject({
        book_id: entityId.optional(),
        chapter_id: entityId.optional(),
        name: z.string().optional(),
        created_by: entityId.optional(),
        draft: z.boolean().optional(),
        template: z.boolean().optional(),
      })
      .optional(),
  }),

  // `priority` is `['integer']` upstream with no bounds, and a negative value is a
  // legitimate way to sort something first, so `.int()` is as far as this can honestly go.
  pageCreate: z
    .strictObject({
      book_id: entityId.optional(),
      chapter_id: entityId.optional(),
      name: nonblankString(255),
      html: z.string().optional(),
      markdown: z.string().optional(),
      tags: tagList.optional(),
      priority: z.number().int().optional(),
    })
    // `data.html || data.markdown` tested truthiness, so `html: '   '` counted as content
    // and BookStack answered 422: its `required_without` trims first, and a string that
    // trims to '' is "not present". The rule is therefore "at least one of the two holds
    // a non-whitespace character" - which is also why an empty html is still legal
    // ALONGSIDE a real markdown. hasContent() judges the trimmed value; the untrimmed one
    // is what gets sent. See NONBLANK_PATTERN in src/types.ts for the live evidence.
    .refine((data) => hasContent(data.html) || hasContent(data.markdown), {
      message:
        'Either html or markdown content is required, and it must contain a non-whitespace ' +
        'character: BookStack trims the body before validating, so content of only spaces ' +
        'counts as missing.',
    })
    .refine((data) => data.book_id || data.chapter_id, {
      message: 'Either book_id or chapter_id is required',
    }),

  // `html`/`markdown` are deliberately NOT nonblank here, unlike on create.
  //
  // Upstream states them as a bare `['string']` on update - no `required_without` - so
  // there is no rule to mirror, and emptying a page's body is a legitimate edit that
  // BookStack performs faithfully (`PUT /api/pages/N {"html":""}` -> 200, content now
  // empty). `html: '   '` reaches the same end by the same route: TrimStrings empties it
  // and the page is cleared. A caller who sends blank content on an UPDATE is plausibly
  // asking for exactly that, both halves of this contract accept it, and so there is no
  // disagreement to fix and no intent to second-guess.
  //
  // `name` is the opposite case, and is why it carries the rule: a blank name is never a
  // request to have no name, it just destroys the title and takes the slug with it.
  pageUpdate: z.strictObject({
    id: entityId,
    book_id: entityId.optional(),
    chapter_id: entityId.optional(),
    name: nonblankString(255).optional(),
    html: z.string().optional(),
    markdown: z.string().optional(),
    tags: tagList.optional(),
    priority: z.number().int().optional(),
  }),

  // Chapters
  // `created_by` is advertised by the tool and supported by BookStack, but was
  // absent here - so zod stripped it and the call silently came back unfiltered.
  chaptersList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum([
        'name',
        'created_at',
        'updated_at',
        'priority',
        '-name',
        '-created_at',
        '-updated_at',
        '-priority',
      ])
      .default('name'),
    filter: z
      .strictObject({
        book_id: entityId.optional(),
        name: z.string().optional(),
        created_by: entityId.optional(),
      })
      .optional(),
  }),

  // `default_template_id` is `['nullable', 'integer']` upstream and shares books'
  // implementation: BookStack stores null for any id that is not a visible template
  // page, and 0 clears it. Nothing is rejected, so this cannot be validated harder
  // here than "a non-negative integer" - the semantics are documented on the tool instead.
  chapterCreate: z.strictObject({
    name: nonblankString(255),
    book_id: entityId,
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: tagList.optional(),
    priority: z.number().int().optional(),
    default_template_id: defaultTemplateId.optional(),
  }),

  chapterUpdate: z.strictObject({
    id: entityId,
    name: nonblankString(255).optional(),
    book_id: entityId.optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: tagList.optional(),
    priority: z.number().int().optional(),
    default_template_id: defaultTemplateId.optional(),
  }),

  // Shelves
  // A leading `-` reverses the sort direction; verified live against v26.05.2.
  // Filters compare with `=`, so `name` is an exact match rather than a search.
  shelvesList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum(['name', 'created_at', 'updated_at', '-name', '-created_at', '-updated_at'])
      .default('name'),
    filter: z
      .strictObject({
        name: z.string().optional(),
        created_by: entityId.optional(),
      })
      .optional(),
  }),

  shelfCreate: z.strictObject({
    name: nonblankString(255),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: tagList.optional(),
    books: z.array(entityId).optional(),
  }),

  shelfUpdate: z.strictObject({
    id: entityId,
    name: nonblankString(255).optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: tagList.optional(),
    books: z.array(entityId).optional(),
  }),

  // Users
  // BookStack exposes no `active` field on users - there is no such column and
  // no such filter - so one is deliberately not accepted here.
  usersList: z.strictObject({
    count: listCount,
    offset: listOffset,
    // A leading `-` reverses the direction; verified live against v26.05.2.
    sort: z
      .enum([
        'name',
        'email',
        'created_at',
        'updated_at',
        '-name',
        '-email',
        '-created_at',
        '-updated_at',
      ])
      .default('name'),
    filter: z
      .strictObject({
        name: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
  }),

  // BookStack caps a user's `name` at 100 (`name => ['max:100']`), not the 255 this
  // once allowed. `email` carries no API-level max, but the column is varchar(191) and
  // MySQL truncates silently past it - so 191 is the honest limit for both create and
  // update.
  //
  // `language` is BookStack's own `['string', 'max:15', 'alpha_dash']`: alpha_dash permits
  // letters, numbers, dashes and underscores only. A MALFORMED value 422s upstream
  // (`{"language":"fr FR"}` -> 422 live on v26.05.2), so enforcing it here saves a
  // round-trip. A BLANK one does not: TrimStrings empties it and Laravel then skips every
  // non-implicit rule on it, so `{"language":"   "}` answers 200 and changes nothing. This
  // schema rejects that too - see LANGUAGE_PATTERN in src/types.ts - because silence is a
  // worse answer than an error for a caller who plainly meant something by it.
  userCreate: z.strictObject({
    name: nonblankString(100),
    email: z.string().email().max(191),
    password: z.string().min(8).optional(),
    roles: z.array(entityId).optional(),
    send_invite: z.boolean().optional(),
    external_auth_id: z.string().max(191).optional(),
    language: language.optional(),
  }),

  userUpdate: z.strictObject({
    id: entityId,
    name: nonblankString(100).optional(),
    email: z.string().email().max(191).optional(),
    password: z.string().min(8).optional(),
    roles: z.array(entityId).optional(),
    external_auth_id: z.string().max(191).optional(),
    language: language.optional(),
  }),

  // The heir is BookStack's own `['integer', 'exists:users,id']`, minus the existence
  // check nothing can honestly make here: an id this server cannot see is not thereby
  // absent. 0 is excluded because `UserRepo::destroy()` treats it as "no heir" via
  // `!empty()`, so passing it means the caller believes they are migrating ownership
  // while the content is quietly left unowned - the exact outcome they were avoiding.
  // See UserDeleteRequest for why upstream never rejects any of this.
  //
  // The self-heir case is rejected outright, because it is unsatisfiable BY CONSTRUCTION
  // rather than merely unlikely to succeed. `UserRepo::destroy()` runs `$user->delete()`
  // BEFORE `User::query()->find($newOwnerId)`, and User carries no SoftDeletes trait, so
  // when the two ids are equal the row is already gone and the lookup can only return
  // null. `migrateOwnership()` then writes `owned_by = NULL` across every entity the
  // account owned. Verified live on v26.05.2: DELETE /users/475 with
  // {"migrate_ownership_id": 475} answered 204, deleted the user, and left its book's
  // `owned_by` NULL. There is no id this server could substitute and no outcome worth
  // preserving, so this is the one heir value that is knowably wrong before the call.
  userDelete: z
    .strictObject({
      id: entityId,
      migrate_ownership_id: entityId.optional(),
    })
    .refine((data) => data.migrate_ownership_id !== data.id, {
      path: ['migrate_ownership_id'],
      message:
        'migrate_ownership_id must not be the user being deleted: BookStack removes the ' +
        'account before it looks the heir up, so an heir that IS that account can never be ' +
        'found, and every book, chapter, page and shelf it owned is left with no owner - ' +
        'the outcome migrate_ownership_id exists to avoid. The delete is irreversible and ' +
        'upstream reports success regardless. Name a different existing user as the heir, ' +
        'or omit migrate_ownership_id to accept unowned content deliberately.',
    }),

  // Roles
  // `system_name` is not one of the fields BookStack exposes for roles, so it can
  // neither be filtered nor sorted on: it is silently ignored upstream.
  //
  // `mfa_enforced` is validated as the boolean the tool advertises;
  // `toRolesListParams` maps it onto the 1/0 BookStack's tinyint column needs before
  // the request goes out. See `RolesListParams` for why a raw boolean returns exactly
  // the roles that do *not* enforce MFA.
  rolesList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum([
        'display_name',
        'created_at',
        'updated_at',
        '-display_name',
        '-created_at',
        '-updated_at',
      ])
      .default('display_name'),
    filter: z
      .strictObject({
        display_name: z.string().optional(),
        description: z.string().optional(),
        external_auth_id: z.string().optional(),
        mfa_enforced: z.boolean().optional(),
      })
      .optional(),
  }),

  // BookStack's own rules, read from the container's RoleApiController and verified live:
  // display_name => ['required', 'string', 'min:3', 'max:180'], description => ['max:180'],
  // external_auth_id => ['max:180'], and `permissions` as an array of permission-name
  // strings. `min:3` and the two 180s all 422 when broken, so accepting more here only
  // pushes the failure downstream.
  //
  // `min:3` is applied to the TRIMMED value upstream - see trimmedMinLengthPattern in
  // src/types.ts, where the live 422s for '   a' and '  ab  ' are recorded. This is the one
  // field in the API whose minimum is above one, on create and on update alike.
  roleCreate: z.strictObject({
    display_name: nonblankString(180, 3),
    description: z.string().max(180).optional(),
    external_auth_id: z.string().max(180).optional(),
    permissions: z.array(z.string()).optional(),
    mfa_enforced: z.boolean().optional(),
  }),

  roleUpdate: z.strictObject({
    id: entityId,
    display_name: nonblankString(180, 3).optional(),
    description: z.string().max(180).optional(),
    external_auth_id: z.string().max(180).optional(),
    permissions: z.array(z.string()).optional(),
    mfa_enforced: z.boolean().optional(),
  }),

  // Attachments
  // A leading `-` reverses the sort direction; verified live against v26.05.2.
  // Filters compare with `=`, so `name` and `extension` are exact matches rather
  // than searches.
  attachmentsList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum([
        'name',
        'extension',
        'uploaded_to',
        'created_at',
        'updated_at',
        '-name',
        '-extension',
        '-uploaded_to',
        '-created_at',
        '-updated_at',
      ])
      .default('name'),
    filter: z
      .strictObject({
        name: z.string().optional(),
        uploaded_to: entityId.optional(),
        extension: z.string().optional(),
      })
      .optional(),
  }),

  // EXACTLY one content source, enforced rather than advertised.
  //
  // This previously rejected only `file` + `file_path`, so `file` + `link` and
  // `file_path` + `link` were accepted and the multipart builder submitted both. See
  // ATTACHMENT_CONFLICT_REASON for what BookStack then does with them, and
  // `CreateAttachmentParams` for the live evidence. The error names the actual pair
  // received, because "provide exactly one" alone does not tell a caller which two of
  // their fields collided.
  attachmentCreate: z
    .strictObject({
      uploaded_to: entityId,
      name: z.string().min(1).max(255),
      file: z.string().optional(), // base64 encoded
      file_path: z.string().min(1).optional(), // server-local path
      link: z.string().url().optional(),
    })
    .superRefine((data, ctx) => {
      const { sources, conflictMessage } = providedAttachmentSources(data);

      if (conflictMessage) {
        ctx.addIssue({ code: 'custom', message: conflictMessage, path: [sources[1] as string] });
        return;
      }

      if (sources.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            'One of file (base64 content), file_path (a server-local path), or link (an external URL) is required',
        });
      }
    }),

  // AT MOST one content source: an update with none of the three is a legitimate
  // metadata-only change (a rename, or a move to another page).
  attachmentUpdate: z
    .strictObject({
      id: entityId,
      uploaded_to: entityId.optional(),
      name: z.string().min(1).max(255).optional(),
      file: z.string().optional(), // base64 encoded
      file_path: z.string().min(1).optional(), // server-local path
      link: z.string().url().optional(),
    })
    .superRefine((data, ctx) => {
      const { sources, conflictMessage } = providedAttachmentSources(data);
      if (conflictMessage) {
        ctx.addIssue({ code: 'custom', message: conflictMessage, path: [sources[1] as string] });
      }
    }),

  // Images
  // BookStack matches every `filter[field]` with `=` unless an operator suffix is
  // given, so each of these is an exact match rather than a substring search. A
  // filter naming a field the endpoint does not expose is dropped upstream without
  // an error, which would silently return an unfiltered gallery - so only fields
  // confirmed against the live endpoint are accepted here.
  // A leading `-` reverses the sort direction; verified live against v26.05.2.
  imagesList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum(['name', 'created_at', 'updated_at', '-name', '-created_at', '-updated_at'])
      .default('name'),
    filter: z
      .strictObject({
        name: z.string().optional(),
        type: z.enum(['gallery', 'drawio']).optional(),
        uploaded_to: entityId.optional(),
      })
      .optional(),
  }),

  // BookStack caps the image name at 180 characters, on both create and update.
  //
  // `name` is OPTIONAL, matching upstream: the rule is `['string', 'max:180']` with no
  // `required`, and the controller falls back to the uploaded file's filename when none
  // is given. Demanding one here made this server stricter than the API it wraps.
  imageCreate: z
    .strictObject({
      name: z.string().min(1).max(180).optional(),
      image: z.string().optional(), // base64 encoded
      file_path: z.string().min(1).optional(), // server-local path
      type: z.enum(['gallery', 'drawio']).default('gallery'),
      uploaded_to: entityId, // required by BookStack
    })
    .refine((data) => Boolean(data.image || data.file_path), {
      message: 'Either image (base64 content) or file_path (a server-local path) is required',
    })
    .refine((data) => !(data.image && data.file_path), {
      message: 'Provide either image (base64 content) or file_path (a server-local path), not both',
    }),

  imageUpdate: z
    .strictObject({
      id: entityId,
      name: z.string().min(1).max(180).optional(),
      image: z.string().optional(), // base64 encoded
      file_path: z.string().min(1).optional(), // server-local path
    })
    .refine((data) => !(data.image && data.file_path), {
      message: 'Provide either image (base64 content) or file_path (a server-local path), not both',
    }),

  // Search
  // BookStack's search caps `count` at 100 rather than the 500 the listings allow.
  //
  // `query` is `['required']` upstream (SearchApiController::$rules, read from the
  // container), which means Laravel's required: trimmed, and '' is missing. `.min(1)` alone
  // counted the spaces and forwarded a query BookStack was always going to refuse. Verified
  // live on v26.05.2, which is R5-W4's case:
  //
  //   GET /api/search?query=          -> 422 "The query field is required."
  //   GET /api/search?query=%20%20%20 -> 422 "The query field is required."
  //   GET /api/search?query=%09%0A    -> 422 "The query field is required."
  //   GET /api/search?query=a         -> 200
  //
  // No maximum: BookStack states none, so neither does this. `nonblankString` needs one, so
  // the rule is spelled out here rather than borrowing a cap nobody asked for.
  search: z.strictObject({
    query: z.string().min(1).regex(NONBLANK, NONBLANK_MESSAGE),
    page: z.number().int().min(1).default(1),
    count: z.number().int().min(1).max(100).default(20),
  }),

  // Audit Log
  // Only fields BookStack exposes for this endpoint can be filtered on; an
  // unknown key would be dropped upstream and quietly return an unfiltered log.
  // `date_from`/`date_to` are mapped onto `created_at` filter operators by
  // `toAuditLogListParams` before the request is sent.
  auditLogList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum(['-created_at', 'created_at', '-id', 'id', '-type', 'type', '-user_id', 'user_id'])
      .default('-created_at'),
    filter: z
      .strictObject({
        type: z.string().optional(),
        user_id: entityId.optional(),
        loggable_type: z.string().optional(),
        loggable_id: entityId.optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
      })
      .optional(),
  }),

  // Content Permissions
  // `content_type` and `content_id` are part of the request rather than the body: they
  // pick the endpoint (`/api/content-permissions/{type}/{id}`) and are stripped by the
  // handler afterwards. They are validated here because the handler used to cast
  // `content_type` straight to ContentType - a cast is not a check, so `content_typo` or
  // 'shelf' (BookStack calls it 'bookshelf') reached the URL builder unchallenged.
  //
  // BookStack requires view/create/update/delete whenever inheriting is false
  // (`required_if:fallback_permissions.inheriting,false`), so the two cases are
  // modelled as a union rather than four independently-optional flags.
  //
  // `owner_id` is validated as `['int']` upstream with no `exists:users,id` rule, so
  // an unknown user id is accepted and silently ignored rather than rejected. All
  // that can be enforced here is that it is a plausible user id.
  contentPermissionsUpdate: z.strictObject({
    content_type: z.enum(['bookshelf', 'book', 'chapter', 'page']),
    content_id: entityId,
    owner_id: entityId.optional(),
    role_permissions: z
      .array(
        z.strictObject({
          role_id: entityId,
          view: z.boolean(),
          create: z.boolean(),
          update: z.boolean(),
          delete: z.boolean(),
        })
      )
      .optional(),
    fallback_permissions: z
      .discriminatedUnion(
        'inheriting',
        [
          z.strictObject({ inheriting: z.literal(true) }),
          z.strictObject({
            inheriting: z.literal(false),
            view: z.boolean(),
            create: z.boolean(),
            update: z.boolean(),
            delete: z.boolean(),
          }),
        ],
        {
          error:
            'fallback_permissions must be either { inheriting: true } or { inheriting: false } with all four of view, create, update and delete supplied as booleans.',
        }
      )
      .optional(),
  }),

  // Export
  export: z.strictObject({
    id: entityId,
    format: z.enum(['html', 'pdf', 'plaintext', 'markdown']),
  }),

  // Generic ID parameter
  id: z.strictObject({
    id: entityId,
  }),

  // Recycle bin operations
  // A deletion's timestamp is `created_at`; BookStack exposes no `deleted_at`
  // field here, so sorting on one silently fell back to `id` ascending.
  recycleBinList: z.strictObject({
    count: listCount,
    offset: listOffset,
    sort: z
      .enum([
        '-created_at',
        'created_at',
        '-id',
        'id',
        'deletable_type',
        '-deletable_type',
        'deletable_id',
        '-deletable_id',
      ])
      .default('-created_at'),
  }),

  // The restore and purge tools take the deletion's own `id` - the field name their
  // published schemas use - so they validate with `id` above. A `recycleBinOperation`
  // schema naming a `deletion_id` sat here unused: no tool exposes that field, so it
  // could only ever have rejected the id a caller was told to send.

  // Content permissions
  //
  // These four are the whole set, and an unknown one is worth catching here rather than
  // upstream: `EntityProvider::get()` does `strtolower($type)` and then THROWS
  // `InvalidArgumentException` for anything it does not recognise, so BookStack answers a
  // wrong content_type with a 500, not a 4xx (GET /api/content-permissions/shelf/2592 ->
  // 500 live on v26.05.2, against 200 for .../book/2592). A caller who writes 'shelf'
  // instead of 'bookshelf' should be told which four words exist, not handed a server
  // error. The strtolower also means 'BOOK' reaches the same entity as 'book' upstream;
  // that spelling is still rejected here, because the enum this server publishes - and
  // therefore what a schema-driven client sends - is lower case.
  contentPermissions: z.strictObject({
    content_type: z.enum(['bookshelf', 'book', 'chapter', 'page']),
    content_id: entityId,
  }),

  // No-argument tools.
  //
  // An empty strict object is not a no-op: it is the difference between "takes no
  // parameters" being documentation and being enforced. `bookstack_system_info` used to
  // accept - and discard - anything at all, so a caller who sent {book_id: 5} believing
  // they were scoping the request got the whole instance's identity back and no hint that
  // their argument had meant nothing.
  systemInfo: z.strictObject({}),

  // Meta tools (src/tools/server-info.ts).
  //
  // Shape only, deliberately: each of these fields is a lookup key, and every one of
  // these handlers already answers an unrecognised value with a named error payload that
  // lists the values that would have worked (INVALID_SECTION and friends, which the tools
  // advertise in `error_codes`). Enum-checking them here would replace that guidance with
  // a ZodError and break the documented contract. What zod adds is what the handlers
  // cannot do for themselves: rejecting an unknown KEY, so `{catgeory: 'books'}` can no
  // longer read as "list every category" - and rejecting a non-string, so `.find()` is
  // never handed an object.
  serverInfo: z.strictObject({
    section: z.string().optional(),
  }),

  toolCategories: z.strictObject({
    category: z.string().optional(),
  }),

  usageExamples: z.strictObject({
    workflow: z.string().optional(),
  }),

  errorGuides: z.strictObject({
    error_code: z.string().optional(),
  }),

  help: z.strictObject({
    topic: z.string().optional(),
    context: z.string().optional(),
  }),
};

/**
 * Zod's own issue codes, as a closed list.
 *
 * WHY A LIST RATHER THAN `issue.code`. The non-strict warning below has to say WHAT was
 * wrong without saying what was in it, and a Zod issue is mostly prose: `message` quotes the
 * offending key ('Unrecognized key: "<the caller's key>"'), and `path`/`keys` ARE caller
 * text whenever the thing that failed is a key rather than a value. The code is the one
 * field drawn from a fixed vocabulary - and mapping it through this list is what makes that
 * a fact rather than an assumption, since `code` is typed as a union that a future Zod may
 * widen. Anything not on the list is reported as 'other', which still tells an operator that
 * something failed and how many times.
 */
const ZOD_ISSUE_CODES: ReadonlySet<string> = new Set([
  'invalid_type',
  'invalid_value',
  'too_big',
  'too_small',
  'invalid_format',
  'not_multiple_of',
  'unrecognized_keys',
  'invalid_union',
  'invalid_key',
  'invalid_element',
  'custom',
]);

/** An issue's code if Zod's, 'other' if not. Never the issue's message, path or keys. */
function safeIssueCodes(error: z.ZodError): string[] {
  const codes = error.issues.map((issue: z.core.$ZodIssue) =>
    ZOD_ISSUE_CODES.has(issue.code) ? issue.code : 'other'
  );
  return [...new Set(codes)].sort();
}

/**
 * Validation handler
 */
export class ValidationHandler {
  private enabled: boolean;
  private strictMode: boolean;
  private logger: Logger;

  constructor(config: { enabled: boolean; strictMode: boolean }) {
    this.enabled = config.enabled;
    this.strictMode = config.strictMode;
    this.logger = Logger.getInstance();
  }

  /**
   * Validate parameters against a schema
   */
  validateParams<T>(params: unknown, schemaName: keyof typeof ValidationSchemas): T {
    if (!this.enabled) {
      return params as T;
    }

    const schema = ValidationSchemas[schemaName];
    if (!schema) {
      throw new Error(`No validation schema found for ${schemaName}`);
    }

    try {
      return schema.parse(params) as T;
    } catch (error) {
      if (this.strictMode) {
        throw error;
      }

      // NON-STRICT MODE: SAY WHAT FAILED, NOT WHAT WAS IN IT.
      //
      // This was `console.warn('Validation warning for ' + schemaName + ':', error.message)`,
      // and it was two bugs in one line. Raw console.warn is the only output in this process
      // that never reaches the Logger, so it falsified the whole "every log line goes
      // through the redactor" claim - and what it wrote was a ZodError's message, which
      // quotes the offending property NAME verbatim ('Unrecognized key: "<marker>"'). A
      // caller who sent an unknown key named after their own data had it printed to the
      // operator's log, on the code path whose entire purpose is to tolerate unknown keys.
      // R6-W2.
      //
      // What survives is what an operator can act on: which of OUR schemas rejected the
      // call (the lookup above proves the name is ours), how many things were wrong with
      // it, and Zod's own codes for what kind of wrong. If they need the offending value
      // they can turn strict mode on, which returns the full ZodError to the caller who
      // sent it - which is where a rejected value belongs.
      const issues = error instanceof z.ZodError ? safeIssueCodes(error) : ['other'];
      this.logger.warn('Validation failed in non-strict mode; forwarding params unvalidated', {
        schema: schemaName,
        issue_count: error instanceof z.ZodError ? error.issues.length : 1,
        issue_codes: issues,
      });
      return params as T;
    }
  }

  /**
   * Validate required fields are present
   */
  validateRequired(params: Record<string, unknown>, requiredFields: string[]): void {
    if (!this.enabled) {
      return;
    }

    const missing = requiredFields.filter(
      (field) => params[field] === undefined || params[field] === null
    );

    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }
  }

  /**
   * Get available schemas
   */
  getAvailableSchemas(): string[] {
    return Object.keys(ValidationSchemas);
  }
}

export default ValidationHandler;

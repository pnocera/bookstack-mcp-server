/**
 * TypeScript interfaces for BookStack MCP Server
 * Generated from comprehensive API analysis
 */

/**
 * A user as embedded in other payloads (entity ownership, audit entries,
 * permission owners). BookStack only ever exposes these three fields here.
 */
export interface UserSummary {
  id: number;
  name: string;
  slug: string;
}

/**
 * BookStack renders `created_by`/`updated_by`/`owned_by` two different ways for
 * the same entity: a bare user ID in list responses, and an expanded
 * {id,name,slug} object on single-item reads. Verified against v26.05.2:
 * `GET /api/books` -> `"created_by": 1`, `GET /api/books/{id}` ->
 * `"created_by": {"id":1,"name":"Admin","slug":"admin"}`.
 */
export type UserRef = number | UserSummary;

/**
 * BookStack serves a different set of fields for a list entry than for a
 * single-item read: `apiListingResponse()` restricts a list to an explicit
 * field allow-list, and `tags`/`description_html` are not on it for any entity.
 * Verified against v26.05.2: `GET /api/books` returns neither, while
 * `GET /api/books/{id}` returns both. The same holds for chapters, pages and
 * shelves, so every `tags` below is optional rather than guaranteed.
 *
 * Check for presence before use - a list entry has no tags to read, which is
 * not the same as having no tags.
 */
// Core Entity Types
export interface Book {
  id: number;
  name: string;
  slug: string;
  description?: string;
  /** Absent from list responses; present on a single-item read. */
  description_html?: string;
  created_at: string;
  updated_at: string;
  created_by: UserRef;
  updated_by: UserRef;
  owned_by: UserRef;
  image_id?: number;
  /**
   * Absent from list responses. Present but `null` on a single-item read when no
   * default template is set - which is also what BookStack quietly stores when
   * asked to set a non-template page (see `DefaultTemplateId`).
   */
  default_template_id?: number | null;
  /** Absent from list responses; present on a single-item read. */
  tags?: Tag[];
  cover?: Image;
}

/**
 * A single entry of a book's `contents` tree, as returned by
 * `GET /api/books/{id}`.
 *
 * These are NOT the same shape as a `Chapter` or `Page` from their own
 * endpoints: BookStack builds them with `ApiEntityListFormatter`, which emits a
 * fixed, much smaller field set (no `created_by`/`updated_by`/`owned_by`, no
 * `tags`, no `description`, no `revision_count`/`editor`) plus a computed `url`.
 * The formatter omits any field whose value is null, which is why several
 * fields below are optional. Verified against a live v26.05.2 response.
 */
interface BookContentsEntry {
  id: number;
  name: string;
  slug: string;
  book_id: number;
  priority: number;
  created_at: string;
  updated_at: string;
  /** Computed by the formatter (`$entity->getUrl()`); always present. */
  url: string;
}

/**
 * A page sitting directly under the book, as it appears in `contents`.
 *
 * `chapter_id` is normally absent here: a page whose chapter is visible is
 * nested inside that chapter instead, so a top-level page's `chapter_id` is
 * null and the formatter drops it. It reappears only in BookStack's "lone page"
 * case - a page whose parent chapter is not visible to the caller, which
 * `BookContents::getTree()` promotes to the top level while its `chapter_id`
 * stays set.
 */
export interface BookContentsPage extends BookContentsEntry {
  type: 'page';
  draft: boolean;
  template: boolean;
  chapter_id?: number;
}

/**
 * A page nested inside a chapter's `pages` array.
 *
 * Distinct from `BookContentsPage`: BookStack formats these with a plain
 * `format()` rather than `withType()`, so they carry NO `type` discriminator.
 * Their `chapter_id` is always set, since being nested is what puts them here.
 */
export interface BookContentsChapterPage extends BookContentsEntry {
  chapter_id: number;
  draft: boolean;
  template: boolean;
}

/**
 * A chapter as it appears in `contents`, carrying its own visible pages.
 *
 * `pages` is always present (an empty array for a chapter with no visible
 * pages) and is the only place nested pages appear. A chapter model has no
 * `draft`/`template`/`chapter_id` attributes, so the formatter never emits them
 * here.
 */
export interface BookContentsChapter extends BookContentsEntry {
  type: 'chapter';
  pages: BookContentsChapterPage[];
}

/**
 * Discriminate on `type`, which BookStack sets on every top-level entry.
 */
export type BookContentsItem = BookContentsPage | BookContentsChapter;

export interface BookWithContents extends Book {
  contents: BookContentsItem[];
}

export interface Page {
  id: number;
  book_id: number;
  /**
   * Always present, and `null` for a page that sits directly in a book rather
   * than in a chapter. BookStack never omits the field.
   */
  chapter_id: number | null;
  name: string;
  slug: string;
  priority: number;
  draft: boolean;
  template: boolean;
  created_at: string;
  updated_at: string;
  created_by: UserRef;
  updated_by: UserRef;
  owned_by: UserRef;
  revision_count: number;
  editor: string;
  /** Absent from list responses; present on a single-item read. */
  tags?: Tag[];
}

export interface PageWithContent extends Page {
  html: string;
  raw_html: string;
  markdown?: string;
}

export interface Chapter {
  id: number;
  book_id: number;
  name: string;
  slug: string;
  description?: string;
  description_html?: string;
  priority: number;
  created_at: string;
  updated_at: string;
  created_by: UserRef;
  updated_by: UserRef;
  owned_by: UserRef;
  /**
   * Absent from list responses. Present but `null` on a single-item read when no
   * default template is set - which is also what BookStack quietly stores when
   * asked to set a non-template page (see `DefaultTemplateId`).
   */
  default_template_id?: number | null;
  /** Absent from list responses; present on a single-item read. */
  tags?: Tag[];
}

/**
 * `pages` here carries more per-page fields than a formatter-built list would:
 * BookStack selects the full page row plus created_by/updated_by/revision_count/
 * editor "for backwards compatibility". Only `tags` is missing, which is why
 * `Page.tags` is optional.
 */
export interface ChapterWithPages extends Chapter {
  pages: Page[];
}

export interface Bookshelf {
  id: number;
  name: string;
  slug: string;
  description?: string;
  description_html?: string;
  created_at: string;
  updated_at: string;
  created_by: UserRef;
  updated_by: UserRef;
  owned_by: UserRef;
  image_id?: number;
  /** Absent from list responses; present on a single-item read. */
  tags?: Tag[];
  cover?: Image;
}

export interface BookshelfWithBooks extends Bookshelf {
  books: Book[];
}

/**
 * A role as embedded in another payload, rather than read from the roles endpoint.
 *
 * BookStack loads these with an explicit two-column projection - `roles:id,display_name`
 * in `UserApiController::singleFormatter()` - so a full `Role` is never what arrives
 * here. Verified against v26.05.2: `GET /api/users/1` ->
 * `"roles": [{"id": 1, "display_name": "Admin"}]`.
 *
 * Read the id and pass it to `getRole()` when the rest of the role is needed.
 */
export interface RoleReference {
  id: number;
  display_name: string;
}

/**
 * The fields carried by every user payload, list or single.
 *
 * `UserApiController::listFormatter()` computes `profile_url`/`edit_url`/`avatar_url`
 * onto each user, and runs for single reads too (via `singleFormatter`), so all three
 * are always present. `external_auth_id` is `""` rather than null when the account has
 * no external identity.
 */
export interface User {
  id: number;
  name: string;
  slug: string;
  email: string;
  external_auth_id: string;
  created_at: string;
  updated_at: string;
  profile_url: string;
  edit_url: string;
  avatar_url: string;
}

/**
 * A user as returned by `GET /api/users`.
 *
 * `last_activity_at` exists ONLY on the listing: `list()` applies the
 * `withLastActivityAt` scope and no single-user endpoint does, so it cannot be read
 * back from `getUser()`. It is null for an account that has never been active
 * (verified live on v26.05.2 against a freshly created user).
 */
export interface UserListItem extends User {
  last_activity_at: string | null;
}

/**
 * A user as returned by every single-user endpoint - `GET`, `POST` and `PUT` on
 * /api/users all finish with `singleFormatter()`, which adds `roles` and nothing else.
 *
 * Two consequences, both verified live on v26.05.2:
 *  - `roles` holds `RoleReference`s, NOT full roles.
 *  - there is no `last_activity_at` here; only `UserListItem` has one.
 */
export interface UserWithRoles extends User {
  roles: RoleReference[];
}

/** The fields on every role payload, whichever endpoint produced it. */
interface RoleBase {
  id: number;
  display_name: string;
  mfa_enforced: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * The stored role columns, as present on every response that reads a role back out of
 * the database: list, read and update. Create does NOT qualify - see `RoleCreateResult`.
 */
interface RolePersisted extends RoleBase {
  /** null when never set - BookStack does not coerce this one to "". */
  description: string | null;
  /** BookStack's internal name for a role it defines itself ("admin"); `""` otherwise. */
  system_name: string;
  /** `""` rather than null when unset. */
  external_auth_id: string;
}

/**
 * A role as returned by `GET /api/roles`.
 *
 * The two counts appear ONLY here: `RoleApiController::list()` adds them with
 * `withCount(['users', 'permissions'])`, which no single-role endpoint does. In exchange
 * the listing carries neither `permissions` nor `users` - it reports how many, not which.
 */
export interface RoleListItem extends RolePersisted {
  users_count: number;
  permissions_count: number;
}

/**
 * A role as returned by `GET /api/roles/{id}` and `PUT /api/roles/{id}`.
 *
 * `singleFormatter()` swaps the permissions relation for an alphabetically ordered list
 * of permission NAMES and loads `users:id,name,slug`. It applies no `withCount`, so the
 * `users_count`/`permissions_count` of `RoleListItem` are absent here.
 */
export interface RoleWithPermissions extends RolePersisted {
  permissions: string[];
  users: UserSummary[];
}

/**
 * A role as returned by `POST /api/roles`.
 *
 * Deliberately not `RoleWithPermissions`: create responds with the freshly saved model,
 * which carries only the attributes that were actually assigned to it. Verified live on
 * v26.05.2 - creating a role with just a `display_name` returned no `description`, no
 * `external_auth_id` and no `system_name` at all, while reading the same role back a
 * moment later returned all three (`description: null`, the others `""`).
 *
 * Re-read the role with `getRole()` if you need its settled shape.
 */
export interface RoleCreateResult extends RoleBase {
  permissions: string[];
  users: UserSummary[];
  /** Present only when it was supplied on the create call. */
  description?: string;
  /** Present only when it was supplied on the create call. */
  external_auth_id?: string;
}

/** The fields on every attachment payload. */
interface AttachmentBase {
  id: number;
  name: string;
  /** `""` for a link attachment, which has no file behind it. */
  extension: string;
  uploaded_to: number;
  /** true when the attachment is only a link; false for an uploaded file. */
  external: boolean;
  order: number;
  created_at: string;
  updated_at: string;
}

/**
 * An attachment as returned by `GET /api/attachments`, `POST /api/attachments` and
 * `PUT /api/attachments/{id}`.
 *
 * All three hand back the bare model: `created_by`/`updated_by` are plain user IDs, and
 * neither `links` nor `content` is present - only the read endpoint adds those. Verified
 * live on v26.05.2 against all three. Requiring `links` here (as this type once did)
 * promised a property that three of the four attachment endpoints never send.
 */
export interface Attachment extends AttachmentBase {
  created_by: number;
  updated_by: number;
}

/**
 * An attachment as returned by `GET /api/attachments/{id}`.
 *
 * The read endpoint is the odd one out: it eager-loads `createdBy`/`updatedBy`, so those
 * expand into objects where every other attachment response leaves them as bare IDs, and
 * it is the only one to set `links` and `content`.
 */
export interface AttachmentDetail extends AttachmentBase {
  created_by: UserSummary;
  updated_by: UserSummary;
  links: {
    html: string;
    markdown: string;
  };
  /**
   * The payload itself: base64-encoded file bytes when `external` is false, or the
   * target URL verbatim when it is true. Check `external` before using this.
   */
  content: string;
}

/** The fields on every image payload. */
interface ImageBase {
  id: number;
  name: string;
  url: string;
  path: string;
  /** 'gallery' or 'drawio' from the gallery endpoints; 'cover_book' etc. for a cover. */
  type: string;
  /** The ID of the page the image was uploaded to. */
  uploaded_to: number;
  created_at: string;
  updated_at: string;
}

/**
 * An image as returned by `GET /api/image-gallery` - the bare columns named in
 * `ImageGalleryApiController::$fieldsToExpose`, with `created_by`/`updated_by` as plain
 * user IDs and no `thumbs`/`content`.
 *
 * This is also the shape of a book's or shelf's embedded `cover` (verified live on
 * v26.05.2), which serialises the same model without the single-response formatter.
 */
export interface Image extends ImageBase {
  created_by: number;
  updated_by: number;
}

/**
 * An image as returned by every single-image endpoint: `GET`, `POST` and `PUT` on
 * /api/image-gallery all run `formatForSingleResponse()`, which expands the creator
 * relations and appends `thumbs` and `content`.
 */
export interface ImageDetail extends ImageBase {
  created_by: UserSummary;
  updated_by: UserSummary;
  /**
   * Scaled variants BookStack may use in its UI. Either entry is null when the resize
   * failed: `ImageResizer::loadGalleryThumbnailsForImage()` swallows the exception and
   * leaves the entry null rather than failing the request.
   */
  thumbs: {
    gallery: string | null;
    display: string | null;
  };
  /** Ready-made markup for embedding the image, as BookStack itself would. */
  content: {
    html: string;
    markdown: string;
  };
}

export interface Tag {
  name: string;
  value: string;
  order: number;
}

export interface SearchResult {
  id: number;
  name: string;
  slug: string;
  type: 'bookshelf' | 'book' | 'chapter' | 'page';
  url: string;
  preview_html: {
    name: string;
    content: string;
  };
  tags: Tag[];
  book?: Book;
  chapter?: Chapter;
}

/**
 * An entry in the recycle bin.
 *
 * The deletion's own timestamp is `created_at` (when the item was deleted),
 * not `deleted_at` - BookStack sends no such field.
 */
export interface RecycleBinItem {
  id: number;
  created_at: string;
  updated_at: string;
  deletable_type: string;
  deletable_id: number;
  deleted_by: number;
  deletable: unknown;
}

/**
 * The result of restoring one recycle-bin entry.
 *
 * A single entry can stand for a whole subtree: deleting a book with a chapter and
 * a page makes exactly one bin entry, and restoring it restores all three. The
 * count is the total number of items brought back, so it is routinely larger than
 * the one entry that was restored.
 */
export interface RecycleBinRestoreResult {
  restore_count: number;
}

/**
 * The result of permanently destroying one recycle-bin entry.
 *
 * `delete_count` counts every item destroyed, which for a subtree is more than the
 * single entry named - the same relationship as `RecycleBinRestoreResult`.
 */
export interface RecycleBinDeleteResult {
  delete_count: number;
}

/**
 * Content-level permission overrides for a single item.
 *
 * The fallback values are `null` whenever `inheriting` is true; BookStack only
 * populates them once inheritance is switched off.
 */
export interface ContentPermissions {
  owner: UserSummary;
  role_permissions: {
    role_id: number;
    view: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
    /** The same two-field projection BookStack embeds everywhere else it names a role. */
    role: RoleReference;
  }[];
  fallback_permissions: {
    inheriting: boolean;
    view: boolean | null;
    create: boolean | null;
    update: boolean | null;
    delete: boolean | null;
  };
}

/**
 * An audit log entry.
 *
 * The affected item is identified by `loggable_type`/`loggable_id`, both of
 * which are null for events that target no content item (and for content that
 * has since been destroyed). BookStack currently only sets them for the core
 * content types: page, book, chapter, bookshelf.
 */
export interface AuditLogEntry {
  id: number;
  type: string;
  detail: string;
  user_id: number;
  loggable_type: string | null;
  loggable_id: number | null;
  ip: string;
  created_at: string;
  user: UserSummary;
}

/**
 * The payload of `GET /api/system`.
 *
 * Verified against BookStack v26.05.2, which returns exactly these five fields.
 */
export interface SystemInfo {
  version: string;
  instance_id: string;
  app_name: string;
  app_logo: string;
  base_url: string;
}

// API Response Types
export interface ListResponse<T> {
  data: T[];
  total: number;
}

export interface ErrorResponse {
  error: {
    code: number;
    message: string;
    validation?: Record<string, string[]>;
  };
}

// Tool Parameter Types
export interface PaginationParams {
  count?: number;
  offset?: number;
  sort?: string;
}

export interface BooksListParams extends PaginationParams {
  filter?: {
    name?: string;
    created_by?: number;
  };
}

/**
 * The page query as it goes over the wire.
 *
 * `draft` and `template` are deliberately 1/0 rather than booleans. They are
 * `tinyint(1)` columns, and BookStack drops a filter value straight into a SQL
 * comparison without casting it, so MySQL coerces the strings "true"/"false" to
 * 0. `filter[draft]=true` therefore means `draft = 0` - the exact opposite of
 * what was asked, returned as a clean HTTP 200 with no hint anything is wrong.
 * Verified live on v26.05.2 against a book holding one template page and one
 * normal page: `filter[template]=true` returned the NORMAL page, while
 * `filter[template]=1` returned the template. Only 1/0 reads correctly.
 *
 * Callers should build this from `PagesListInput` via `toPagesListParams`.
 */
export interface PagesListParams extends PaginationParams {
  filter?: {
    book_id?: number;
    chapter_id?: number;
    name?: string;
    created_by?: number;
    draft?: 0 | 1;
    template?: 0 | 1;
  };
}

/**
 * The page query as callers of the MCP tool express it: `draft`/`template` read
 * as the booleans they logically are, and `toPagesListParams` maps them onto the
 * 1/0 the database actually needs.
 */
export interface PagesListInput extends PaginationParams {
  filter?: {
    book_id?: number;
    chapter_id?: number;
    name?: string;
    created_by?: number;
    draft?: boolean;
    template?: boolean;
  };
}

/**
 * Translate the tool-facing page query into BookStack's wire format, mapping the
 * boolean flags onto the 1/0 its tinyint columns compare correctly against.
 */
export function toPagesListParams(input: PagesListInput): PagesListParams {
  const { filter, ...rest } = input;
  if (!filter) {
    return rest;
  }

  const { draft, template, ...passthrough } = filter;
  const wireFilter: NonNullable<PagesListParams['filter']> = { ...passthrough };

  if (draft !== undefined) {
    wireFilter.draft = draft ? 1 : 0;
  }
  if (template !== undefined) {
    wireFilter.template = template ? 1 : 0;
  }

  return { ...rest, filter: wireFilter };
}

export interface ChaptersListParams extends PaginationParams {
  filter?: {
    book_id?: number;
    name?: string;
    created_by?: number;
  };
}

export interface ShelvesListParams extends PaginationParams {
  filter?: {
    name?: string;
    created_by?: number;
  };
}

export interface UsersListParams extends PaginationParams {
  filter?: {
    name?: string;
    email?: string;
  };
}

/** A leading `-` reverses the direction, e.g. `-created_at`. */
export type RolesListSort =
  | 'display_name'
  | 'created_at'
  | 'updated_at'
  | '-display_name'
  | '-created_at'
  | '-updated_at';

/**
 * The role query as it goes over the wire.
 *
 * `mfa_enforced` is 1/0 rather than a boolean for the same reason as `draft` and
 * `template` on pages: it is a `tinyint(1)` column compared against an uncast
 * filter value, so MySQL reads the string "true" as 0. Verified live on
 * v26.05.2: `filter[mfa_enforced]=true` returned 5 roles that all had MFA
 * *disabled*, while `filter[mfa_enforced]=1` returned the single role that
 * enforces it.
 *
 * BookStack only filters on the fields it exposes for roles; `system_name` is
 * not among them and is silently ignored, so it is deliberately absent here.
 *
 * Callers should build this from `RolesListInput` via `toRolesListParams`.
 */
export interface RolesListParams extends PaginationParams {
  sort?: RolesListSort;
  filter?: {
    display_name?: string;
    description?: string;
    external_auth_id?: string;
    mfa_enforced?: 0 | 1;
  };
}

/**
 * The role query as callers of the MCP tool express it, with `mfa_enforced` as
 * the boolean it logically is.
 */
export interface RolesListInput extends PaginationParams {
  sort?: RolesListSort;
  filter?: {
    display_name?: string;
    description?: string;
    external_auth_id?: string;
    mfa_enforced?: boolean;
  };
}

/**
 * Translate the tool-facing role query into BookStack's wire format, mapping
 * `mfa_enforced` onto the 1/0 its tinyint column compares correctly against.
 */
export function toRolesListParams(input: RolesListInput): RolesListParams {
  const { filter, ...rest } = input;
  if (!filter) {
    return rest;
  }

  const { mfa_enforced, ...passthrough } = filter;
  const wireFilter: NonNullable<RolesListParams['filter']> = { ...passthrough };

  if (mfa_enforced !== undefined) {
    wireFilter.mfa_enforced = mfa_enforced ? 1 : 0;
  }

  return { ...rest, filter: wireFilter };
}

export interface AttachmentsListParams extends PaginationParams {
  filter?: {
    name?: string;
    uploaded_to?: number;
    extension?: string;
  };
}

export interface SearchParams {
  query: string;
  page?: number;
  count?: number;
}

export interface ImageGalleryListParams extends PaginationParams {
  filter?: {
    name?: string;
    type?: 'gallery' | 'drawio';
    /** The ID of the page the image was uploaded to. */
    uploaded_to?: number;
  };
}

/**
 * The audit-log query as it goes over the wire.
 *
 * BookStack only honours filters naming a field it exposes for the endpoint
 * (id, type, detail, user_id, loggable_id, loggable_type, ip, created_at); any
 * other key is silently dropped rather than reported. Date ranges therefore use
 * BookStack's `field:operator` filter syntax against `created_at`.
 *
 * Callers should build this from `AuditLogListInput` via `toAuditLogListParams`.
 */
export interface AuditLogListParams extends PaginationParams {
  filter?: {
    type?: string;
    user_id?: number;
    loggable_type?: string;
    loggable_id?: number;
    'created_at:gte'?: string;
    'created_at:lte'?: string;
  };
}

/**
 * The audit-log query as callers of the MCP tool express it: `date_from`/`date_to`
 * read better than the raw `created_at:gte`/`created_at:lte` filter operators.
 */
export interface AuditLogListInput extends PaginationParams {
  filter?: {
    type?: string;
    user_id?: number;
    loggable_type?: string;
    loggable_id?: number;
    date_from?: string;
    date_to?: string;
  };
}

/**
 * Translate the tool-facing audit-log query into BookStack's wire format,
 * mapping the date range onto `created_at` filter operators.
 */
export function toAuditLogListParams(input: AuditLogListInput): AuditLogListParams {
  const { filter, ...rest } = input;
  if (!filter) {
    return rest;
  }

  const { date_from, date_to, ...passthrough } = filter;
  const wireFilter: NonNullable<AuditLogListParams['filter']> = { ...passthrough };

  if (date_from !== undefined) {
    wireFilter['created_at:gte'] = date_from;
  }
  if (date_to !== undefined) {
    wireFilter['created_at:lte'] = date_to;
  }

  return { ...rest, filter: wireFilter };
}

// Create/Update Parameter Types
export interface CreateBookParams {
  name: string;
  description?: string;
  description_html?: string;
  tags?: Tag[];
  default_template_id?: number;
}

export interface UpdateBookParams {
  name?: string;
  description?: string;
  description_html?: string;
  tags?: Tag[];
  default_template_id?: number;
}

export interface CreatePageParams {
  book_id?: number;
  chapter_id?: number;
  name: string;
  html?: string;
  markdown?: string;
  tags?: Tag[];
  priority?: number;
}

export interface UpdatePageParams {
  book_id?: number;
  chapter_id?: number;
  name?: string;
  html?: string;
  markdown?: string;
  tags?: Tag[];
  priority?: number;
}

/**
 * The page to pre-fill new pages in this container from.
 *
 * Books and chapters share one implementation (`EntityDefaultTemplate::setFromId`),
 * so the semantics are identical - and quietly lossy:
 *
 *  - The ID must be a page **marked as a template** and visible to the caller.
 *  - A normal (non-template) page ID, or one that does not exist, is **silently
 *    stored as null**. BookStack answers HTTP 200 and the response simply comes
 *    back with `default_template_id: null` - there is no 422 and no warning.
 *  - `0` clears the setting.
 *
 * Verified live on v26.05.2 against a chapter: a template page ID stored as
 * given, a normal page ID and 99999 both landed as null on a 200, and 0 cleared
 * it. Read the response back to confirm the value actually took.
 */
type DefaultTemplateId = number;

export interface CreateChapterParams {
  name: string;
  book_id: number;
  description?: string;
  description_html?: string;
  tags?: Tag[];
  priority?: number;
  /** See `DefaultTemplateId`: must be a template page, or it is stored as null. */
  default_template_id?: DefaultTemplateId;
}

export interface UpdateChapterParams {
  name?: string;
  book_id?: number;
  description?: string;
  description_html?: string;
  tags?: Tag[];
  priority?: number;
  /** See `DefaultTemplateId`: must be a template page, or it is stored as null. */
  default_template_id?: DefaultTemplateId;
}

export interface CreateShelfParams {
  name: string;
  description?: string;
  description_html?: string;
  tags?: Tag[];
  books?: number[];
}

export interface UpdateShelfParams {
  name?: string;
  description?: string;
  description_html?: string;
  tags?: Tag[];
  books?: number[];
}

/**
 * The user's preferred interface language, e.g. `fr` or `pt_BR`.
 *
 * BookStack validates it as `['string', 'max:15', 'alpha_dash']` and stores it as
 * a user setting rather than a column, which is why no response ever echoes it
 * back - not the create response, and not `GET /api/users/{id}`. Verified live on
 * v26.05.2: creating a user with `language: "fr"` persists the setting
 * `user:{id}:language = fr`, and an update to `pt_BR` moves it.
 *
 * BookStack does not check the value against its installed locales, so an
 * unrecognised-but-well-formed code is stored as given and simply falls back to
 * the instance default at render time.
 */
type UserLanguage = string;

export interface CreateUserParams {
  name: string;
  email: string;
  password?: string;
  roles?: number[];
  send_invite?: boolean;
  external_auth_id?: string;
  /** See `UserLanguage`: write-only, never returned by the API. */
  language?: UserLanguage;
}

/**
 * BookStack's user-update endpoint accepts no `active` field, and the `users`
 * table has no such column - there is no API-driven way to deactivate a user.
 */
export interface UpdateUserParams {
  name?: string;
  email?: string;
  password?: string;
  roles?: number[];
  external_auth_id?: string;
  /** See `UserLanguage`: write-only, never returned by the API. */
  language?: UserLanguage;
}

export interface CreateRoleParams {
  display_name: string;
  description?: string;
  external_auth_id?: string;
  permissions?: string[];
  mfa_enforced?: boolean;
}

export interface UpdateRoleParams {
  display_name?: string;
  description?: string;
  external_auth_id?: string;
  permissions?: string[];
  mfa_enforced?: boolean;
}

/** The attachment fields that are independent of where its content comes from. */
interface AttachmentContentBase {
  /** base64-encoded file bytes. */
  file?: string;
  /** A server-local path, read by this server (access-controlled) rather than sent as-is. */
  file_path?: string;
  /** An external URL, making this a link attachment rather than an uploaded file. */
  link?: string;
}

/**
 * WHY THE CONTENT SOURCES ARE MUTUALLY EXCLUSIVE, AND NOT MERELY DISCOURAGED.
 *
 * BookStack's `AttachmentApiController::create()` uploads the file first and only then
 * calls `AttachmentService::updateFile()`, which - for any non-empty `link` - runs
 * `deleteFileInStorage()`, flips `external` to true, blanks `extension` and overwrites
 * `path` with the link. So sending a file *and* a link does not fail, and does not
 * prefer the file: it stores the upload, deletes it, and hands back an external link.
 *
 * Verified live on v26.05.2: `POST /api/attachments` with both `file` and `link` returned
 * `external: true`, `extension: ""` and a `content` of the link URL - the uploaded bytes
 * were gone. That is a materially different attachment from the one that was asked for,
 * reported as a success, which is why exactly-one is a type-level constraint here rather
 * than a note in a description.
 *
 * `file_path` is this server's own convenience parameter, not a BookStack field: it is
 * resolved into `file` while the request is built and never forwarded upstream.
 */
export type CreateAttachmentParams = {
  uploaded_to: number;
  name: string;
} & (
  | (AttachmentContentBase & { file: string; file_path?: undefined; link?: undefined })
  | (AttachmentContentBase & { file_path: string; file?: undefined; link?: undefined })
  | (AttachmentContentBase & { link: string; file?: undefined; file_path?: undefined })
);

/**
 * An attachment update, which - unlike create - may legitimately carry no content at all:
 * renaming or moving an attachment is a metadata-only change.
 *
 * At most one content source may be given, for the same reason `CreateAttachmentParams`
 * demands exactly one: `update()` reaches the same `updateFile()` call, so a `file` sent
 * alongside a `link` is uploaded and then immediately discarded.
 */
export type UpdateAttachmentParams = {
  uploaded_to?: number;
  name?: string;
} & (
  | (AttachmentContentBase & { file?: undefined; file_path?: undefined; link?: undefined })
  | (AttachmentContentBase & { file: string; file_path?: undefined; link?: undefined })
  | (AttachmentContentBase & { file_path: string; file?: undefined; link?: undefined })
  | (AttachmentContentBase & { link: string; file?: undefined; file_path?: undefined })
);

export interface CreateImageParams {
  /**
   * Optional, exactly as upstream has it: BookStack declares `'name' => ['string',
   * 'max:180']` with no `required`, and `ImageGalleryApiController::create()` only
   * applies a name when one `isset()`, otherwise leaving the one `saveNew()` derived
   * from the uploaded file's filename.
   *
   * Verified live on v26.05.2: uploading `no-name-probe.png` with no `name` returned
   * HTTP 200 with `"name": "no-name-probe.png"`.
   */
  name?: string;
  image?: string; // base64 encoded; alternative to file_path
  file_path?: string; // server-local path, read by the server (access-controlled)
  type?: 'gallery' | 'drawio';
  uploaded_to: number; // required by BookStack: the page the image is attached to
}

export interface UpdateImageParams {
  name?: string;
  image?: string; // base64 encoded; alternative to file_path
  file_path?: string; // server-local path, read by the server (access-controlled)
}

/**
 * The fallback (non-role-specific) permission block.
 *
 * BookStack ties the four action flags to `inheriting`: each is
 * `required_if:fallback_permissions.inheriting,false`. Inheriting from the
 * parent means no flags may be needed; switching inheritance off means all four
 * must be stated. Modelling that as a union rejects the invalid combination at
 * the boundary instead of at a 422.
 */
export type FallbackPermissions =
  | { inheriting: true }
  | {
      inheriting: false;
      view: boolean;
      create: boolean;
      update: boolean;
      delete: boolean;
    };

export interface UpdateContentPermissionsParams {
  /**
   * Reassign ownership of the item to this user.
   *
   * Note the asymmetry with `ContentPermissions`: a read returns the owner as an
   * expanded `owner` object, while an update sets it by bare `owner_id`.
   *
   * BookStack validates this as `['int']` only - unlike `role_permissions.*.role_id`
   * it carries no `exists:users,id` rule, and `PermissionsUpdater::updateOwnerFromId()`
   * simply skips the assignment when the lookup finds nothing. An unknown user ID is
   * therefore accepted with an HTTP 200 that leaves the owner untouched, with no 422
   * and no other indication (verified live on v26.05.2). Confirm the ID first, or
   * re-read the item and check `owner` afterwards.
   */
  owner_id?: number;
  role_permissions?: {
    role_id: number;
    view: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
  }[];
  fallback_permissions?: FallbackPermissions;
}

/**
 * A JSON Schema fragment, as advertised to MCP clients on a tool's `inputSchema`.
 *
 * Typed rather than `Record<string, unknown>` so that the advertised contract is checked
 * at compile time: a misspelled `maxlength` or a `filter` whose `properties` is not a
 * schema is now a type error instead of a keyword an LLM silently ignores.
 */
export interface MCPSchemaNode {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  title?: string;
  description?: string;
  properties?: Record<string, MCPSchemaNode>;
  items?: MCPSchemaNode;
  required?: string[];
  /**
   * Set by `withClosedSchemas()` rather than by hand; see that function for why.
   */
  additionalProperties?: boolean;
  enum?: readonly string[];
  /**
   * Pin a property to one exact value. Boolean-capable on purpose: it is what lets a
   * `oneOf` branch discriminate on a flag such as `fallback_permissions.inheriting`,
   * whose two values select two different required sets.
   */
  const?: string | number | boolean;
  default?: string | number | boolean;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /**
   * A regular expression the string must match, in JSON Schema's sense: UNANCHORED, so
   * the pattern must merely be found somewhere in the value unless it anchors itself.
   * That is what lets NONBLANK_PATTERN be the single character class `\S`.
   */
  pattern?: string;
  /** Exactly one branch must match - used for genuinely exclusive alternatives. */
  oneOf?: MCPSchemaNode[];
  /** Every branch must match - used to state pairwise exclusions. */
  allOf?: MCPSchemaNode[];
  anyOf?: MCPSchemaNode[];
  not?: MCPSchemaNode;
}

/** The top-level `inputSchema` of a tool: always an object schema. */
export interface MCPInputSchema extends MCPSchemaNode {
  type: 'object';
  properties: Record<string, MCPSchemaNode>;
}

/**
 * "Holds at least one non-whitespace character" - what BookStack's `required` actually
 * means, expressed once for both halves of the contract.
 *
 * WHY `minLength: 1` IS NOT ENOUGH. `minLength`/`z.string().min(1)` count characters, and
 * a space is a character - so `name: '   '` satisfied both while BookStack rejected it.
 * Laravel's `validateRequired()` is `is_string($value) && trim($value) === '' -> false`,
 * and BookStack additionally runs the global `TrimStrings` middleware, which rewrites the
 * JSON body BEFORE validation (`TransformsRequest::clean()` cleans `$request->json()`;
 * only `password*` is excepted). So a whitespace-only required field arrives at the
 * validator as '' and fails. Verified live against v26.05.2:
 *
 *   POST /api/books           {"name":"   "}                        -> 422 name required
 *   POST /api/chapters        {"book_id":N,"name":"   "}            -> 422 name required
 *   POST /api/bookshelves     {"name":"   "}                        -> 422 name required
 *   POST /api/pages           {"book_id":N,"name":"   ",...}        -> 422 name required
 *   POST /api/pages           {"book_id":N,"name":"P","html":"   "} -> 422 html required
 *                                                                       when markdown
 *                                                                       is not present
 *
 * The same reading explains the UPDATE side, where the rule is `['string','min:1',...]`
 * with no `required`: a value that trims to '' is not "present" for Laravel, so every
 * non-implicit rule on it is SKIPPED (`Validator::presentOrRuleIsImplicit()`), `min:1`
 * never runs, and the already-trimmed '' is stored. Verified live on v26.05.2:
 *
 *   PUT /api/books/N  {"name":"   "} -> 200, and the book's name is now '' (slug '16790')
 *   PUT /api/pages/N  {"name":"   "} -> 200, and the page's name is now ''
 *   PUT /api/pages/N  {"html":"   "} -> 200, and the page's content is now ''
 *
 * That is why the update names carry this rule too, even though upstream would accept
 * them: whitespace is never what a caller means by a name, and the outcome upstream is
 * silent destruction of the entity's name rather than an error. It is the same category
 * as the self-heir check in userDelete - knowably wrong before the call is made.
 *
 * PRECISION, AND THE ONE PLACE THIS IS STRICTER THAN UPSTREAM. PHP's `trim()` strips
 * " \t\n\r\0\x0B"; JavaScript's `\S` and `String.trim()` also treat Unicode whitespace as
 * blank. Checked against the live container: `trim("\xc2\xa0") === ""` is FALSE in PHP,
 * while `/\S/u.test(" ")` is false in JS. So a name of a single U+00A0 is accepted by
 * BookStack (stored as an invisible name) and rejected here. That gap is deliberate: it
 * errs toward telling the caller, and an invisible name is not a name.
 *
 * Used as a JSON Schema `pattern` on the published side and compiled into the same regex
 * for zod on the runtime side, so the two cannot drift. Neither side TRIMS: the value
 * BookStack is sent is the value the caller wrote.
 */
export const NONBLANK_PATTERN = '\\S';

/**
 * "Holds at least `min` characters once BookStack has trimmed it" - the same rule as
 * NONBLANK_PATTERN, for the fields whose minimum is more than one.
 *
 * WHY THIS EXISTS. `minLength: 3` / `.min(3)` count RAW characters, and BookStack does not:
 * the global TrimStrings middleware rewrites the JSON body before the validator sees it, so
 * `min:3` is applied to the trimmed value. R5-W4 found the gap that leaves. Verified live
 * against v26.05.2 (role `display_name` is the only field in this API with a minimum above
 * one, and it has one on both create and update):
 *
 *   POST /api/roles    {"display_name":"   a"}   -> 422 "The display name must be at
 *                                                        least 3 characters."
 *   POST /api/roles    {"display_name":"  ab  "} -> 422 (the same message; 6 raw
 *                                                        characters, 2 after trimming)
 *   PUT  /api/roles/2  {"display_name":"   a"}   -> 422 (the same message, and the role's
 *                                                        name was unchanged afterwards)
 *
 * Both halves used to accept all three, because both counted the padding. The published
 * schema said `minLength: 3` and the test suite recorded the disagreement as a known limit
 * of JSON Schema - which it is not:
 *
 *     trimmed length >= n  <=>  two non-whitespace characters exist at least n-1 apart
 *
 * and that is a plain regular expression: `\S` `[\s\S]{n-2,}` `\S`, unanchored, exactly as
 * JSON Schema's `pattern` is evaluated. `[\s\S]` rather than `.` because a name may hold a
 * newline. The first and last non-whitespace characters of a value ARE its trimmed ends, so
 * a match proves the trimmed length and a failure disproves it - no approximation either
 * way. NONBLANK_PATTERN is the n=1 case of the same family, hence the shared return.
 *
 * NEITHER SIDE TRIMS, for the reason given above: the value BookStack is sent is the value
 * the caller wrote. This only judges it.
 *
 * WHERE THIS IS STRICTER THAN UPSTREAM, deliberately and in one direction only: the MAXIMUM
 * stays a raw `maxLength`, so `"  " + 180 characters` is refused here and would have been
 * accepted (and trimmed) upstream. Refusing to send a value that is 182 characters long
 * when the field takes 180 tells the caller something true; the reverse - accepting a value
 * upstream will reject - is what this function exists to stop.
 */
export function trimmedMinLengthPattern(min: number): string {
  if (min <= 1) {
    return NONBLANK_PATTERN;
  }
  return `\\S[\\s\\S]{${min - 2},}\\S`;
}

/**
 * BookStack's `alpha_dash` for a user's `language`, as a JSON Schema `pattern`.
 *
 * Upstream is `['string', 'max:15', 'alpha_dash']` (UserApiController::rules()). This was
 * described in prose only, so a schema-driven client had no machine-readable way to know
 * that `fr FR` is invalid - it published neither a pattern nor a length floor while the
 * runtime rejected both malformed and empty values. Verified live on v26.05.2:
 *
 *   POST /api/users {"language":"fr FR"} -> 422 "may only contain letters, numbers,
 *                                              dashes and underscores"
 *   POST /api/users {"language":"pt_BR"} -> 200
 *
 * TWO PLACES THIS IS NARROWER THAN UPSTREAM, both deliberate:
 *
 *  1. Blank. `language: '   '` is ACCEPTED live (200, and the setting is left alone):
 *     TrimStrings turns it into '', and Laravel then skips every non-implicit rule on it,
 *     `alpha_dash` included - so upstream neither applies it nor complains. A caller who
 *     sends a blank language means something by it and gets silence; this server answers
 *     instead. (The `language` note in src/validation/validator.ts previously claimed both
 *     rules 422 "when broken", which is true of a malformed value and NOT of a blank one.)
 *  2. ASCII. Laravel's default `alpha_dash` is the Unicode class `/\A[\pL\pM\pN_-]+\z/u`,
 *     so BookStack would also take `frü`. Language codes are ASCII.
 *
 * The anchors make this pattern imply non-blankness by itself, so it needs no `\S`.
 */
export const LANGUAGE_PATTERN = '^[A-Za-z0-9_-]+$';

/**
 * Close an input schema: every object within it forbids unknown properties.
 *
 * This exists because the advertised schema and the zod schema that enforces it have to
 * agree, and `additionalProperties` hand-written across ~90 nested objects is precisely
 * the kind of parallel list that drifts. Applying it where the tools are assembled makes
 * "closed" a property of the registry, so a tool added later cannot forget it.
 *
 * Only `properties` and `items` are descended. A `oneOf`/`allOf`/`anyOf`/`not` branch
 * constrains a value whose full property set is described by a sibling schema, so closing
 * a branch would reject the very keys it exists to reason about.
 */
function closeSchema<T extends MCPSchemaNode>(schema: T): T {
  const closed: MCPSchemaNode = { ...schema };

  if (closed.properties) {
    const properties: Record<string, MCPSchemaNode> = {};
    for (const [key, value] of Object.entries(closed.properties)) {
      properties[key] = closeSchema(value);
    }
    closed.properties = properties;
    closed.additionalProperties = false;
  }

  if (closed.items) {
    closed.items = closeSchema(closed.items);
  }

  return closed as T;
}

/**
 * Advertise every one of these tools with a closed input schema.
 *
 * Call this on the array a tool class returns from `getTools()`, so the contract the
 * server publishes matches the one `ValidationHandler` actually enforces: strict zod
 * objects reject an unknown key, and now the JSON Schema says so too.
 */
export function withClosedSchemas(tools: MCPTool[]): MCPTool[] {
  return tools.map((tool) => ({ ...tool, inputSchema: closeSchema(tool.inputSchema) }));
}

// Enhanced Tool Definition Types
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPInputSchema;
  handler: (params: unknown) => Promise<unknown>;
  // Enhanced self-description fields
  category?: string;
  examples?: ToolExample[];
  usage_patterns?: string[];
  related_tools?: string[];
  error_codes?: ToolErrorCode[];
}

export interface ToolExample {
  description: string;
  input: Record<string, unknown>;
  expected_output?: string;
  use_case: string;
}

export interface ToolErrorCode {
  code: string;
  description: string;
  recovery_suggestion: string;
}

// Enhanced Resource Definition Types
export interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler: (uri: string) => Promise<unknown>;
  // Enhanced self-description fields
  schema?: Record<string, unknown>;
  examples?: ResourceExample[];
  access_patterns?: string[];
  dependencies?: string[];
}

export interface ResourceExample {
  uri: string;
  description: string;
  expected_format: string;
  use_case: string;
}

// Export format types
export type ExportFormat = 'html' | 'pdf' | 'plaintext' | 'markdown';

/**
 * The result of an export.
 *
 * BookStack serves every export format as `application/octet-stream`, including
 * genuinely binary ones. `content` therefore carries two different kinds of
 * payload, and `encoding` is what tells them apart:
 *
 *  - `utf8`   - `content` is the text itself (html, plaintext, markdown).
 *  - `base64` - `content` is the base64 encoding of binary bytes (pdf).
 *               Text-decoding those bytes would corrupt them irrecoverably.
 *
 * `content.length` is a count of *characters*, which for base64 is neither the
 * byte count nor even proportional to it in a useful way. `byte_length` is the
 * real size of the exported file and is the value to report or check against.
 */
export interface ExportResult {
  content: string;
  encoding: 'utf8' | 'base64';
  byte_length: number;
  filename: string;
  mime_type: string;
}

// Content type union
export type ContentType = 'bookshelf' | 'book' | 'chapter' | 'page';

// BookStack API client interface
export interface BookStackAPIClient {
  // Books
  listBooks(params?: BooksListParams): Promise<ListResponse<Book>>;
  createBook(params: CreateBookParams): Promise<Book>;
  getBook(id: number): Promise<BookWithContents>;
  updateBook(id: number, params: UpdateBookParams): Promise<Book>;
  deleteBook(id: number): Promise<void>;
  exportBook(id: number, format: ExportFormat): Promise<ExportResult>;

  // Pages
  listPages(params?: PagesListParams): Promise<ListResponse<Page>>;
  createPage(params: CreatePageParams): Promise<Page>;
  getPage(id: number): Promise<PageWithContent>;
  updatePage(id: number, params: UpdatePageParams): Promise<Page>;
  deletePage(id: number): Promise<void>;
  exportPage(id: number, format: ExportFormat): Promise<ExportResult>;

  // Chapters
  listChapters(params?: ChaptersListParams): Promise<ListResponse<Chapter>>;
  createChapter(params: CreateChapterParams): Promise<Chapter>;
  getChapter(id: number): Promise<ChapterWithPages>;
  updateChapter(id: number, params: UpdateChapterParams): Promise<Chapter>;
  deleteChapter(id: number): Promise<void>;
  exportChapter(id: number, format: ExportFormat): Promise<ExportResult>;

  // Shelves
  listShelves(params?: ShelvesListParams): Promise<ListResponse<Bookshelf>>;
  createShelf(params: CreateShelfParams): Promise<Bookshelf>;
  getShelf(id: number): Promise<BookshelfWithBooks>;
  updateShelf(id: number, params: UpdateShelfParams): Promise<Bookshelf>;
  deleteShelf(id: number): Promise<void>;

  // Users
  listUsers(params?: UsersListParams): Promise<ListResponse<UserListItem>>;
  createUser(params: CreateUserParams): Promise<UserWithRoles>;
  getUser(id: number): Promise<UserWithRoles>;
  updateUser(id: number, params: UpdateUserParams): Promise<UserWithRoles>;
  /**
   * `migrateOwnershipId` is genuine here, unlike on `deleteRole`: BookStack's
   * `UserApiController::delete()` reads `migrate_ownership_id` off the request body and
   * hands it to `UserRepo::destroy()`.
   */
  deleteUser(id: number, migrateOwnershipId?: number): Promise<void>;

  // Roles
  listRoles(params?: RolesListParams): Promise<ListResponse<RoleListItem>>;
  createRole(params: CreateRoleParams): Promise<RoleCreateResult>;
  getRole(id: number): Promise<RoleWithPermissions>;
  updateRole(id: number, params: UpdateRoleParams): Promise<RoleWithPermissions>;
  /**
   * Takes an id and nothing else. `RoleApiController::delete(string $id)` accepts no
   * Request at all, so there is no body for a migration target to travel in - a role
   * delete simply strips the role from its users.
   */
  deleteRole(id: number): Promise<void>;

  // Attachments
  listAttachments(params?: AttachmentsListParams): Promise<ListResponse<Attachment>>;
  createAttachment(params: CreateAttachmentParams): Promise<Attachment>;
  getAttachment(id: number): Promise<AttachmentDetail>;
  updateAttachment(id: number, params: UpdateAttachmentParams): Promise<Attachment>;
  deleteAttachment(id: number): Promise<void>;

  // Images
  listImages(params?: ImageGalleryListParams): Promise<ListResponse<Image>>;
  createImage(params: CreateImageParams): Promise<ImageDetail>;
  getImage(id: number): Promise<ImageDetail>;
  updateImage(id: number, params: UpdateImageParams): Promise<ImageDetail>;
  deleteImage(id: number): Promise<void>;

  // Search
  search(params: SearchParams): Promise<ListResponse<SearchResult>>;

  // Recycle Bin
  listRecycleBin(params?: PaginationParams): Promise<ListResponse<RecycleBinItem>>;
  restoreFromRecycleBin(deletionId: number): Promise<RecycleBinRestoreResult>;
  permanentlyDelete(deletionId: number): Promise<RecycleBinDeleteResult>;

  // Content Permissions
  getContentPermissions(contentType: ContentType, contentId: number): Promise<ContentPermissions>;
  updateContentPermissions(
    contentType: ContentType,
    contentId: number,
    params: UpdateContentPermissionsParams
  ): Promise<ContentPermissions>;

  // Audit Log
  listAuditLog(params?: AuditLogListParams): Promise<ListResponse<AuditLogEntry>>;

  // System
  getSystemInfo(): Promise<SystemInfo>;
}
// Server Information Types for MCP Self-Description
export interface MCPServerInfo {
  name: string;
  version: string;
  description: string;
  capabilities: MCPServerCapabilities;
  tool_categories: ToolCategory[];
  resource_types: ResourceType[];
  usage_examples: ServerUsageExample[];
  /**
   * The BookStack versions this server's behaviour has been verified against by actually
   * exercising it - not a compatibility range, and not a claim about versions nobody has
   * run. Ask `bookstack_system_info` what the connected instance runs.
   */
  supported_bookstack_versions: string[];
  api_documentation: string;
  error_handling: ErrorHandlingInfo;
}

export interface MCPServerCapabilities {
  tools: {
    total: number;
    categories: string[];
    supports_batch_operations: boolean;
    supports_transactions: boolean;
  };
  resources: {
    total: number;
    types: string[];
    supports_streaming: boolean;
    supports_caching: boolean;
  };
  authentication: {
    required: boolean;
    methods: string[];
  };
  rate_limiting: {
    enabled: boolean;
    requests_per_minute?: number;
    burst_limit?: number;
  };
  validation: {
    enabled: boolean;
    strict_mode: boolean;
  };
}

export interface ToolCategory {
  name: string;
  description: string;
  tools: string[];
  use_cases: string[];
}

export interface ResourceType {
  type: string;
  description: string;
  mime_types: string[];
  uri_patterns: string[];
  examples: string[];
}

export interface ServerUsageExample {
  /**
   * Stable identifier for the workflow, matching the `workflow` enum advertised
   * by `bookstack_usage_examples`. Lookup keys off this rather than the prose
   * title, which is free to change.
   */
  key: string;
  title: string;
  description: string;
  workflow: WorkflowStep[];
  expected_outcome: string;
}

export interface WorkflowStep {
  step: number;
  action: string;
  tool_or_resource: string;
  parameters?: Record<string, unknown>;
  description: string;
}

export interface ErrorHandlingInfo {
  common_errors: CommonError[];
  debugging_tips: string[];
  support_contact: string;
}

export interface CommonError {
  code: string;
  message: string;
  causes: string[];
  solutions: string[];
  prevention: string;
}

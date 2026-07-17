# BookStack MCP Server Tools Overview

## All 56 Tools Across 13 Categories

This document provides an overview of every tool implemented in the BookStack MCP server, its capabilities, usage patterns, and implementation details.

## Executive Summary

The BookStack MCP Server provides **56 tools** (and **11 resources**) organized into **13 categories**, implementing the supported subset of the BookStack knowledge management API. Each tool follows consistent patterns for validation, error handling, and logging.

The categories below are the ones returned by `bookstack_tool_categories`, and the
per-category counts add up to the 56 tools the server registers at boot (it logs
`Registered 56 tools` / `Registered 11 resources` on startup):

| Section | Category | Tools |
|---------|----------|-------|
| 1 | `books` | 6 |
| 2 | `pages` | 6 |
| 3 | `chapters` | 6 |
| 4 | `shelves` | 5 |
| 5 | `users` | 5 |
| 6 | `roles` | 5 |
| 7 | `attachments` | 5 |
| 8 | `images` | 5 |
| 9 | `search` | 1 |
| 10 | `recyclebin` | 3 |
| 11 | `permissions` | 2 |
| 12 | `system` | 2 |
| 13 | `meta` | 5 |
| | **Total** | **56** |

## Tool Categories Overview

### 1. Books Management (6 tools)
**Category**: `books`  
**Purpose**: Manage books - the top-level containers for documentation

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_books_list` | List all books with pagination and filtering | count, offset, sort, filter |
| `bookstack_books_create` | Create new book with metadata | name (required), description, tags, default_template_id |
| `bookstack_books_read` | Get complete book details including hierarchy | id (required) |
| `bookstack_books_update` | Update book details and settings | id (required), name, description, tags, default_template_id |
| `bookstack_books_delete` | Delete book (moves to recycle bin) | id (required) |
| `bookstack_books_export` | Export book in various formats | id (required), format (html/pdf/plaintext/markdown) |

**Usage Patterns**:
- Call `list` first to understand available documentation structure
- Use filtering to find specific topic areas
- Combine with pagination for large book collections

### 2. Pages Management (6 tools)
**Category**: `pages`  
**Purpose**: Manage individual pages - the core content units

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_pages_list` | List pages with filtering by book/chapter | count, offset, sort, filter (book_id, chapter_id, draft, template) |
| `bookstack_pages_create` | Create new page with HTML or Markdown content | name (required), book_id/chapter_id, html/markdown, tags, priority |
| `bookstack_pages_read` | Get page details with full content | id (required) |
| `bookstack_pages_update` | Update page content and move between containers | id (required), name, html/markdown, book_id, chapter_id, tags, priority |
| `bookstack_pages_delete` | Delete page (moves to recycle bin) | id (required) |
| `bookstack_pages_export` | Export page in various formats | id (required), format (html/pdf/plaintext/markdown) |

**Content Support**:
- HTML and Markdown formats
- Page hierarchy and ordering
- Draft and template pages
- Content migration between books/chapters

### 3. Chapters Management (6 tools)
**Category**: `chapters`  
**Purpose**: Organize pages within books

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_chapters_list` | List chapters with book filtering | count, offset, sort, filter (book_id, name, created_by) |
| `bookstack_chapters_create` | Create new chapter within a book | book_id (required), name (required), description, tags, priority |
| `bookstack_chapters_read` | Get chapter details including all pages | id (required) |
| `bookstack_chapters_update` | Update chapter details and move between books | id (required), name, description, book_id, tags, priority |
| `bookstack_chapters_delete` | Delete chapter and all pages | id (required) |
| `bookstack_chapters_export` | Export chapter with all pages | id (required), format (html/pdf/plaintext/markdown) |

**Organizational Features**:
- Priority-based ordering within books
- Rich description support (HTML and plain text)
- Tag-based categorization
- Complete page inclusion in operations

### 4. Shelves Management (5 tools)
**Category**: `shelves`  
**Purpose**: Organize multiple books into collections

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_shelves_list` | List bookshelves with filtering | count, offset, sort, filter (name, created_by) |
| `bookstack_shelves_create` | Create new bookshelf with books | name (required), description, tags, books (array of book IDs) |
| `bookstack_shelves_read` | Get shelf details with all books | id (required) |
| `bookstack_shelves_update` | Update shelf and modify book collection | id (required), name, description, tags, books (replaces existing) |
| `bookstack_shelves_delete` | Delete shelf (books remain) | id (required) |

**Collection Management**:
- Book organization by category/department
- Non-destructive deletion (books preserved)
- Bulk book assignment and management

### 5. User Management (5 tools)
**Category**: `users`  
**Purpose**: Manage user accounts and profiles

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_users_list` | List system users with filtering | count, offset, sort, filter (name, email, active) |
| `bookstack_users_create` | Create new user account | name (required), email (required), password, roles, send_invite, external_auth_id |
| `bookstack_users_read` | Get user details including roles | id (required) |
| `bookstack_users_update` | Update user details and role assignments | id (required), name, email, password, roles, active, external_auth_id |
| `bookstack_users_delete` | Delete user with content migration option | id (required), migrate_ownership_id |

**Access Control Features**:
- Role-based permission system
- External authentication support (LDAP/SAML)
- Content ownership migration
- Account activation/deactivation

### 6. Role Management (5 tools)
**Category**: `roles`  
**Purpose**: Manage roles and permissions

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_roles_list` | List system roles with filtering | count, offset, sort, filter (display_name, system_name) |
| `bookstack_roles_create` | Create new role with permissions | display_name (required), description, mfa_enforced, permissions |
| `bookstack_roles_read` | Get role details with all permissions | id (required) |
| `bookstack_roles_update` | Update role permissions and settings | id (required), display_name, description, mfa_enforced, permissions |
| `bookstack_roles_delete` | Delete role with user migration | id (required), migrate_ownership_id |

**Permission System**:
- Granular permission control (content-export, settings-manage, users-manage, etc.)
- Multi-factor authentication enforcement
- External authentication integration
- Role migration capabilities

### 7. Attachment Management (5 tools)
**Category**: `attachments`  
**Purpose**: Manage file attachments to pages

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_attachments_list` | List attachments with filtering | count, offset, sort, filter (uploaded_to, name, extension) |
| `bookstack_attachments_create` | Upload file or link to external URL | uploaded_to (required), name (required), file/link |
| `bookstack_attachments_read` | Get attachment details and download URL | id (required) |
| `bookstack_attachments_update` | Update attachment or replace file | id (required), name, file, link, uploaded_to |
| `bookstack_attachments_delete` | Permanently delete attachment | id (required) |

**File Management Features**:
- Base64 file upload support
- External URL linking
- File type filtering
- Page-specific attachment organization

### 8. Image Management (5 tools)
**Category**: `images`  
**Purpose**: Manage images in the gallery

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_images_list` | List gallery images with filtering | count, offset, sort, filter (name, type, uploaded_to) |
| `bookstack_images_create` | Upload image to gallery | name (required), image (required base64), type, uploaded_to |
| `bookstack_images_read` | Get image details and URLs | id (required) |
| `bookstack_images_update` | Update image details or replace content | id (required), name, image, uploaded_to |
| `bookstack_images_delete` | Permanently delete image | id (required) |

**Image Types**:
- Gallery images (regular uploads)
- DrawIO diagrams
- Base64 encoding support
- Page association tracking

### 9. Search Functionality (1 tool)
**Category**: `search`  
**Purpose**: Search across all content types

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_search` | Search across shelves, books, chapters and pages | query (required), page (default 1), count (1-100, default 20) |

**Search syntax** (BookStack's own; verified against v26.05.2):

| Form | Meaning |
|------|---------|
| `bare terms` | Match names and content |
| `"exact phrase"` | Requires those words together |
| `{type:page}` | Restrict content type; combine with `\|`, e.g. `{type:page\|chapter}` |
| `[tag]` / `[tag=value]` | Match a tag, or a tag with a value |
| `{created_by:me}` | Also `updated_by` / `owned_by`; takes `me` or a username slug |
| `{in_name:text}` / `{in_body:text}` | Field-specific matching |
| `-"phrase"`, `-[tag]`, `-{filter}` | Negation. A **bare term cannot be negated** |

> ⚠️ Two easy mistakes, both of which **silently match everything** instead of erroring:
> - Entity type is `{type:page}`, not `[page]` — `[page]` is tag syntax and looks for a
>   tag *named* "page".
> - Tags are `[name=value]`, never `{tag:name=value}` — an unrecognised `{filter:...}`
>   term is discarded by BookStack rather than rejected.

**Search Features**:
- Page results carry only snippets, on `preview_html` — follow up with `bookstack_pages_read` for full content
- Each result carries a `type` of `bookshelf`, `book`, `chapter` or `page`
- Pagination via `page` (not `offset`); `count` caps at **100** here, unlike the 500 of the list tools

### 10. Recycle Bin Management (3 tools)
**Category**: `recyclebin`  
**Purpose**: Manage deleted items

> ⚠️ The tool names have **no underscore** between "recycle" and "bin":
> `bookstack_recyclebin_*`, not `bookstack_recycle_bin_*`.

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_recyclebin_list` | List deleted items | count (1-500, default 20), offset, sort |
| `bookstack_recyclebin_restore` | Restore deleted item to original location | id (required) |
| `bookstack_recyclebin_delete_permanently` | Permanently destroy an entry and its content | id (required) |

**The `id` is the deletion entry's id, not the deleted item's id.** Take it from
`bookstack_recyclebin_list`; the deleted book/page's own id is reported separately as
`deletable_id`. Passing the latter is the usual cause of a `NOT_FOUND`.

**Recovery Features**:
- Safe deletion with recovery option
- Top-level listing: deleting a book creates one entry, not one per page inside it
- Restore and purge cascade — `restore_count` / `delete_count` report how many items were affected
- Permanent deletion capability

### 11. Permission Management (2 tools)
**Category**: `permissions`  
**Purpose**: Control content access

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_permissions_read` | Get content permission settings | content_type (required), content_id (required) |
| `bookstack_permissions_update` | Update content permissions | content_type (required), content_id (required), permissions, fallback_permissions |

**Access Control**:
- Content-specific permissions (books, chapters, pages, shelves)
- User and role-based access grants
- Permission inheritance settings
- View, create, update, delete permissions

### 12. System & Audit Log (2 tools)
**Category**: `system`  
**Purpose**: Instance information and activity tracking

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_system_info` | Get BookStack instance information | none |
| `bookstack_audit_log_list` | List audit log entries | count (1-500, default 20), offset, sort, filter (type, user_id, loggable_type, loggable_id, date_from, date_to) |

> ⚠️ The audit filters are `type` / `loggable_type` / `loggable_id` — **not**
> `event` / `entity_type` / `entity_id`. Those three were removed because BookStack
> ignores them: an unrecognised filter is silently dropped, so a call using them
> returns a broad **unfiltered** log rather than an error.

**Audit filters** (all exact-match; there is no partial or wildcard matching):

| Filter | Type | Notes |
|--------|------|-------|
| `type` | string | The whole event name, e.g. `page_create`, `page_update`, `book_delete`. `"page"` matches nothing. |
| `user_id` | integer | The acting user. |
| `loggable_type` | string | The affected item's type. BookStack only records this for `page`, `book`, `chapter`, `bookshelf`; logins and role changes have it null and can never match. |
| `loggable_id` | integer | The affected item's id. Best combined with `loggable_type`, since ids are only unique within a type. |
| `date_from` | string | `2026-07-16` or `2026-07-16 09:20:00`. |
| `date_to` | string | As above; a bare date resolves to that day at 00:00:00. |

```javascript
// Who deleted pages this month
bookstack_audit_log_list({ filter: { type: "page_delete", date_from: "2026-07-01" } })

// Everything that happened to page 42
bookstack_audit_log_list({ filter: { loggable_type: "page", loggable_id: 42 } })
```

**Audit Features**:
- User action monitoring, most recent first (`-created_at` default)
- Date range queries
- Requires a token whose user can manage both users and system settings
- Purging an item from the recycle bin nulls `loggable_id`/`loggable_type` on its entries and moves the item's name into `detail` — so purged content is traceable only by `type` + `detail`

### 13. Meta / Self-Description (5 tools)
**Category**: `meta`  
**Purpose**: Ask the server about itself

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_server_info` | Get comprehensive MCP server information | section (all/capabilities/tools/resources/examples/errors) |
| `bookstack_tool_categories` | Get detailed tool category information | category |
| `bookstack_usage_examples` | Get workflow examples | workflow (create_documentation/organize_content/user_management/search_content/export_data) |
| `bookstack_error_guides` | Get error handling guidance | error_code (UNAUTHORIZED/NOT_FOUND/VALIDATION_ERROR) |
| `bookstack_help` | Interactive help system | topic, context |

**Meta Features**:
- Self-describing server capabilities
- Usage examples and workflows
- Error handling guidance
- Interactive help system
- Tool discovery and documentation

## Input/Output Schema Patterns

### Common Input Parameters

**Pagination Parameters** (used across list operations):
```typescript
{
  count: number (1-500, default: 20),
  offset: number (min: 0, default: 0),
  sort: string (varies by entity),
  filter: object (entity-specific filters)
}
```

> ⚠️ `count` above 500 is **rejected, not clamped**. With `VALIDATION_STRICT_MODE`
> (default `true`) the schema's upper bound fails the call at the boundary:
>
> ```json
> { "code": -32602, "message": "MCP error -32602: Validation failed",
>   "data": { "type": "validation_error",
>             "validation": [{ "field": "count", "message": "Too big: expected number to be <=500" }] } }
> ```
>
> This applies to the audit log and recycle bin listings too. `bookstack_search` is
> the exception in the other direction: its `count` caps at 100.

**Content Parameters** (used across content tools):
```typescript
{
  name: string (max: 255, required for creation),
  description: string (max: 1900, plain text),
  description_html: string (max: 2000, HTML format),
  tags: Array<{name: string, value: string}>
}
```

**File Upload Parameters**:
```typescript
{
  file: string (base64 encoded content),
  link: string (external URL, alternative to file)
}
```

### Common Output Patterns

**List Responses**:
```typescript
{
  data: Array<EntityObject>,
  total: number,
  from: number,
  to: number,
  per_page: number,
  current_page: number
}
```

**Entity Objects** include:
- Standard fields: id, name, created_at, updated_at, created_by, updated_by
- Entity-specific fields
- Related object references
- Permission information

## Error Handling Capabilities

### Standard Error Codes

1. **UNAUTHORIZED** (401)
   - Authentication failed or insufficient permissions
   - Recovery: Verify API token and permissions

2. **NOT_FOUND** (404)
   - Resource does not exist or no access
   - Recovery: Verify ID and check permissions

3. **VALIDATION_ERROR** (422)
   - Request parameters failed validation
   - Recovery: Check required fields and data formats

4. **RATE_LIMIT_EXCEEDED** (429)
   - Too many requests (if rate limiting enabled)
   - Recovery: Wait and retry with exponential backoff

### Error Response Format
```typescript
{
  error: {
    code: string,
    message: string,
    details?: object
  }
}
```

## Validation and Security

### Input Validation
- **Schema Validation**: All parameters validated against JSON schemas
- **Type Safety**: Strong typing throughout the application
- **Length Limits**: Enforced on all string inputs
- **Format Validation**: Email, URL, date formats validated

### Security Features
- **API Token Authentication**: Required for all operations
- **Permission Checking**: Role-based access control
- **Input Sanitization**: Protection against injection attacks
- **Rate Limiting**: Configurable request throttling
- **Audit Logging**: Complete action tracking

## Implementation Architecture

### Class Structure
Each tool category is implemented as a separate class:
- **BookTools**: Book management operations
- **PageTools**: Page content operations
- **ChapterTools**: Chapter organization
- **ShelfTools**: Collection management
- **UserTools**: User account management
- **RoleTools**: Permission management
- **AttachmentTools**: File attachment handling
- **ImageTools**: Image gallery management
- **SearchTools**: Content search
- **RecycleBinTools**: Deletion recovery
- **PermissionTools**: Access control
- **AuditTools**: Activity tracking
- **SystemTools**: System information
- **ServerInfoTools**: MCP server metadata

### Common Dependencies
All tool classes share:
- **BookStackClient**: API communication layer
- **ValidationHandler**: Input validation and sanitization
- **Logger**: Structured logging and debugging

### Handler Pattern
Each tool follows the same pattern:
```typescript
{
  name: string,
  description: string,
  category?: string,
  inputSchema: JSONSchema,
  examples?: Array<ToolExample>,
  usage_patterns?: Array<string>,
  related_tools?: Array<string>,
  error_codes?: Array<ErrorCode>,
  handler: async (params: any) => any
}
```

## Usage Examples and Workflows

### Creating Complete Documentation
1. Create book with `bookstack_books_create`
2. Add chapters with `bookstack_chapters_create`
3. Create pages with `bookstack_pages_create`
4. Set permissions with `bookstack_permissions_update`
5. Organize in shelf with `bookstack_shelves_create`

### Content Discovery and Updates
1. Search content with `bookstack_search`
2. Read current content with appropriate read tool
3. Update with new information using update tool
4. Verify changes with read operation

### User and Permission Management
1. List users with `bookstack_users_list`
2. Create roles with `bookstack_roles_create`
3. Assign permissions with role tools
4. Update user roles with `bookstack_users_update`

## Best Practices

### Performance Optimization
- Use pagination for large datasets
- Filter results at the API level with a list tool's `filter`, rather than fetching everything and filtering locally
- **There is no batch tool and no batching layer** (`supports_batch_operations: false`): every tool acts on a single item, so prefer one filtered list call over many individual reads
- **The server caches nothing** (`supports_caching: false`): every call goes through to BookStack, so avoid polling loops — outbound requests are rate-limited
- Prefer `markdown`/`plaintext` exports for LLM context; `html` and `pdf` cost far more tokens

### Error Handling
- Always validate inputs before API calls
- Implement retry logic for transient failures
- Check permissions before write operations
- Use audit logs for debugging access issues

### Content Organization
- Follow hierarchy: Shelves > Books > Chapters > Pages
- Use meaningful names and descriptions
- Apply consistent tagging strategy
- Set appropriate permissions at each level

### Security Considerations
- Rotate API tokens regularly
- Use least-privilege principle for roles
- Monitor audit logs for suspicious activity
- Validate all user inputs

## API Coverage

The BookStack MCP Server covers a **subset** of the BookStack REST API — the families
below. It is not a complete mapping of every endpoint.

**Covered:**

- ✅ **Content Management**: CRUD for books, chapters, pages and shelves
- ✅ **User Management**: User and role administration
- ✅ **Permission System**: Content-level permission overrides
- ✅ **File Management**: Attachments and image gallery
- ✅ **Search**: `GET /api/search`
- ✅ **Export**: `html`, `pdf`, `plaintext`, `markdown`
- ✅ **Audit**: `GET /api/audit-log`
- ✅ **System**: `GET /api/system`
- ✅ **Recycle bin**: list, restore, purge

**Not exposed** (present in the BookStack API, no tool here — checked against
v26.05.2 `docs.json`):

- ❌ **Comments** — `/api/comments` (list, create, read, update, delete)
- ❌ **Imports** — `/api/imports` (list, create, read, run, delete)
- ❌ **Tags** — `/api/tags/names`, `/api/tags/values-for-name`
- ❌ **Image data** — `/api/image-gallery/{id}/data`, `/api/image-gallery/url/data`
- ❌ **ZIP export** — `/export/zip` on books, chapters and pages

If you need one of these, call the BookStack API directly.

## Extensibility

The modular architecture allows for easy extension:
- New tool categories can be added by implementing the MCPTool interface
- Custom validation rules can be added to the ValidationHandler
- Additional authentication methods can be integrated
- New export formats can be supported

## Conclusion

The BookStack MCP Server is a production-ready implementation providing LLMs with access to the supported subset of BookStack's API. With 56 tools across 13 categories, 11 resources, robust error handling, strict validation, and extensive documentation, it enables sophisticated knowledge management workflows while maintaining security and reliability.

The consistent patterns, extensive examples, and self-documenting capabilities make it easy for LLMs to understand and effectively utilize the full power of the BookStack platform through the MCP protocol.
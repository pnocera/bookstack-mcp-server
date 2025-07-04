# BookStack MCP Server API Reference

## Table of Contents

1. [Overview](#overview)
2. [Authentication & Configuration](#authentication--configuration)
3. [Rate Limiting & Error Handling](#rate-limiting--error-handling)
4. [API Endpoints](#api-endpoints)
   - [Books](#books-api)
   - [Pages](#pages-api)
   - [Chapters](#chapters-api)
   - [Bookshelves](#bookshelves-api)
   - [Users](#users-api)
   - [Roles](#roles-api)
   - [Attachments](#attachments-api)
   - [Images](#images-api)
   - [Search](#search-api)
   - [Recycle Bin](#recycle-bin-api)
   - [Permissions](#permissions-api)
   - [Audit Log](#audit-log-api)
   - [System](#system-api)
5. [TypeScript Interfaces](#typescript-interfaces)
6. [Error Codes](#error-codes)
7. [Examples](#examples)

## Overview

The BookStack MCP Server provides comprehensive access to the BookStack knowledge management system through the Model Context Protocol (MCP). This API wrapper enables seamless integration with Claude and other LLMs for documentation management tasks.

### Key Features

- **Complete API Coverage**: 73 tools across 14 endpoint categories
- **Type Safety**: Full TypeScript interfaces for all operations
- **Robust Error Handling**: Comprehensive error mapping and recovery guidance
- **Rate Limiting**: Token bucket algorithm with configurable limits
- **Validation**: Zod-based parameter validation with strict mode support
- **Retry Logic**: Automatic retry with exponential backoff
- **Batch Operations**: Support for efficient bulk operations
- **Export Capabilities**: Multi-format export (HTML, PDF, Markdown, Plain Text)

### Architecture

```
BookStack Instance → API Token → MCP Server → Claude/LLM
```

## Authentication & Configuration

### Environment Variables

```bash
# Required
BOOKSTACK_BASE_URL=https://your-bookstack.com/api
BOOKSTACK_API_TOKEN=your_api_token_here

# Optional - Server Configuration
SERVER_NAME=bookstack-mcp-server
SERVER_VERSION=1.0.0
SERVER_PORT=3000

# Optional - Rate Limiting
RATE_LIMIT_REQUESTS_PER_MINUTE=60
RATE_LIMIT_BURST_LIMIT=10

# Optional - Validation
VALIDATION_ENABLED=true
VALIDATION_STRICT_MODE=false

# Optional - Logging
LOG_LEVEL=info
LOG_FORMAT=pretty

# Optional - Security
CORS_ENABLED=true
CORS_ORIGIN=*
HELMET_ENABLED=true
```

### API Token Requirements

Your BookStack API token must have appropriate permissions for the operations you want to perform:

- **Read Operations**: Requires view permissions on target content
- **Write Operations**: Requires create/update permissions
- **Delete Operations**: Requires delete permissions
- **User Management**: Requires admin-level permissions
- **System Operations**: Requires admin-level permissions

### Configuration Schema

The server uses Zod for configuration validation:

```typescript
interface Config {
  bookstack: {
    baseUrl: string;        // BookStack API base URL
    apiToken: string;       // API authentication token
    timeout: number;        // Request timeout (default: 30000ms)
  };
  server: {
    name: string;          // Server identifier
    version: string;       // Server version
    port: number;          // Server port (default: 3000)
  };
  rateLimit: {
    requestsPerMinute: number;  // Rate limit (default: 60)
    burstLimit: number;         // Burst capacity (default: 10)
  };
  validation: {
    enabled: boolean;      // Enable parameter validation
    strictMode: boolean;   // Strict validation mode
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    format: 'json' | 'pretty';
  };
}
```

## Rate Limiting & Error Handling

### Rate Limiting

The server implements a token bucket rate limiter:

- **Default Rate**: 60 requests per minute
- **Burst Capacity**: 10 requests
- **Algorithm**: Token bucket with linear refill
- **Behavior**: Automatic queuing when limits exceeded

### Error Handling

Comprehensive error mapping from HTTP status codes to MCP errors:

| HTTP Status | Error Type | Description | Recovery |
|-------------|------------|-------------|----------|
| 400 | `validation_error` | Invalid request parameters | Check parameter format and requirements |
| 401 | `authentication_error` | Invalid/missing token | Verify BOOKSTACK_API_TOKEN |
| 403 | `permission_error` | Insufficient permissions | Check user permissions in BookStack |
| 404 | `not_found_error` | Resource not found | Verify resource ID exists |
| 422 | `validation_error` | Validation failed | Check required fields and constraints |
| 429 | `rate_limit_error` | Rate limit exceeded | Wait and retry, or reduce request frequency |
| 500+ | `server_error` | Server-side error | Check BookStack server status |

### Retry Policy

Automatic retry with exponential backoff for transient errors:

- **Retryable Status Codes**: 429, 500, 502, 503, 504
- **Max Retries**: 3
- **Backoff Strategy**: Exponential (1s, 2s, 4s)
- **Timeout**: 30 seconds per request

## API Endpoints

### Books API

Books are the top-level containers in BookStack's hierarchy.

#### List Books
```typescript
// Tool: bookstack_books_list
interface BooksListParams {
  count?: number;           // Results per page (1-500, default: 20)
  offset?: number;          // Number to skip (default: 0)
  sort?: 'name' | 'created_at' | 'updated_at';  // Sort field
  filter?: {
    name?: string;          // Partial name match
    created_by?: number;    // Creator user ID
  };
}

interface ListResponse<Book> {
  data: Book[];
  total: number;
}
```

**Example Request:**
```json
{
  "count": 10,
  "filter": { "name": "API" },
  "sort": "updated_at"
}
```

**Example Response:**
```json
{
  "data": [
    {
      "id": 1,
      "name": "API Documentation",
      "slug": "api-documentation",
      "description": "Complete API reference guide",
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-20T15:45:00Z",
      "created_by": 1,
      "updated_by": 1,
      "owned_by": 1,
      "tags": [
        { "name": "category", "value": "documentation", "order": 0 }
      ]
    }
  ],
  "total": 1
}
```

#### Create Book
```typescript
// Tool: bookstack_books_create
interface CreateBookParams {
  name: string;                    // Required, max 255 chars
  description?: string;            // Optional, max 1900 chars
  description_html?: string;       // Optional, max 2000 chars
  tags?: Tag[];                   // Optional tag array
  default_template_id?: number;   // Optional template ID
}

interface Tag {
  name: string;
  value: string;
}
```

#### Read Book
```typescript
// Tool: bookstack_books_read
interface BookWithContents extends Book {
  contents: (Chapter | Page)[];  // Complete hierarchy
}
```

#### Update Book
```typescript
// Tool: bookstack_books_update
// Same as CreateBookParams but all fields optional except id
```

#### Delete Book
```typescript
// Tool: bookstack_books_delete
// Moves book to recycle bin for potential restoration
```

#### Export Book
```typescript
// Tool: bookstack_books_export
interface ExportParams {
  id: number;
  format: 'html' | 'pdf' | 'plaintext' | 'markdown';
}

interface ExportResult {
  content: string;    // Base64 encoded for binary formats
  filename: string;   // Suggested filename
  mime_type: string;  // MIME type for the content
}
```

### Pages API

Pages contain the actual content within books or chapters.

#### List Pages
```typescript
// Tool: bookstack_pages_list
interface PagesListParams extends PaginationParams {
  filter?: {
    book_id?: number;      // Filter by parent book
    chapter_id?: number;   // Filter by parent chapter
    name?: string;         // Partial name match
    draft?: boolean;       // Filter by draft status
    template?: boolean;    // Filter by template status
  };
}
```

#### Create Page
```typescript
// Tool: bookstack_pages_create
interface CreatePageParams {
  book_id?: number;      // Required if chapter_id not provided
  chapter_id?: number;   // Required if book_id not provided
  name: string;          // Required, max 255 chars
  html?: string;         // HTML content (required if markdown not provided)
  markdown?: string;     // Markdown content (required if html not provided)
  tags?: Tag[];         // Optional tags
  priority?: number;    // Optional priority for ordering
}
```

#### Read Page
```typescript
// Tool: bookstack_pages_read
interface PageWithContent extends Page {
  html: string;          // Rendered HTML content
  raw_html: string;      // Raw HTML as stored
  markdown?: string;     // Markdown source if available
}
```

#### Update Page
```typescript
// Tool: bookstack_pages_update
// Same as CreatePageParams but all fields optional except id
// Can move pages between books/chapters by changing book_id/chapter_id
```

#### Delete Page
```typescript
// Tool: bookstack_pages_delete
// Moves page to recycle bin
```

#### Export Page
```typescript
// Tool: bookstack_pages_export
// Same format options as books
```

### Chapters API

Chapters organize pages within books.

#### List Chapters
```typescript
// Tool: bookstack_chapters_list
interface ChaptersListParams extends PaginationParams {
  filter?: {
    book_id?: number;      // Filter by parent book
    name?: string;         // Partial name match
    created_by?: number;   // Creator user ID
  };
}
```

#### Create Chapter
```typescript
// Tool: bookstack_chapters_create
interface CreateChapterParams {
  book_id: number;           // Required parent book
  name: string;              // Required, max 255 chars
  description?: string;      // Optional, max 1900 chars
  description_html?: string; // Optional, max 2000 chars
  tags?: Tag[];             // Optional tags
  priority?: number;        // Optional priority for ordering
}
```

#### Read Chapter
```typescript
// Tool: bookstack_chapters_read
interface ChapterWithPages extends Chapter {
  pages: Page[];  // All pages within the chapter
}
```

#### Update Chapter
```typescript
// Tool: bookstack_chapters_update
// Same as CreateChapterParams but all fields optional except id
// Can move chapters between books with book_id
```

#### Delete Chapter
```typescript
// Tool: bookstack_chapters_delete
// Deletes chapter and all contained pages
```

#### Export Chapter
```typescript
// Tool: bookstack_chapters_export
// Exports chapter and all contained pages
```

### Bookshelves API

Bookshelves organize books into collections.

#### List Shelves
```typescript
// Tool: bookstack_shelves_list
interface ShelvesListParams extends PaginationParams {
  filter?: {
    name?: string;         // Partial name match
    created_by?: number;   // Creator user ID
  };
}
```

#### Create Shelf
```typescript
// Tool: bookstack_shelves_create
interface CreateShelfParams {
  name: string;              // Required, max 255 chars
  description?: string;      // Optional, max 1900 chars
  description_html?: string; // Optional, max 2000 chars
  tags?: Tag[];             // Optional tags
  books?: number[];         // Optional array of book IDs
}
```

#### Read Shelf
```typescript
// Tool: bookstack_shelves_read
interface BookshelfWithBooks extends Bookshelf {
  books: Book[];  // All books on the shelf
}
```

#### Update Shelf
```typescript
// Tool: bookstack_shelves_update
// Same as CreateShelfParams but all fields optional except id
// books array replaces all existing books on shelf
```

#### Delete Shelf
```typescript
// Tool: bookstack_shelves_delete
// Deletes shelf but books remain
```

### Users API

User management operations (requires admin permissions).

#### List Users
```typescript
// Tool: bookstack_users_list
interface UsersListParams extends PaginationParams {
  filter?: {
    name?: string;     // Partial name match
    email?: string;    // Partial email match
    active?: boolean;  // Filter by active status
  };
}
```

#### Create User
```typescript
// Tool: bookstack_users_create
interface CreateUserParams {
  name: string;               // Required, max 255 chars
  email: string;              // Required, must be unique
  password?: string;          // Optional, min 8 chars
  roles?: number[];           // Optional role IDs
  send_invite?: boolean;      // Send invitation email
  external_auth_id?: string;  // For LDAP/SAML users
}
```

#### Read User
```typescript
// Tool: bookstack_users_read
interface UserWithRoles extends User {
  roles: Role[];  // All assigned roles
}
```

#### Update User
```typescript
// Tool: bookstack_users_update
interface UpdateUserParams {
  name?: string;              // New display name
  email?: string;             // New email (must be unique)
  password?: string;          // New password
  roles?: number[];           // New role assignments (replaces existing)
  active?: boolean;           // Enable/disable user
  external_auth_id?: string;  // External auth ID
}
```

#### Delete User
```typescript
// Tool: bookstack_users_delete
interface DeleteUserParams {
  id: number;                      // User ID to delete
  migrate_ownership_id?: number;   // Optional user to transfer content to
}
```

### Roles API

Role management for permissions (requires admin permissions).

#### List Roles
```typescript
// Tool: bookstack_roles_list
interface RolesListParams extends PaginationParams {
  filter?: {
    display_name?: string;  // Partial display name match
    system_name?: string;   // Partial system name match
  };
  sort?: 'display_name' | 'system_name' | 'created_at' | 'updated_at';
}
```

#### Create Role
```typescript
// Tool: bookstack_roles_create
interface CreateRoleParams {
  display_name: string;        // Required, max 180 chars
  description?: string;        // Optional, max 1000 chars
  mfa_enforced?: boolean;      // Enforce MFA for this role
  external_auth_id?: string;   // For LDAP/SAML roles
  permissions?: {
    'content-export'?: boolean;
    'restrictions-manage-all'?: boolean;
    'restrictions-manage-own'?: boolean;
    'settings-manage'?: boolean;
    'user-roles-manage'?: boolean;
    'users-manage'?: boolean;
  };
}
```

#### Read Role
```typescript
// Tool: bookstack_roles_read
interface RoleWithPermissions extends Role {
  permissions: string[];  // All granted permissions
}
```

#### Update Role
```typescript
// Tool: bookstack_roles_update
// Same as CreateRoleParams but all fields optional except id
```

#### Delete Role
```typescript
// Tool: bookstack_roles_delete
interface DeleteRoleParams {
  id: number;                      // Role ID to delete
  migrate_ownership_id?: number;   // Optional role to migrate users to
}
```

### Attachments API

File attachments for pages.

#### List Attachments
```typescript
// Tool: bookstack_attachments_list
interface AttachmentsListParams extends PaginationParams {
  filter?: {
    name?: string;         // Partial name match
    uploaded_to?: number;  // Page ID filter
    extension?: string;    // File extension filter
  };
}
```

#### Create Attachment
```typescript
// Tool: bookstack_attachments_create
interface CreateAttachmentParams {
  uploaded_to: number;  // Required page ID
  name: string;         // Required, max 255 chars
  file?: string;        // Base64 encoded file content
  link?: string;        // External URL (alternative to file)
}
```

#### Read Attachment
```typescript
// Tool: bookstack_attachments_read
interface Attachment {
  id: number;
  name: string;
  extension: string;
  uploaded_to: number;  // Page ID
  external: boolean;    // True if link, false if file
  order: number;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number;
  links: {
    html: string;       // HTML embed code
    markdown: string;   // Markdown link
  };
}
```

#### Update Attachment
```typescript
// Tool: bookstack_attachments_update
interface UpdateAttachmentParams {
  uploaded_to?: number;  // Move to different page
  name?: string;         // New name
  file?: string;         // Replace file content
  link?: string;         // Replace link URL
}
```

#### Delete Attachment
```typescript
// Tool: bookstack_attachments_delete
// Permanently deletes attachment
```

### Images API

Image gallery management.

#### List Images
```typescript
// Tool: bookstack_images_list
interface ImageGalleryListParams extends PaginationParams {
  filter?: {
    name?: string;                    // Partial name match
    type?: 'gallery' | 'drawio';     // Image type filter
    uploaded_to?: number;            // Page association filter
  };
}
```

#### Create Image
```typescript
// Tool: bookstack_images_create
interface CreateImageParams {
  name: string;                     // Required, max 255 chars
  image: string;                    // Required, Base64 encoded image
  type?: 'gallery' | 'drawio';     // Image type (default: gallery)
  uploaded_to?: number;            // Optional page association
}
```

#### Read Image
```typescript
// Tool: bookstack_images_read
interface Image {
  id: number;
  name: string;
  url: string;         // Full URL to image
  type: string;        // Image type
  path: string;        // Server path
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number;
}
```

#### Update Image
```typescript
// Tool: bookstack_images_update
interface UpdateImageParams {
  name?: string;              // New name
  image?: string;             // Replace image content
  uploaded_to?: number;       // Change page association
}
```

#### Delete Image
```typescript
// Tool: bookstack_images_delete
// Permanently deletes image
```

### Search API

Universal search across all content types.

#### Search Content
```typescript
// Tool: bookstack_search
interface SearchParams {
  query: string;    // Required search query
  page?: number;    // Page number (default: 1)
  count?: number;   // Results per page (1-100, default: 20)
}

interface SearchResult {
  id: number;
  name: string;
  slug: string;
  type: 'bookshelf' | 'book' | 'chapter' | 'page';
  url: string;
  preview_html: {
    name: string;     // Highlighted name
    content: string;  // Content excerpt with highlights
  };
  tags: Tag[];
  book?: Book;        // Parent book (for chapters/pages)
  chapter?: Chapter;  // Parent chapter (for pages)
}
```

**Advanced Search Syntax:**
- `"exact phrase"` - Exact phrase matching
- `name:searchterm` - Field-specific search
- `[book]` - Entity type filters
- `tag:value` - Tag-based search
- Boolean operators: AND, OR, NOT

**Examples:**
```
"API documentation"           // Exact phrase
name:authentication          // Search in names only
[page] authentication        // Pages containing authentication
tag:category:api             // Content tagged as category:api
authentication AND security  // Boolean search
```

### Recycle Bin API

Manage deleted content restoration.

#### List Deleted Items
```typescript
// Tool: bookstack_recycle_bin_list
interface RecycleBinItem {
  id: number;             // Deletion ID
  deleted_at: string;     // Deletion timestamp
  deletable_type: string; // Original entity type
  deletable_id: number;   // Original entity ID
  deleted_by: number;     // User who deleted
  deletable: any;         // Original entity data
}
```

#### Restore Item
```typescript
// Tool: bookstack_recycle_bin_restore
// Restores item to original location
```

#### Permanently Delete
```typescript
// Tool: bookstack_recycle_bin_delete_permanently
// Cannot be undone
```

### Permissions API

Content permission management.

#### Read Permissions
```typescript
// Tool: bookstack_permissions_read
interface ContentPermissions {
  inheriting: boolean;  // Whether inheriting from parent
  permissions: {
    role_id: number;
    role_name: string;
    view: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
  }[];
}
```

#### Update Permissions
```typescript
// Tool: bookstack_permissions_update
interface UpdateContentPermissionsParams {
  fallback_permissions?: {
    inheriting?: boolean;
    restricted?: boolean;
  };
  permissions: {
    role_id?: number;      // Role to grant permissions to
    user_id?: number;      // User to grant permissions to (alternative)
    view?: boolean;
    create?: boolean;
    update?: boolean;
    delete?: boolean;
  }[];
}
```

### Audit Log API

System activity tracking.

#### List Audit Entries
```typescript
// Tool: bookstack_audit_log_list
interface AuditLogListParams extends PaginationParams {
  filter?: {
    event?: string;         // Event type filter
    user_id?: number;       // User filter
    entity_type?: string;   // Entity type filter
    entity_id?: number;     // Specific entity filter
    date_from?: string;     // Date range start (YYYY-MM-DD)
    date_to?: string;       // Date range end (YYYY-MM-DD)
  };
}

interface AuditLogEntry {
  id: number;
  type: string;           // Event type (e.g., 'page_create')
  detail: string;         // Event description
  user_id: number;        // User who performed action
  entity_type?: string;   // Affected entity type
  entity_id?: number;     // Affected entity ID
  ip: string;             // IP address
  created_at: string;     // Event timestamp
  user: User;             // User details
  entity?: any;           // Entity details if available
}
```

### System API

System information and health checks.

#### Get System Info
```typescript
// Tool: bookstack_system_info
interface SystemInfo {
  version: string;                  // BookStack version
  instance_id: string;             // Unique instance identifier
  php_version: string;             // PHP version
  theme: string;                   // Active theme
  language: string;                // Default language
  timezone: string;                // Server timezone
  app_url: string;                 // Application URL
  drawing_enabled: boolean;        // Drawing feature status
  registrations_enabled: boolean;  // Registration status
  upload_limit: number;            // File upload limit (bytes)
}
```

## TypeScript Interfaces

### Core Entity Types

```typescript
interface Book {
  id: number;
  name: string;
  slug: string;
  description?: string;
  description_html?: string;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number;
  owned_by: number;
  image_id?: number;
  default_template_id?: number;
  tags: Tag[];
  cover?: Image;
}

interface Page {
  id: number;
  book_id: number;
  chapter_id?: number;
  name: string;
  slug: string;
  priority: number;
  draft: boolean;
  template: boolean;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number;
  owned_by: number;
  revision_count: number;
  editor: string;
  tags: Tag[];
}

interface Chapter {
  id: number;
  book_id: number;
  name: string;
  slug: string;
  description?: string;
  description_html?: string;
  priority: number;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number;
  owned_by: number;
  tags: Tag[];
}

interface User {
  id: number;
  name: string;
  email: string;
  avatar_url?: string;
  external_auth_id?: string;
  slug: string;
  created_at: string;
  updated_at: string;
  last_activity_at?: string;
}

interface Role {
  id: number;
  display_name: string;
  description?: string;
  mfa_enforced: boolean;
  external_auth_id?: string;
  created_at: string;
  updated_at: string;
}

interface Tag {
  name: string;
  value: string;
  order: number;
}
```

### Response Types

```typescript
interface ListResponse<T> {
  data: T[];
  total: number;
}

interface ErrorResponse {
  error: {
    code: number;
    message: string;
    validation?: Record<string, string[]>;
  };
}
```

### Parameter Types

```typescript
interface PaginationParams {
  count?: number;     // Results per page
  offset?: number;    // Number to skip
  sort?: string;      // Sort field
}

interface FilterParams {
  name?: string;      // Name filter (partial match)
  created_by?: number;// Creator filter
  // ... other entity-specific filters
}
```

## Error Codes

### MCP Error Codes

| Code | Type | Description | HTTP Status |
|------|------|-------------|-------------|
| `InvalidRequest` | `validation_error` | Invalid parameters | 400 |
| `InvalidParams` | `validation_error` | Parameter validation failed | 400, 422 |
| `MethodNotFound` | `not_found_error` | Tool/resource not found | 404 |
| `InternalError` | `server_error` | Server-side error | 500+ |

### BookStack-Specific Errors

| Code | Description | Common Causes | Solutions |
|------|-------------|---------------|-----------|
| `AUTHENTICATION_FAILED` | Invalid API token | Wrong token, expired token | Regenerate token in BookStack |
| `PERMISSION_DENIED` | Insufficient permissions | User lacks required role | Assign appropriate role |
| `RESOURCE_NOT_FOUND` | Entity doesn't exist | Wrong ID, deleted entity | Verify ID, check recycle bin |
| `VALIDATION_ERROR` | Parameter validation failed | Missing required fields | Check parameter requirements |
| `RATE_LIMIT_EXCEEDED` | Too many requests | High frequency requests | Implement delays, check limits |
| `CONTENT_TOO_LARGE` | Content exceeds limits | Large file/text upload | Reduce content size |
| `DUPLICATE_ENTRY` | Unique constraint violation | Duplicate email, name | Use unique values |

## Examples

### Creating a Complete Documentation Structure

```typescript
// 1. Create a book
const book = await bookstack_books_create({
  name: "API Documentation",
  description: "Complete REST API reference",
  tags: [
    { name: "category", value: "documentation" },
    { name: "version", value: "1.0" }
  ]
});

// 2. Create chapters
const authChapter = await bookstack_chapters_create({
  book_id: book.id,
  name: "Authentication",
  description: "API authentication methods",
  priority: 1
});

const endpointsChapter = await bookstack_chapters_create({
  book_id: book.id,
  name: "Endpoints",
  description: "Available API endpoints",
  priority: 2
});

// 3. Create pages
const authPage = await bookstack_pages_create({
  chapter_id: authChapter.id,
  name: "Getting Started",
  markdown: `# Authentication

## API Token

Your API token must be included in the Authorization header:

\`\`\`
Authorization: Token your_token_here
\`\`\`

## Rate Limits

- 60 requests per minute
- 10 request burst capacity
`,
  tags: [{ name: "type", value: "guide" }]
});

// 4. Add to a bookshelf
await bookstack_shelves_create({
  name: "Developer Resources",
  books: [book.id]
});
```

### Searching and Organizing Content

```typescript
// Search for API-related content
const apiContent = await bookstack_search({
  query: '[page] API AND authentication',
  count: 50
});

// Find all books by a specific author
const userBooks = await bookstack_books_list({
  filter: { created_by: 5 },
  sort: 'updated_at'
});

// Get complete book structure
const fullBook = await bookstack_books_read({ id: 1 });
console.log(`Book has ${fullBook.contents.length} items`);

// Export documentation
const pdfExport = await bookstack_books_export({
  id: 1,
  format: 'pdf'
});
```

### User and Permission Management

```typescript
// Create documentation team role
const docRole = await bookstack_roles_create({
  display_name: "Documentation Team",
  description: "Can manage documentation content",
  permissions: {
    'content-export': true,
    'restrictions-manage-own': true
  }
});

// Create team member
const user = await bookstack_users_create({
  name: "Jane Smith",
  email: "jane@company.com",
  roles: [docRole.id],
  send_invite: true
});

// Set book permissions
await bookstack_permissions_update('book', 1, {
  permissions: [
    {
      role_id: docRole.id,
      view: true,
      create: true,
      update: true,
      delete: false
    }
  ]
});
```

### Content Maintenance

```typescript
// Audit recent changes
const recentChanges = await bookstack_audit_log_list({
  filter: {
    date_from: '2024-01-01',
    entity_type: 'page'
  },
  count: 100
});

// Check recycle bin
const deletedItems = await bookstack_recycle_bin_list();

// Restore accidentally deleted page
if (deletedItems.data.length > 0) {
  await bookstack_recycle_bin_restore({
    deletion_id: deletedItems.data[0].id
  });
}

// System health check
const systemInfo = await bookstack_system_info();
console.log(`BookStack version: ${systemInfo.version}`);
```

### Bulk Operations Pattern

```typescript
// Efficient batch processing
const books = await bookstack_books_list({ count: 500 });

for (const book of books.data) {
  // Process each book
  const fullBook = await bookstack_books_read({ id: book.id });
  
  // Update tags for consistency
  if (!book.tags.some(tag => tag.name === 'status')) {
    await bookstack_books_update(book.id, {
      tags: [
        ...book.tags,
        { name: 'status', value: 'active' }
      ]
    });
  }
}
```

---

## Notes

- All timestamps are in ISO 8601 format (UTC)
- IDs are positive integers
- Text fields have specified maximum lengths
- Binary content (files/images) must be Base64 encoded
- Tags are key-value pairs with optional ordering
- Deleted items can be restored from recycle bin
- Export formats: HTML (immediate), PDF (server-generated), Markdown, Plain Text
- Rate limiting applies to all operations
- Authentication is required for all endpoints
- Validation can be strict or permissive based on configuration

For additional help, use the `bookstack_help` tool or consult the error guides with `bookstack_error_guides`.
# BookStack MCP Server Tools Overview

## Complete Analysis of 47+ Tools Across 13 Categories

This document provides a comprehensive overview of all tools implemented in the BookStack MCP server, their capabilities, usage patterns, and implementation details.

## Executive Summary

The BookStack MCP Server provides **47+ tools** organized into **13 distinct categories**, implementing a complete interface to the BookStack knowledge management system. Each tool follows consistent patterns for validation, error handling, and logging.

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
| `bookstack_search` | Advanced search across all content | query (required), page, count |

**Search Features**:
- Advanced search syntax support
- Exact phrase matching with quotes
- Field-specific searches (name:, description:)
- Entity type filters ([book], [page], [chapter], [shelf])
- Tag-based searching (tag:value)
- Boolean operators
- Pagination support

### 10. Recycle Bin Management (3 tools)
**Category**: `recyclebin`  
**Purpose**: Manage deleted items

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_recycle_bin_list` | List deleted items | count, offset |
| `bookstack_recycle_bin_restore` | Restore deleted item to original location | deletion_id (required) |
| `bookstack_recycle_bin_delete_permanently` | Permanently delete item | deletion_id (required) |

**Recovery Features**:
- Safe deletion with recovery option
- Audit trail for deleted content
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

### 12. Audit Log (1 tool)
**Category**: `audit`  
**Purpose**: Track system activities

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_audit_log_list` | List audit log entries | count, offset, sort, filter (event, user_id, entity_type, entity_id, date_from, date_to) |

**Audit Features**:
- Comprehensive activity tracking
- User action monitoring
- Entity-specific filtering
- Date range queries
- Security and compliance support

### 13. System Information (6 tools)
**Category**: `system` / `meta`  
**Purpose**: Server information and help

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| `bookstack_system_info` | Get BookStack instance information | none |
| `bookstack_server_info` | Get comprehensive MCP server information | section (all/capabilities/tools/resources/examples/errors) |
| `bookstack_tool_categories` | Get detailed tool category information | category |
| `bookstack_usage_examples` | Get workflow examples | workflow |
| `bookstack_error_guides` | Get error handling guidance | error_code |
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
- Filter results at the API level
- Cache frequently accessed content
- Batch operations when possible

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

The BookStack MCP Server provides **complete coverage** of the BookStack REST API:

- ✅ **Content Management**: Full CRUD operations for all content types
- ✅ **User Management**: Complete user and role administration
- ✅ **Permission System**: Granular access control
- ✅ **File Management**: Attachments and images
- ✅ **Search**: Advanced search across all content
- ✅ **Export**: Multiple format support
- ✅ **Audit**: Complete activity tracking
- ✅ **System**: Health and information endpoints

## Extensibility

The modular architecture allows for easy extension:
- New tool categories can be added by implementing the MCPTool interface
- Custom validation rules can be added to the ValidationHandler
- Additional authentication methods can be integrated
- New export formats can be supported

## Conclusion

The BookStack MCP Server represents a comprehensive, production-ready implementation providing LLMs with complete access to BookStack functionality. With 47+ tools across 13 categories, robust error handling, comprehensive validation, and extensive documentation, it enables sophisticated knowledge management workflows while maintaining security and reliability.

The consistent patterns, extensive examples, and self-documenting capabilities make it easy for LLMs to understand and effectively utilize the full power of the BookStack platform through the MCP protocol.
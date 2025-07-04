# BookStack MCP Resources Guide

## Overview

This guide covers the **Resources** system in the BookStack MCP Server, which provides direct access to BookStack content through the Model Context Protocol (MCP). Resources offer a read-only interface to retrieve content, while tools provide interactive operations.

## Resources vs Tools

### Resources
- **Read-only access** to BookStack content
- **URI-based** addressing (e.g., `bookstack://books/123`)
- **Content retrieval** in structured formats (JSON, HTML, etc.)
- **Direct data access** without side effects
- **Cacheable** and suitable for context loading

### Tools
- **Interactive operations** (create, update, delete)
- **Parameter-based** input with validation
- **State-changing** operations on BookStack
- **Error handling** with retry policies
- **Action-oriented** functionality

## Available Resource Types

The BookStack MCP Server provides **12 resource types** across 6 categories:

### 1. Book Resources

#### `bookstack://books`
- **Purpose**: List all books with metadata
- **Returns**: Array of book objects with pagination
- **Schema**: 
  ```json
  {
    "data": [
      {
        "id": 123,
        "name": "Documentation Guide",
        "slug": "documentation-guide",
        "description": "Complete guide to documentation",
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z"
      }
    ],
    "total": 25
  }
  ```
- **Use Cases**:
  - Initial discovery of available content
  - Understanding documentation structure
  - Content planning and organization

#### `bookstack://books/{id}`
- **Purpose**: Get specific book with complete hierarchy
- **Returns**: Full book object with all chapters and pages
- **Schema**:
  ```json
  {
    "id": 123,
    "name": "Documentation Guide",
    "contents": [
      {
        "type": "chapter",
        "id": 456,
        "name": "Getting Started",
        "pages": [...]
      },
      {
        "type": "page",
        "id": 789,
        "name": "Overview"
      }
    ],
    "tags": [
      {"name": "category", "value": "documentation"}
    ]
  }
  ```
- **Dependencies**: Requires book ID from `bookstack://books`
- **Use Cases**:
  - Reading complete documentation structure
  - Understanding book organization
  - Pre-flight checks before structural changes

### 2. Page Resources

#### `bookstack://pages`
- **Purpose**: List all pages across BookStack
- **Returns**: Array of page objects with metadata
- **Schema**:
  ```json
  {
    "data": [
      {
        "id": 789,
        "book_id": 123,
        "chapter_id": 456,
        "name": "Getting Started",
        "draft": false,
        "template": false,
        "priority": 1
      }
    ],
    "total": 150
  }
  ```
- **Use Cases**:
  - Content discovery across all books
  - Finding specific pages by name
  - Understanding page distribution

#### `bookstack://pages/{id}`
- **Purpose**: Get specific page with full content
- **Returns**: Complete page object with HTML and markdown
- **Schema**:
  ```json
  {
    "id": 789,
    "name": "Getting Started",
    "html": "<p>Welcome to our documentation...</p>",
    "markdown": "# Getting Started\n\nWelcome to our documentation...",
    "tags": [
      {"name": "section", "value": "intro"}
    ]
  }
  ```
- **Dependencies**: Requires page ID from `bookstack://pages`
- **Use Cases**:
  - Reading complete page content
  - Content analysis and processing
  - Documentation generation

### 3. Chapter Resources

#### `bookstack://chapters`
- **Purpose**: List all chapters across BookStack
- **Returns**: Array of chapter objects with metadata
- **Schema**:
  ```json
  {
    "data": [
      {
        "id": 456,
        "book_id": 123,
        "name": "Getting Started",
        "description": "Introduction to the system",
        "priority": 1
      }
    ],
    "total": 45
  }
  ```
- **Use Cases**:
  - Understanding chapter organization
  - Content structure analysis
  - Chapter-level operations planning

#### `bookstack://chapters/{id}`
- **Purpose**: Get specific chapter with all pages
- **Returns**: Complete chapter object with nested pages
- **Schema**:
  ```json
  {
    "id": 456,
    "name": "Getting Started",
    "pages": [
      {
        "id": 789,
        "name": "Overview",
        "priority": 1
      },
      {
        "id": 790,
        "name": "Installation",
        "priority": 2
      }
    ]
  }
  ```
- **Dependencies**: Requires chapter ID from `bookstack://chapters`
- **Use Cases**:
  - Reading chapter structure
  - Understanding page organization within chapters
  - Content hierarchy analysis

### 4. Shelf Resources

#### `bookstack://shelves`
- **Purpose**: List all bookshelves (collections)
- **Returns**: Array of shelf objects with metadata
- **Schema**:
  ```json
  {
    "data": [
      {
        "id": 321,
        "name": "Technical Documentation",
        "description": "All technical guides and manuals",
        "created_at": "2024-01-01T00:00:00Z"
      }
    ],
    "total": 8
  }
  ```
- **Use Cases**:
  - Understanding content organization
  - Discovering related book collections
  - Content categorization analysis

#### `bookstack://shelves/{id}`
- **Purpose**: Get specific shelf with all books
- **Returns**: Complete shelf object with nested books
- **Schema**:
  ```json
  {
    "id": 321,
    "name": "Technical Documentation",
    "books": [
      {
        "id": 123,
        "name": "API Guide",
        "description": "Complete API documentation"
      },
      {
        "id": 124,
        "name": "Installation Guide",
        "description": "Step-by-step installation"
      }
    ]
  }
  ```
- **Dependencies**: Requires shelf ID from `bookstack://shelves`
- **Use Cases**:
  - Understanding shelf organization
  - Content collection analysis
  - Related content discovery

### 5. User Resources

#### `bookstack://users`
- **Purpose**: List all users in the system
- **Returns**: Array of user objects with metadata
- **Schema**:
  ```json
  {
    "data": [
      {
        "id": 1,
        "name": "John Doe",
        "email": "john@example.com",
        "slug": "john-doe",
        "created_at": "2024-01-01T00:00:00Z"
      }
    ],
    "total": 25
  }
  ```
- **Use Cases**:
  - User discovery and analysis
  - Author information retrieval
  - User-based content filtering

#### `bookstack://users/{id}`
- **Purpose**: Get specific user with roles
- **Returns**: Complete user object with role information
- **Schema**:
  ```json
  {
    "id": 1,
    "name": "John Doe",
    "email": "john@example.com",
    "roles": [
      {
        "id": 2,
        "display_name": "Editor",
        "description": "Can edit content"
      }
    ]
  }
  ```
- **Dependencies**: Requires user ID from `bookstack://users`
- **Use Cases**:
  - User profile information
  - Permission analysis
  - Content ownership tracking

### 6. Search Resources

#### `bookstack://search/{query}`
- **Purpose**: Search across all content types
- **Returns**: Array of search results with snippets
- **Schema**:
  ```json
  {
    "data": [
      {
        "id": 123,
        "name": "API Authentication",
        "type": "page",
        "preview_html": {
          "name": "API <em>Authentication</em>",
          "content": "Learn how to authenticate with the API..."
        },
        "book": {
          "id": 456,
          "name": "API Guide"
        }
      }
    ],
    "total": 12
  }
  ```
- **URI Format**: Encode queries in the URI (e.g., `bookstack://search/API%20authentication`)
- **Use Cases**:
  - Content discovery
  - Finding relevant information
  - Cross-content search

## Resource Schemas

### Enhanced Schema Features

The BookStack MCP resources include enhanced schema definitions with:

- **JSON Schema validation** for all resource types
- **Example responses** with realistic data
- **Access patterns** describing common usage scenarios
- **Dependency information** showing resource relationships

### Schema Properties

All resources include these standard properties:

- `uri`: Resource identifier pattern
- `name`: Human-readable name
- `description`: Detailed description of the resource
- `mimeType`: Content type (typically `application/json`)
- `schema`: JSON Schema definition
- `examples`: Usage examples with expected formats
- `access_patterns`: Common usage scenarios
- `dependencies`: Related resources (where applicable)

## Integration Patterns with Claude

### 1. Content Discovery Pattern

```javascript
// Step 1: Discover available books
const books = await readResource('bookstack://books');

// Step 2: Get specific book structure
const book = await readResource(`bookstack://books/${bookId}`);

// Step 3: Read specific pages
const pages = await Promise.all(
  book.contents
    .filter(item => item.type === 'page')
    .map(page => readResource(`bookstack://pages/${page.id}`))
);
```

### 2. Search-First Pattern

```javascript
// Step 1: Search for relevant content
const results = await readResource('bookstack://search/authentication');

// Step 2: Access specific results
const relevantPages = await Promise.all(
  results.data
    .filter(item => item.type === 'page')
    .map(item => readResource(`bookstack://pages/${item.id}`))
);
```

### 3. Hierarchical Navigation Pattern

```javascript
// Step 1: Get shelf organization
const shelf = await readResource(`bookstack://shelves/${shelfId}`);

// Step 2: Navigate to specific book
const book = await readResource(`bookstack://books/${bookId}`);

// Step 3: Read chapter contents
const chapter = await readResource(`bookstack://chapters/${chapterId}`);

// Step 4: Access individual pages
const page = await readResource(`bookstack://pages/${pageId}`);
```

### 4. Batch Content Loading Pattern

```javascript
// Load multiple resources in parallel
const [books, users, shelves] = await Promise.all([
  readResource('bookstack://books'),
  readResource('bookstack://users'),
  readResource('bookstack://shelves')
]);
```

## URI Patterns and Examples

### Static URIs
- `bookstack://books` - All books
- `bookstack://pages` - All pages
- `bookstack://chapters` - All chapters
- `bookstack://shelves` - All shelves
- `bookstack://users` - All users

### Dynamic URIs
- `bookstack://books/{id}` - Specific book (e.g., `bookstack://books/123`)
- `bookstack://pages/{id}` - Specific page (e.g., `bookstack://pages/456`)
- `bookstack://chapters/{id}` - Specific chapter (e.g., `bookstack://chapters/789`)
- `bookstack://shelves/{id}` - Specific shelf (e.g., `bookstack://shelves/321`)
- `bookstack://users/{id}` - Specific user (e.g., `bookstack://users/1`)
- `bookstack://search/{query}` - Search results (e.g., `bookstack://search/API%20guide`)

### URI Encoding
- **Spaces**: Use `%20` (e.g., `bookstack://search/API%20guide`)
- **Special characters**: URL encode as needed
- **Multiple words**: Encode each space separately

## Error Handling

### Common Resource Errors

1. **Resource Not Found**
   - **Cause**: Invalid ID or URI pattern
   - **Solution**: Verify resource exists using list resources first
   - **Example**: `bookstack://books/999` where book 999 doesn't exist

2. **Invalid URI Format**
   - **Cause**: Malformed URI or incorrect pattern
   - **Solution**: Follow URI pattern guidelines exactly
   - **Example**: `bookstack://book/123` (missing 's' in 'books')

3. **Permission Denied**
   - **Cause**: Insufficient permissions for requested content
   - **Solution**: Check user permissions or authenticate properly
   - **Example**: Private content not accessible to current user

4. **API Connection Error**
   - **Cause**: BookStack server unreachable or API token invalid
   - **Solution**: Verify server configuration and API token
   - **Example**: Server down or network connectivity issues

### Error Recovery Patterns

1. **Graceful Degradation**
   ```javascript
   try {
     const book = await readResource(`bookstack://books/${bookId}`);
     return book;
   } catch (error) {
     // Fall back to basic book list
     const books = await readResource('bookstack://books');
     return books.data.find(b => b.id === bookId);
   }
   ```

2. **Retry with Backoff**
   ```javascript
   async function readResourceWithRetry(uri, maxRetries = 3) {
     for (let i = 0; i < maxRetries; i++) {
       try {
         return await readResource(uri);
       } catch (error) {
         if (i === maxRetries - 1) throw error;
         await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
       }
     }
   }
   ```

## Performance Considerations

### Resource Loading Strategies

1. **Lazy Loading**
   - Load resources only when needed
   - Ideal for large hierarchies
   - Reduces initial load time

2. **Parallel Loading**
   - Load multiple independent resources simultaneously
   - Improves overall performance
   - Good for batch operations

3. **Caching**
   - Cache frequently accessed resources
   - Implement TTL for data freshness
   - Reduce API calls

### Best Practices

1. **Start with Lists**
   - Always begin with list resources (`bookstack://books`)
   - Use IDs from lists to access specific items
   - Avoids guessing resource identifiers

2. **Batch Related Operations**
   - Load all related resources in parallel
   - Reduce sequential API calls
   - Improve user experience

3. **Handle Hierarchies Efficiently**
   - Use book resources to understand structure
   - Navigate hierarchy systematically
   - Avoid deep recursive loading

4. **Implement Proper Error Handling**
   - Always handle resource not found errors
   - Provide meaningful error messages
   - Implement retry logic for transient failures

## Advanced Usage

### Resource Filtering and Searching

While resources provide raw data, you can implement client-side filtering:

```javascript
// Filter books by name
const books = await readResource('bookstack://books');
const filteredBooks = books.data.filter(book => 
  book.name.toLowerCase().includes('api')
);

// Search across multiple resource types
const searchResults = await readResource('bookstack://search/authentication');
const pageResults = searchResults.data.filter(item => item.type === 'page');
```

### Content Aggregation

Combine multiple resources for comprehensive content views:

```javascript
// Get complete documentation overview
const [books, users, shelves] = await Promise.all([
  readResource('bookstack://books'),
  readResource('bookstack://users'),
  readResource('bookstack://shelves')
]);

const overview = {
  totalBooks: books.total,
  totalUsers: users.total,
  totalShelves: shelves.total,
  recentBooks: books.data.slice(0, 5),
  activeUsers: users.data.filter(user => user.last_activity_at)
};
```

### Dynamic Resource Discovery

Use resource metadata for dynamic applications:

```javascript
// Discover available resources
const resources = await listResources();
const bookResources = resources.filter(r => r.uri.includes('books'));

// Build dynamic navigation
const navigation = await Promise.all(
  bookResources.map(async resource => {
    if (resource.uri === 'bookstack://books') {
      const books = await readResource(resource.uri);
      return {
        title: 'Books',
        count: books.total,
        items: books.data
      };
    }
  })
);
```

## Troubleshooting

### Common Issues

1. **Empty Results**
   - **Check**: Resource exists and has data
   - **Solution**: Verify BookStack content exists
   - **Debug**: Use list resources first

2. **Slow Performance**
   - **Check**: Number of API calls
   - **Solution**: Implement parallel loading
   - **Debug**: Monitor API response times

3. **Inconsistent Data**
   - **Check**: Cache invalidation
   - **Solution**: Implement proper cache TTL
   - **Debug**: Compare cached vs fresh data

### Debugging Tips

1. **Enable Debug Logging**
   ```javascript
   // Set LOG_LEVEL=debug in environment
   process.env.LOG_LEVEL = 'debug';
   ```

2. **Monitor API Calls**
   ```javascript
   // Track resource access patterns
   const resourceUsage = new Map();
   
   function trackResourceUsage(uri) {
     resourceUsage.set(uri, (resourceUsage.get(uri) || 0) + 1);
   }
   ```

3. **Validate Resource URIs**
   ```javascript
   function validateResourceUri(uri) {
     const patterns = [
       /^bookstack:\/\/books$/,
       /^bookstack:\/\/books\/\d+$/,
       /^bookstack:\/\/pages$/,
       /^bookstack:\/\/pages\/\d+$/,
       // ... other patterns
     ];
     
     return patterns.some(pattern => pattern.test(uri));
   }
   ```

## Integration with BookStack Tools

Resources complement the BookStack MCP tools:

- **Resources** provide read-only access to content
- **Tools** enable content creation and modification
- **Use together** for complete BookStack integration

### Typical Workflow

1. **Discovery**: Use resources to understand existing content
2. **Analysis**: Process resource data to identify needs
3. **Action**: Use tools to create or modify content
4. **Verification**: Use resources to confirm changes

This creates a complete cycle of content management through the MCP interface.

## Conclusion

The BookStack MCP Resources system provides comprehensive, efficient access to BookStack content through a standardized URI-based interface. By understanding the resource types, patterns, and best practices outlined in this guide, you can build robust integrations that effectively leverage BookStack's knowledge management capabilities.

For interactive operations, combine resources with the BookStack MCP tools to create complete content management workflows.
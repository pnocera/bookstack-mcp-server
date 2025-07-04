# BookStack MCP Server

A comprehensive Model Context Protocol (MCP) server providing full access to BookStack's knowledge management capabilities. This server exposes all 47 BookStack API endpoints as MCP tools, enabling seamless integration with Claude and other MCP-compatible AI assistants.

## 🚀 Features

### Complete BookStack Integration
- **47 MCP Tools** covering all BookStack API endpoints
- **Resource Access** for dynamic content retrieval
- **Real-time Search** across all content types
- **Export Functionality** in multiple formats (HTML, PDF, Markdown, Plain Text)
- **Content Management** for books, pages, chapters, shelves, users, and roles

### Advanced Capabilities
- **Rate Limiting** with configurable limits and burst protection
- **Comprehensive Validation** using Zod schemas
- **Error Handling** with retry logic and proper error mapping
- **Context7 Integration** for enhanced documentation
- **Health Monitoring** with detailed system checks
- **Logging** with configurable levels and formats

### Developer Experience
- **TypeScript Support** with complete type definitions
- **Hot Reloading** during development
- **Comprehensive Testing** with unit and integration tests
- **Docker Support** for easy deployment
- **Extensive Documentation** with examples and guides

## 📦 Installation

### Prerequisites
- Node.js 18+ and npm 9+
- BookStack instance with API access
- API token from BookStack

### Quick Start

1. **Clone and Install**
   ```bash
   git clone <repository-url>
   cd bookstack-mcp-server
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your BookStack details
   ```

3. **Build and Start**
   ```bash
   npm run build
   npm start
   ```

### Configuration

Create a `.env` file with your BookStack configuration:

```env
# BookStack API Configuration
BOOKSTACK_BASE_URL=http://localhost:8080/api
BOOKSTACK_API_TOKEN=your-api-token-here
BOOKSTACK_TIMEOUT=30000

# Server Configuration
LOG_LEVEL=info
VALIDATION_ENABLED=true
CONTEXT7_ENABLED=true

# Rate Limiting
RATE_LIMIT_REQUESTS_PER_MINUTE=60
RATE_LIMIT_BURST_LIMIT=10
```

## 🛠️ Available Tools

### Books (6 tools)
- `bookstack_books_list` - List all books with filtering
- `bookstack_books_create` - Create new books
- `bookstack_books_read` - Get book details with contents
- `bookstack_books_update` - Update book information
- `bookstack_books_delete` - Delete books (to recycle bin)
- `bookstack_books_export` - Export books in multiple formats

### Pages (6 tools)
- `bookstack_pages_list` - List all pages with filtering
- `bookstack_pages_create` - Create new pages with HTML/Markdown
- `bookstack_pages_read` - Get page details with content
- `bookstack_pages_update` - Update page content and metadata
- `bookstack_pages_delete` - Delete pages (to recycle bin)
- `bookstack_pages_export` - Export pages in multiple formats

### Chapters (6 tools)
- `bookstack_chapters_list` - List all chapters
- `bookstack_chapters_create` - Create new chapters
- `bookstack_chapters_read` - Get chapter details with pages
- `bookstack_chapters_update` - Update chapter information
- `bookstack_chapters_delete` - Delete chapters
- `bookstack_chapters_export` - Export chapters

### Additional Tools
- **Search** - Advanced search across all content
- **Users & Roles** - Complete user management
- **Attachments & Images** - File management
- **Permissions** - Content access control
- **System Info** - Instance information and health
- **Recycle Bin** - Deleted item recovery

## 🔗 Claude Code Integration

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "bookstack": {
      "command": "npx",
      "args": ["bookstack-mcp-server"],
      "env": {
        "BOOKSTACK_BASE_URL": "http://localhost:8080/api",
        "BOOKSTACK_API_TOKEN": "your-token"
      }
    }
  }
}
```

## 📚 Usage Examples

### List Books
```javascript
// Use the bookstack_books_list tool
{
  "count": 10,
  "sort": "updated_at",
  "filter": {
    "name": "documentation"
  }
}
```

### Create a Page
```javascript
// Use the bookstack_pages_create tool
{
  "name": "API Documentation",
  "book_id": 1,
  "html": "<h1>API Guide</h1><p>Complete API documentation...</p>",
  "tags": [
    {"name": "category", "value": "documentation"},
    {"name": "status", "value": "draft"}
  ]
}
```

### Search Content
```javascript
// Use the bookstack_search tool
{
  "query": "API documentation [page] tag:category=api",
  "count": 20
}
```

## 🧪 Development

### Scripts
```bash
npm run dev          # Start development server with hot reload
npm run build        # Build TypeScript to JavaScript
npm run test         # Run test suite
npm run test:watch   # Run tests in watch mode
npm run lint         # Lint TypeScript code
npm run format       # Format code with Prettier
```

### Project Structure
```
src/
├── server.ts           # Main MCP server
├── api/
│   └── client.ts       # BookStack API client
├── tools/              # MCP tool implementations
│   ├── books.ts
│   ├── pages.ts
│   └── ...
├── resources/          # MCP resource handlers
├── utils/              # Utilities (logging, errors, rate limiting)
├── validation/         # Zod schemas and validation
├── config/             # Configuration management
└── context7/           # Context7 integration
```

### Testing
```bash
# Run all tests
npm test

# Run specific test file
npm test books.test.ts

# Run with coverage
npm run test:coverage
```

## 🐳 Docker Deployment

### Build Image
```bash
docker build -t bookstack-mcp-server .
```

### Run Container
```bash
docker run -p 3000:3000 \
  -e BOOKSTACK_BASE_URL=http://bookstack:8080/api \
  -e BOOKSTACK_API_TOKEN=your-token \
  bookstack-mcp-server
```

### Docker Compose
```yaml
version: '3.8'
services:
  bookstack-mcp:
    build: .
    ports:
      - "3000:3000"
    environment:
      BOOKSTACK_BASE_URL: http://bookstack:8080/api
      BOOKSTACK_API_TOKEN: your-token
    depends_on:
      - bookstack
```

## 🔍 Monitoring & Health Checks

### Health Endpoint
The server provides health check functionality:

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "healthy",
  "checks": [
    {"name": "bookstack_connection", "healthy": true},
    {"name": "tools_loaded", "healthy": true, "message": "47 tools loaded"},
    {"name": "resources_loaded", "healthy": true, "message": "12 resources loaded"}
  ]
}
```

### Metrics
- Request/response times
- Error rates
- Rate limit status
- Memory usage
- Tool usage statistics

## 🛡️ Security

### API Token Management
- Secure token storage in environment variables
- Token validation on startup
- Automatic token rotation support (when available)

### Rate Limiting
- Configurable request limits (default: 60/minute)
- Burst protection (default: 10 concurrent)
- Automatic backoff on rate limit hits

### Input Validation
- Comprehensive Zod schema validation
- SQL injection prevention
- XSS protection for HTML content
- File upload validation

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Follow TypeScript best practices
- Add tests for new features
- Update documentation
- Follow conventional commit messages
- Ensure all tests pass

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: [Implementation Guide](mcp-server-implementation-guide.md)
- **Issues**: [GitHub Issues](https://github.com/bookstack/mcp-server/issues)
- **Examples**: [Example Usage](examples/)

## 🎯 Roadmap

### Planned Features
- [ ] Real-time notifications via WebSockets
- [ ] Bulk operations for content management
- [ ] Advanced caching strategies
- [ ] Metrics dashboard
- [ ] Plugin system for custom tools
- [ ] Multi-instance BookStack support

### Performance Goals
- 99.9% uptime
- <100ms average response time
- Support for 1000+ concurrent connections
- Memory usage under 512MB

---

**Built with ❤️ for the BookStack community**

For more information about BookStack, visit [bookstackapp.com](https://www.bookstackapp.com)
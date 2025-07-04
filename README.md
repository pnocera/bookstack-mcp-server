# BookStack MCP Server

Connect BookStack to Claude and other AI assistants through the Model Context Protocol (MCP). This server provides complete access to your BookStack knowledge base with 47+ tools covering all API endpoints.

## ✨ What You Get

- **Complete BookStack Integration** - Access all your books, pages, chapters, and content
- **47+ MCP Tools** - Full CRUD operations for every BookStack feature
- **Search & Export** - Find content and export in multiple formats
- **User Management** - Handle users, roles, and permissions
- **Production Ready** - Rate limiting, validation, error handling, and logging

## 🚀 Quick Start

```bash
# Install globally
npm install -g bookstack-mcp-server

# Or run directly
npx bookstack-mcp-server
```

### Add to Claude

```bash
# For Claude Code
claude mcp add bookstack npx bookstack-mcp-server \
  --env BOOKSTACK_BASE_URL=https://your-bookstack.com/api \
  --env BOOKSTACK_API_TOKEN=your-token-here
```

### Configuration

Set these environment variables:

```bash
export BOOKSTACK_BASE_URL="https://your-bookstack.com/api"
export BOOKSTACK_API_TOKEN="your-api-token-here"
```

> 💡 Need detailed setup? See the complete [Setup Guide](docs/setup-guide.md)

## 🛠️ Available Tools

**47+ tools across 13 categories:**

- **📚 Books** - Create, read, update, delete, and export books
- **📄 Pages** - Manage pages with HTML/Markdown content
- **📑 Chapters** - Organize pages within books
- **📚 Shelves** - Group books into collections
- **👥 Users & Roles** - Complete user management
- **🔍 Search** - Advanced search across all content
- **📎 Attachments & Images** - File management
- **🔐 Permissions** - Content access control
- **🗑️ Recycle Bin** - Deleted item recovery
- **📊 Audit Log** - Activity tracking
- **⚙️ System Info** - Instance health and information

> 📖 See the complete [Tools Overview](docs/tools-overview.md) for detailed documentation

## 📚 Documentation

Find comprehensive guides in the `docs/` folder:

- **[Setup Guide](docs/setup-guide.md)** - Complete installation and configuration
- **[API Reference](docs/api-reference.md)** - All endpoints with examples
- **[Tools Overview](docs/tools-overview.md)** - Every tool explained
- **[Resources Guide](docs/resources-guide.md)** - Resource access patterns
- **[Examples & Workflows](docs/examples-and-workflows.md)** - Real-world usage

## ⚡ Quick Examples

**List all books:**
```javascript
bookstack_books_list({ count: 10, sort: "updated_at" })
```

**Create a new page:**
```javascript
bookstack_pages_create({
  name: "Getting Started",
  book_id: 1,
  markdown: "# Welcome\nYour content here..."
})
```

**Search for content:**
```javascript
bookstack_search({ query: "API documentation", count: 20 })
```

## 🛠️ Development

```bash
git clone <repository-url>
cd bookstack-mcp-server
npm install
npm run dev
```

> 🔧 See the [Setup Guide](docs/setup-guide.md) for development, Docker, and production deployment

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🆘 Support

- **📚 Documentation**: Complete guides in the [docs/](docs/) folder
- **🐛 Issues**: [GitHub Issues](https://github.com/pnocera/bookstack-mcp-server/issues)
- **💬 Discussions**: [GitHub Discussions](https://github.com/pnocera/bookstack-mcp-server/discussions)

---

**Built with ❤️ for the BookStack community**
# BookStack MCP Server - Complete Setup & Configuration Guide

## 📋 Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [BookStack Server Requirements](#bookstack-server-requirements)
4. [Installation Methods](#installation-methods)
5. [Configuration](#configuration)
6. [Authentication Setup](#authentication-setup)
7. [Claude Integration](#claude-integration)
8. [Advanced Configuration](#advanced-configuration)
9. [Development Setup](#development-setup)
10. [Deployment Options](#deployment-options)
11. [Troubleshooting](#troubleshooting)
12. [FAQ](#faq)

## 🎯 Overview

The BookStack MCP Server provides comprehensive access to BookStack's knowledge management capabilities through the Model Context Protocol (MCP). This guide covers everything you need to set up and configure the server for optimal performance.

### Key Features
- **47 MCP Tools** covering all BookStack API endpoints
- **Resource Access** for dynamic content retrieval
- **Rate Limiting** with configurable limits
- **Comprehensive Validation** using Zod schemas
- **Error Handling** with retry logic
- **TypeScript Support** with complete type definitions

## 🔧 Prerequisites

### System Requirements
- **Node.js**: 18.0.0 or higher
- **npm**: 9.0.0 or higher
- **Operating System**: Linux, macOS, or Windows
- **Memory**: Minimum 512MB RAM (1GB recommended)
- **Storage**: 100MB for installation + log storage

### Required Services
- **BookStack Instance**: Running and accessible
- **BookStack API**: Enabled with valid token
- **Network Access**: HTTP/HTTPS connection to BookStack

### Verify Prerequisites
```bash
# Check Node.js version
node --version  # Should be 18.0.0+

# Check npm version
npm --version   # Should be 9.0.0+

# Check system resources
free -h         # Linux/macOS
```

## 🏠 BookStack Server Requirements

### BookStack Version
- **Minimum**: BookStack v21.08+
- **Recommended**: BookStack v23.05+ (latest stable)
- **API Version**: v1 (current)

### BookStack Configuration
Your BookStack instance must have:

1. **API Access Enabled**
   ```php
   // In BookStack .env file
   API_REQUESTS_PER_MIN=180
   API_DEFAULT_ITEM_COUNT=100
   ```

2. **CORS Configuration** (if cross-origin access needed)
   ```php
   // In BookStack .env file
   ALLOWED_IFRAME_HOSTS=*
   ALLOWED_IFRAME_SOURCES=*
   ```

3. **User Permissions**
   - API user must have appropriate permissions
   - Recommended: Admin role for full access
   - Minimum: View permissions for content areas

### API Token Setup
1. **Log into BookStack** as admin or privileged user
2. **Navigate to**: Profile → API Tokens
3. **Create New Token**:
   - Name: `mcp-server-token`
   - Description: `Token for MCP server access`
   - Expiry: Set appropriate expiry (optional)
4. **Copy Token**: Save securely for configuration

## 📦 Installation Methods

### Method 1: Global Installation (Recommended)
```bash
# Install globally for system-wide access
npm install -g bookstack-mcp-server

# Verify installation
bookstack-mcp-server --version
```

### Method 2: Local Project Installation
```bash
# Create project directory
mkdir my-bookstack-mcp
cd my-bookstack-mcp

# Install locally
npm install bookstack-mcp-server

# Or install from source
git clone https://github.com/pnocera/bookstack-mcp-server.git
cd bookstack-mcp-server
npm install
npm run build
```

### Method 3: Development Installation
```bash
# Clone repository
git clone https://github.com/pnocera/bookstack-mcp-server.git
cd bookstack-mcp-server

# Install dependencies
npm install

# Build project
npm run build

# Run development server
npm run dev
```

## ⚙️ Configuration

### Environment Variables
Create a `.env` file in your project directory:

```env
# BookStack API Configuration
BOOKSTACK_BASE_URL=http://localhost:8080/api
BOOKSTACK_API_TOKEN=your-api-token-here
BOOKSTACK_TIMEOUT=30000

# Server Configuration
SERVER_NAME=bookstack-mcp-server
SERVER_VERSION=1.0.0
SERVER_PORT=3000

# Rate Limiting
RATE_LIMIT_REQUESTS_PER_MINUTE=60
RATE_LIMIT_BURST_LIMIT=10

# Validation
VALIDATION_ENABLED=true
VALIDATION_STRICT_MODE=false

# Logging
LOG_LEVEL=info
LOG_FORMAT=pretty

# Context7 Integration
CONTEXT7_ENABLED=true
CONTEXT7_LIBRARY_ID=/bookstack/bookstack
CONTEXT7_CACHE_TTL=3600

# Security
CORS_ENABLED=true
CORS_ORIGIN=*
HELMET_ENABLED=true

# Development
NODE_ENV=development
DEBUG=false
```

### Configuration Options Explained

#### BookStack Settings
- **BOOKSTACK_BASE_URL**: Full URL to BookStack API endpoint
  - Format: `http://yourserver.com/api`
  - Include `/api` suffix
  - Use HTTPS in production

- **BOOKSTACK_API_TOKEN**: API token from BookStack
  - Generate in BookStack admin panel
  - Keep secure and rotate regularly

- **BOOKSTACK_TIMEOUT**: Request timeout in milliseconds
  - Default: 30000 (30 seconds)
  - Increase for slow networks

#### Rate Limiting
- **RATE_LIMIT_REQUESTS_PER_MINUTE**: Maximum requests per minute
  - Default: 60
  - Adjust based on BookStack limits

- **RATE_LIMIT_BURST_LIMIT**: Concurrent request limit
  - Default: 10
  - Prevents overwhelming BookStack

#### Logging
- **LOG_LEVEL**: Logging verbosity
  - Options: `error`, `warn`, `info`, `debug`
  - Use `info` for production

- **LOG_FORMAT**: Log output format
  - Options: `json`, `pretty`
  - Use `json` for production logs

#### Validation
- **VALIDATION_ENABLED**: Enable input validation
  - Default: `true`
  - Always keep enabled

- **VALIDATION_STRICT_MODE**: Strict validation mode
  - Default: `false`
  - Enable for additional safety

## 🔐 Authentication Setup

### BookStack User Setup
1. **Create Service Account** (recommended)
   ```
   Email: mcp-service@yourcompany.com
   Name: MCP Service Account
   Role: Admin (or custom role with required permissions)
   ```

2. **Generate API Token**
   - Login as service account
   - Go to Profile → API Tokens
   - Create token with descriptive name
   - Copy token immediately

### Token Security
- **Storage**: Use environment variables or secure vault
- **Rotation**: Implement regular token rotation
- **Monitoring**: Monitor token usage and access

### Permission Requirements
The API user needs these minimum permissions:
- **Books**: View, Create, Update, Delete
- **Pages**: View, Create, Update, Delete
- **Chapters**: View, Create, Update, Delete
- **Shelves**: View, Create, Update, Delete
- **Users**: View (for user management tools)
- **System**: View (for system info tools)

## 🎨 Claude Integration

### Claude Desktop Integration
Add to your Claude Desktop configuration:

#### Method 1: Manual Configuration
Edit `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "bookstack": {
      "command": "bookstack-mcp-server",
      "env": {
        "BOOKSTACK_BASE_URL": "http://localhost:8080/api",
        "BOOKSTACK_API_TOKEN": "your-api-token-here"
      }
    }
  }
}
```

#### Method 2: Using Claude CLI
```bash
# Add server configuration
claude mcp add bookstack bookstack-mcp-server \
  --env BOOKSTACK_BASE_URL=http://localhost:8080/api \
  --env BOOKSTACK_API_TOKEN=your-api-token-here

# Verify configuration
claude mcp list
```

### Claude Code Integration
For Claude Code MCP support:

```bash
# Add as MCP server
claude mcp add-json bookstack '{
  "type": "stdio",
  "command": "npx",
  "args": ["bookstack-mcp-server"],
  "env": {
    "BOOKSTACK_BASE_URL": "http://localhost:8080/api",
    "BOOKSTACK_API_TOKEN": "your-api-token-here"
  }
}'
```

### Configuration File Locations
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/claude/claude_desktop_config.json`

## 🔧 Advanced Configuration

### Custom Configuration Files
Create `config.json` for complex setups:

```json
{
  "bookstack": {
    "baseUrl": "https://docs.company.com/api",
    "apiToken": "${BOOKSTACK_API_TOKEN}",
    "timeout": 45000,
    "retryAttempts": 3,
    "retryDelay": 1000
  },
  "server": {
    "name": "company-bookstack-mcp",
    "version": "1.0.0",
    "port": 3000
  },
  "rateLimit": {
    "requestsPerMinute": 120,
    "burstLimit": 20
  },
  "logging": {
    "level": "info",
    "format": "json",
    "logFile": "/var/log/bookstack-mcp.log"
  },
  "features": {
    "enableMetrics": true,
    "enableHealthCheck": true,
    "enableDocumentation": true
  }
}
```

### Production Configuration
For production deployments:

```env
# Production Environment Variables
NODE_ENV=production
DEBUG=false
LOG_LEVEL=warn
LOG_FORMAT=json

# Security
CORS_ORIGIN=https://yourapp.com
HELMET_ENABLED=true

# Performance
RATE_LIMIT_REQUESTS_PER_MINUTE=180
RATE_LIMIT_BURST_LIMIT=30

# Monitoring
ENABLE_METRICS=true
METRICS_PORT=9090
HEALTH_CHECK_PORT=9091
```

### Multiple BookStack Instances
For multiple BookStack instances:

```json
{
  "instances": [
    {
      "name": "production",
      "baseUrl": "https://docs.company.com/api",
      "apiToken": "${PROD_API_TOKEN}",
      "priority": 1
    },
    {
      "name": "staging",
      "baseUrl": "https://staging-docs.company.com/api",
      "apiToken": "${STAGING_API_TOKEN}",
      "priority": 2
    }
  ]
}
```

## 🛠️ Development Setup

### Development Environment
```bash
# Clone repository
git clone https://github.com/pnocera/bookstack-mcp-server.git
cd bookstack-mcp-server

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit configuration
nano .env

# Start development server
npm run dev
```

### Development Scripts
```bash
# Development server with hot reload
npm run dev

# Build TypeScript
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Format code
npm run format

# Clean build directory
npm run clean
```

### Testing Configuration
```bash
# Run specific test file
npm test -- books.test.ts

# Run tests in watch mode
npm run test:watch

# Debug tests
npm run test:debug
```

## 🚀 Deployment Options

### Systemd Service (Linux)
Create `/etc/systemd/system/bookstack-mcp.service`:

```ini
[Unit]
Description=BookStack MCP Server
After=network.target

[Service]
Type=simple
User=bookstack-mcp
WorkingDirectory=/opt/bookstack-mcp
ExecStart=/usr/bin/node /opt/bookstack-mcp/dist/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/bookstack-mcp/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable bookstack-mcp
sudo systemctl start bookstack-mcp
sudo systemctl status bookstack-mcp
```

### Docker Deployment
Create `Dockerfile`:

```dockerfile
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY dist ./dist
COPY .env.example .env

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1))"

# Start server
CMD ["node", "dist/server.js"]
```

Build and run:
```bash
# Build image
docker build -t bookstack-mcp-server .

# Run container
docker run -d \
  --name bookstack-mcp \
  -p 3000:3000 \
  -e BOOKSTACK_BASE_URL=http://bookstack:8080/api \
  -e BOOKSTACK_API_TOKEN=your-token \
  bookstack-mcp-server
```

### Docker Compose
Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  bookstack-mcp:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - BOOKSTACK_BASE_URL=http://bookstack:8080/api
      - BOOKSTACK_API_TOKEN=${BOOKSTACK_API_TOKEN}
      - LOG_LEVEL=info
    volumes:
      - ./logs:/app/logs
    depends_on:
      - bookstack
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  bookstack:
    image: bookstackapp/bookstack:latest
    environment:
      - APP_URL=http://localhost:8080
      - DB_HOST=bookstack_db
      - DB_DATABASE=bookstack
      - DB_USERNAME=bookstack
      - DB_PASSWORD=secret
    depends_on:
      - bookstack_db
    ports:
      - "8080:80"

  bookstack_db:
    image: mysql:8.0
    environment:
      - MYSQL_ROOT_PASSWORD=secret
      - MYSQL_DATABASE=bookstack
      - MYSQL_USER=bookstack
      - MYSQL_PASSWORD=secret
    volumes:
      - bookstack_db_data:/var/lib/mysql

volumes:
  bookstack_db_data:
```

## 🔍 Troubleshooting

### Common Issues

#### 1. Connection Refused
**Error**: `ECONNREFUSED` connecting to BookStack

**Solutions**:
- Verify BookStack is running and accessible
- Check `BOOKSTACK_BASE_URL` is correct
- Ensure `/api` suffix is included in URL
- Test API access: `curl -H "Authorization: Token YOUR_TOKEN" http://localhost:8080/api/docs`

#### 2. Authentication Failed
**Error**: `401 Unauthorized` or `403 Forbidden`

**Solutions**:
- Verify API token is correct and not expired
- Check user permissions in BookStack
- Ensure token has required scopes
- Test token: `curl -H "Authorization: Token YOUR_TOKEN" http://localhost:8080/api/users`

#### 3. Rate Limit Exceeded
**Error**: `429 Too Many Requests`

**Solutions**:
- Reduce `RATE_LIMIT_REQUESTS_PER_MINUTE`
- Increase `RATE_LIMIT_BURST_LIMIT`
- Check BookStack rate limits
- Implement request queuing

#### 4. Validation Errors
**Error**: `Configuration validation failed`

**Solutions**:
- Check all required environment variables are set
- Verify URL format (must include protocol)
- Ensure numeric values are valid
- Review configuration schema

#### 5. Memory Issues
**Error**: `JavaScript heap out of memory`

**Solutions**:
- Increase Node.js memory: `node --max-old-space-size=4096 dist/server.js`
- Reduce concurrent connections
- Enable response streaming
- Check for memory leaks

### Debug Mode
Enable debug logging:

```bash
# Set debug environment
export DEBUG=true
export LOG_LEVEL=debug

# Run with debug output
npm run dev
```

### Health Checks
Monitor server health:

```bash
# Check server status
curl http://localhost:3000/health

# Expected response
{
  "status": "healthy",
  "checks": [
    {"name": "bookstack_connection", "healthy": true},
    {"name": "tools_loaded", "healthy": true, "message": "47 tools loaded"},
    {"name": "resources_loaded", "healthy": true, "message": "12 resources loaded"}
  ]
}
```

### Log Analysis
Check logs for issues:

```bash
# View recent logs
tail -f /var/log/bookstack-mcp.log

# Search for errors
grep -i error /var/log/bookstack-mcp.log

# Filter by timestamp
grep "2024-01-01" /var/log/bookstack-mcp.log
```

### Performance Monitoring
Monitor performance metrics:

```bash
# Check memory usage
ps aux | grep bookstack-mcp

# Monitor network connections
netstat -an | grep :3000

# Check file descriptors
lsof -p $(pgrep -f bookstack-mcp)
```

## ❓ FAQ

### Q: Can I use this with BookStack SaaS?
A: Yes, if your BookStack SaaS provider supports API access. Contact your provider for API endpoint and token generation.

### Q: Does this support multiple BookStack instances?
A: Currently, one instance per server. For multiple instances, run multiple MCP servers with different configurations.

### Q: What's the difference between tools and resources?
A: **Tools** are active functions (create, update, delete). **Resources** are passive data access (read-only content).

### Q: How do I backup my configuration?
A: Back up your `.env` file and any custom configuration files. Store API tokens securely.

### Q: Can I customize the available tools?
A: Yes, you can disable specific tools by modifying the source code or using feature flags.

### Q: How do I migrate from an older version?
A: 
1. Backup current configuration
2. Update to new version
3. Compare configuration schemas
4. Test all integrations
5. Update Claude integration if needed

### Q: Is there a GUI for configuration?
A: Currently no GUI is available. Configuration is done through environment variables and config files.

### Q: How do I contribute to the project?
A: 
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

### Q: What's the performance impact?
A: Minimal. The server uses connection pooling and efficient caching. Typical memory usage is 50-100MB.

### Q: Can I use this in production?
A: Yes, it's designed for production use. Follow the production configuration guidelines and implement proper monitoring.

---

## 📞 Support

- **Documentation**: [GitHub Repository](https://github.com/pnocera/bookstack-mcp-server)
- **Issues**: [GitHub Issues](https://github.com/pnocera/bookstack-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/pnocera/bookstack-mcp-server/discussions)

## 📝 License

This project is licensed under the MIT License. See the [LICENSE](../LICENSE) file for details.

---

**Built with ❤️ for the BookStack community**
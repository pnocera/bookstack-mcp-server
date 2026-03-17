#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookStackMCPServer = void 0;
const express_1 = __importDefault(require("express"));
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const client_1 = require("./api/client");
const manager_1 = require("./config/manager");
const logger_1 = require("./utils/logger");
const errors_1 = require("./utils/errors");
const validator_1 = require("./validation/validator");
const books_1 = require("./tools/books");
const pages_1 = require("./tools/pages");
const chapters_1 = require("./tools/chapters");
const shelves_1 = require("./tools/shelves");
const users_1 = require("./tools/users");
const roles_1 = require("./tools/roles");
const attachments_1 = require("./tools/attachments");
const images_1 = require("./tools/images");
const search_1 = require("./tools/search");
const recyclebin_1 = require("./tools/recyclebin");
const permissions_1 = require("./tools/permissions");
const audit_1 = require("./tools/audit");
const system_1 = require("./tools/system");
const server_info_1 = require("./tools/server-info");
const books_2 = require("./resources/books");
const pages_2 = require("./resources/pages");
const chapters_2 = require("./resources/chapters");
const shelves_2 = require("./resources/shelves");
const users_2 = require("./resources/users");
const search_2 = require("./resources/search");
/**
 * BookStack MCP Server
 *
 * Provides comprehensive access to BookStack knowledge management system
 * through the Model Context Protocol (MCP).
 *
 * Features:
 * - 47 tools covering all BookStack API endpoints
 * - Resource access for all content types
 * - Context7 integration for enhanced documentation
 * - Comprehensive error handling and validation
 * - Rate limiting and retry policies
 */
class BookStackMCPServer {
    constructor(configOverrides) {
        this.tools = new Map();
        this.resources = new Map();
        const baseConfig = manager_1.ConfigManager.getInstance().getConfig();
        // Merge overrides
        const config = { ...baseConfig };
        if (configOverrides) {
            if (configOverrides.bookstack) {
                config.bookstack = { ...config.bookstack, ...configOverrides.bookstack };
            }
            // Add other overrides as needed
        }
        this.logger = logger_1.Logger.getInstance();
        this.errorHandler = new errors_1.ErrorHandler(this.logger);
        this.validator = new validator_1.ValidationHandler(config.validation);
        this.client = new client_1.BookStackClient(config, this.logger, this.errorHandler);
        // Initialize MCP server
        this.server = new index_js_1.Server({
            name: config.server.name,
            version: config.server.version,
        }, {
            capabilities: {
                tools: {},
                resources: {},
                logging: {},
            },
        });
        this.setupTools();
        this.setupResources();
        this.setupHandlers();
        this.logger.info('BookStack MCP Server initialized', {
            tools: this.tools.size,
            resources: this.resources.size,
            baseUrl: config.bookstack.baseUrl,
        });
    }
    /**
     * Setup all tools for BookStack API endpoints
     */
    setupTools() {
        const toolClasses = [
            new books_1.BookTools(this.client, this.validator, this.logger),
            new pages_1.PageTools(this.client, this.validator, this.logger),
            new chapters_1.ChapterTools(this.client, this.validator, this.logger),
            new shelves_1.ShelfTools(this.client, this.validator, this.logger),
            new users_1.UserTools(this.client, this.validator, this.logger),
            new roles_1.RoleTools(this.client, this.validator, this.logger),
            new attachments_1.AttachmentTools(this.client, this.validator, this.logger),
            new images_1.ImageTools(this.client, this.validator, this.logger),
            new search_1.SearchTools(this.client, this.validator, this.logger),
            new recyclebin_1.RecycleBinTools(this.client, this.validator, this.logger),
            new permissions_1.PermissionTools(this.client, this.validator, this.logger),
            new audit_1.AuditTools(this.client, this.validator, this.logger),
            new system_1.SystemTools(this.client, this.validator, this.logger),
            new server_info_1.ServerInfoTools(this.logger, this.tools, this.resources),
        ];
        // Register all tools
        toolClasses.forEach((toolClass) => {
            toolClass.getTools().forEach((tool) => {
                this.tools.set(tool.name, tool);
            });
        });
        this.logger.info(`Registered ${this.tools.size} tools`);
    }
    /**
     * Setup all resources for BookStack content access
     */
    setupResources() {
        const resourceClasses = [
            new books_2.BookResources(this.client, this.logger),
            new pages_2.PageResources(this.client, this.logger),
            new chapters_2.ChapterResources(this.client, this.logger),
            new shelves_2.ShelfResources(this.client, this.logger),
            new users_2.UserResources(this.client, this.logger),
            new search_2.SearchResources(this.client, this.logger),
        ];
        // Register all resources
        resourceClasses.forEach((resourceClass) => {
            resourceClass.getResources().forEach((resource) => {
                this.resources.set(resource.uri, resource);
            });
        });
        this.logger.info(`Registered ${this.resources.size} resources`);
    }
    /**
     * Setup MCP server request handlers
     */
    setupHandlers() {
        // List tools handler
        this.server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
            const tools = Array.from(this.tools.values()).map(tool => {
                let enhancedDescription = tool.description;
                // Append usage patterns
                if (tool.usage_patterns && tool.usage_patterns.length > 0) {
                    enhancedDescription += '\n\nUsage Patterns:\n' + tool.usage_patterns.map(p => `- ${p}`).join('\n');
                }
                // Append examples
                if (tool.examples && tool.examples.length > 0) {
                    enhancedDescription += '\n\nExamples:\n' + tool.examples.map(e => `- ${e.description}\n  Input: ${JSON.stringify(e.input)}`).join('\n');
                }
                return {
                    name: tool.name,
                    description: enhancedDescription,
                    inputSchema: tool.inputSchema,
                };
            });
            this.logger.debug(`Listed ${tools.length} tools`);
            return { tools };
        });
        // Call tool handler
        this.server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            this.logger.info(`Tool called: ${name}`, { arguments: args });
            const tool = this.tools.get(name);
            if (!tool) {
                throw new Error(`Unknown tool: ${name}`);
            }
            try {
                const result = await tool.handler(args || {});
                this.logger.info(`Tool ${name} completed successfully`);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify(result, null, 2),
                        }],
                };
            }
            catch (error) {
                this.logger.error(`Tool ${name} failed`, { error: error.message, stack: error.stack });
                throw this.errorHandler.handleError(error);
            }
        });
        // List resources handler
        this.server.setRequestHandler(types_js_1.ListResourcesRequestSchema, async () => {
            const resources = Array.from(this.resources.values()).map(resource => ({
                uri: resource.uri,
                name: resource.name,
                description: resource.description,
                mimeType: resource.mimeType,
            }));
            this.logger.debug(`Listed ${resources.length} resources`);
            return { resources };
        });
        // Read resource handler
        this.server.setRequestHandler(types_js_1.ReadResourceRequestSchema, async (request) => {
            const { uri } = request.params;
            this.logger.info(`Resource requested: ${uri}`);
            // Find matching resource by URI pattern
            let matchedResource;
            let _uriMatch;
            for (const [pattern, resource] of this.resources.entries()) {
                if (pattern.includes('{')) {
                    // Dynamic URI pattern
                    const regexPattern = pattern.replace(/\{[^}]+\}/g, '([^/]+)');
                    const regex = new RegExp(`^${regexPattern}$`);
                    if (regex.test(uri)) {
                        matchedResource = resource;
                        _uriMatch = regex;
                        break;
                    }
                }
                else if (pattern === uri) {
                    // Exact match
                    matchedResource = resource;
                    break;
                }
            }
            if (!matchedResource) {
                throw new Error(`Unknown resource: ${uri}`);
            }
            try {
                const result = await matchedResource.handler(uri);
                this.logger.info(`Resource ${uri} read successfully`);
                return {
                    contents: [{
                            uri,
                            mimeType: matchedResource.mimeType,
                            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                        }],
                };
            }
            catch (error) {
                this.logger.error(`Resource ${uri} failed`, { error: error.message, stack: error.stack });
                throw this.errorHandler.handleError(error);
            }
        });
    }
    /**
     * Connect to a transport
     */
    async connect(transport) {
        await this.server.connect(transport);
    }
    /**
     * Shutdown the server gracefully
     */
    async shutdown() {
        this.logger.info('Shutting down BookStack MCP Server...');
        try {
            await this.server.close();
            this.logger.info('Server shutdown complete');
        }
        catch (error) {
            this.logger.error('Error during shutdown', error);
        }
    }
    /**
     * Get server health status
     */
    async getHealth() {
        const checks = [
            {
                name: 'bookstack_connection',
                healthy: await this.client.healthCheck(),
                message: 'BookStack API connection',
            },
            {
                name: 'tools_loaded',
                healthy: this.tools.size > 0,
                message: `${this.tools.size} tools loaded`,
            },
            {
                name: 'resources_loaded',
                healthy: this.resources.size > 0,
                message: `${this.resources.size} resources loaded`,
            },
        ];
        const status = checks.every(check => check.healthy) ? 'healthy' : 'unhealthy';
        return { status, checks };
    }
}
exports.BookStackMCPServer = BookStackMCPServer;
// Start server if run directly
if (require.main === module) {
    const transport = process.env.MCP_TRANSPORT || 'http';
    if (transport === 'stdio') {
        const server = new BookStackMCPServer();
        const stdioTransport = new stdio_js_1.StdioServerTransport();
        server.connect(stdioTransport).catch((error) => {
            console.error('Failed to start server:', error);
            process.exit(1);
        });
        console.error('BookStack MCP Server started and listening on stdio');
        // Handle graceful shutdown
        process.on('SIGINT', () => server.shutdown());
        process.on('SIGTERM', () => server.shutdown());
    }
    else {
        const app = (0, express_1.default)();
        app.use(express_1.default.json());
        const config = manager_1.ConfigManager.getInstance().getConfig();
        app.post('/message', async (req, res) => {
            try {
                // Extract BookStack URL and Token from headers
                const bookstackUrl = req.headers['x-bookstack-url'];
                const bookstackToken = req.headers['x-bookstack-token'];
                const configOverrides = {
                    bookstack: {
                        baseUrl: bookstackUrl || config.bookstack.baseUrl,
                        apiToken: bookstackToken || config.bookstack.apiToken,
                        timeout: config.bookstack.timeout
                    }
                };
                const server = new BookStackMCPServer(configOverrides);
                const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    enableJsonResponse: true,
                });
                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
            }
            catch (error) {
                console.error('Error handling request:', error);
                if (!res.headersSent) {
                    res.status(500).send('Internal Server Error');
                }
            }
        });
        const port = config.server.port || 3000;
        app.listen(port, () => {
            console.log(`BookStack MCP Server listening on port ${port}`);
        });
    }
}
exports.default = BookStackMCPServer;
//# sourceMappingURL=server.js.map
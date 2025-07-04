#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { BookStackClient } from './api/client';
import { ConfigManager } from './config/manager';
import { Logger } from './utils/logger';
import { ErrorHandler } from './utils/errors';
import { ValidationHandler } from './validation/validator';
import { BookTools } from './tools/books';
import { PageTools } from './tools/pages';
import { ChapterTools } from './tools/chapters';
import { ShelfTools } from './tools/shelves';
import { UserTools } from './tools/users';
import { RoleTools } from './tools/roles';
import { AttachmentTools } from './tools/attachments';
import { ImageTools } from './tools/images';
import { SearchTools } from './tools/search';
import { RecycleBinTools } from './tools/recyclebin';
import { PermissionTools } from './tools/permissions';
import { AuditTools } from './tools/audit';
import { SystemTools } from './tools/system';
import { BookResources } from './resources/books';
import { PageResources } from './resources/pages';
import { ChapterResources } from './resources/chapters';
import { ShelfResources } from './resources/shelves';
import { UserResources } from './resources/users';
import { SearchResources } from './resources/search';
import { MCPTool, MCPResource } from './types';

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
export class BookStackMCPServer {
  private server: Server;
  private client: BookStackClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;
  private validator: ValidationHandler;
  private tools: Map<string, MCPTool> = new Map();
  private resources: Map<string, MCPResource> = new Map();

  constructor() {
    const config = ConfigManager.getInstance().getConfig();
    
    this.logger = Logger.getInstance();
    this.errorHandler = new ErrorHandler(this.logger);
    this.validator = new ValidationHandler(config.validation);
    this.client = new BookStackClient(config, this.logger, this.errorHandler);

    // Initialize MCP server
    this.server = new Server({
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
  private setupTools(): void {
    const toolClasses = [
      new BookTools(this.client, this.validator, this.logger),
      new PageTools(this.client, this.validator, this.logger),
      new ChapterTools(this.client, this.validator, this.logger),
      new ShelfTools(this.client, this.validator, this.logger),
      new UserTools(this.client, this.validator, this.logger),
      new RoleTools(this.client, this.validator, this.logger),
      new AttachmentTools(this.client, this.validator, this.logger),
      new ImageTools(this.client, this.validator, this.logger),
      new SearchTools(this.client, this.validator, this.logger),
      new RecycleBinTools(this.client, this.validator, this.logger),
      new PermissionTools(this.client, this.validator, this.logger),
      new AuditTools(this.client, this.validator, this.logger),
      new SystemTools(this.client, this.validator, this.logger),
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
  private setupResources(): void {
    const resourceClasses = [
      new BookResources(this.client, this.logger),
      new PageResources(this.client, this.logger),
      new ChapterResources(this.client, this.logger),
      new ShelfResources(this.client, this.logger),
      new UserResources(this.client, this.logger),
      new SearchResources(this.client, this.logger),
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
  private setupHandlers(): void {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.tools.values()).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      this.logger.debug(`Listed ${tools.length} tools`);
      return { tools };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
      } catch (error) {
        this.logger.error(`Tool ${name} failed`, { error: (error as Error).message, stack: (error as Error).stack });
        throw this.errorHandler.handleError(error);
      }
    });

    // List resources handler
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
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
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      
      this.logger.info(`Resource requested: ${uri}`);

      // Find matching resource by URI pattern
      let matchedResource: MCPResource | undefined;
      let _uriMatch: RegExp | undefined;

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
        } else if (pattern === uri) {
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
      } catch (error) {
        this.logger.error(`Resource ${uri} failed`, { error: (error as Error).message, stack: (error as Error).stack });
        throw this.errorHandler.handleError(error);
      }
    });
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    this.logger.info('BookStack MCP Server started and listening on stdio');

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * Shutdown the server gracefully
   */
  private async shutdown(): Promise<void> {
    this.logger.info('Shutting down BookStack MCP Server...');
    
    try {
      await this.server.close();
      this.logger.info('Server shutdown complete');
      process.exit(0);
    } catch (error) {
      this.logger.error('Error during shutdown', error);
      process.exit(1);
    }
  }

  /**
   * Get server health status
   */
  async getHealth(): Promise<{
    status: 'healthy' | 'unhealthy';
    checks: Array<{ name: string; healthy: boolean; message?: string }>;
  }> {
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

// Start server if run directly
if (require.main === module) {
  const server = new BookStackMCPServer();
  server.start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

export default BookStackMCPServer;
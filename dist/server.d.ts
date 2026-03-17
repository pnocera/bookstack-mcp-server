#!/usr/bin/env node
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Config } from './config/manager';
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
export declare class BookStackMCPServer {
    private server;
    private client;
    private logger;
    private errorHandler;
    private validator;
    private tools;
    private resources;
    constructor(configOverrides?: Partial<Config>);
    /**
     * Setup all tools for BookStack API endpoints
     */
    private setupTools;
    /**
     * Setup all resources for BookStack content access
     */
    private setupResources;
    /**
     * Setup MCP server request handlers
     */
    private setupHandlers;
    /**
     * Connect to a transport
     */
    connect(transport: Transport): Promise<void>;
    /**
     * Shutdown the server gracefully
     */
    shutdown(): Promise<void>;
    /**
     * Get server health status
     */
    getHealth(): Promise<{
        status: 'healthy' | 'unhealthy';
        checks: Array<{
            name: string;
            healthy: boolean;
            message?: string;
        }>;
    }>;
}
export default BookStackMCPServer;
//# sourceMappingURL=server.d.ts.map
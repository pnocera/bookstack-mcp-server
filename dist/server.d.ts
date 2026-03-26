#!/usr/bin/env node
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Config } from './config/manager';
/**
 * BookStack MCP Server
 *
 * Provides access to BookStack knowledge management system
 * through the Model Context Protocol (MCP).
 *
 * When PUBLIC_READ_ONLY=true (default), only read-only tools are exposed
 * and per-request credential header overrides are rejected.
 */
export declare class BookStackMCPServer {
    private server;
    private client;
    private logger;
    private errorHandler;
    private validator;
    private tools;
    private resources;
    private config;
    constructor(configOverrides?: Partial<Config>);
    /**
     * Setup tools. When publicReadOnly is true, only tools in READ_ONLY_TOOL_ALLOWLIST
     * are registered. Classes that provide no read-only tools are not instantiated.
     */
    private setupTools;
    /**
     * Setup resources. When publicReadOnly is true, UserResources are excluded.
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
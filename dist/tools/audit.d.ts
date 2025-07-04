import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Audit log tools for BookStack MCP Server
 *
 * Provides 1 tool for audit log management:
 * - List audit log entries
 */
export declare class AuditTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all audit tools
     */
    getTools(): MCPTool[];
    /**
     * List audit log tool
     */
    private createListAuditLogTool;
}
//# sourceMappingURL=audit.d.ts.map
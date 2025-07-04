import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Permission management tools for BookStack MCP Server
 *
 * Provides 2 tools for content permission management:
 * - Read and update content permissions
 */
export declare class PermissionTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all permission tools
     */
    getTools(): MCPTool[];
    /**
     * Read permissions tool
     */
    private createReadPermissionsTool;
    /**
     * Update permissions tool
     */
    private createUpdatePermissionsTool;
}
//# sourceMappingURL=permissions.d.ts.map
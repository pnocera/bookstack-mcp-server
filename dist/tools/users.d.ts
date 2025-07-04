import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * User management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete user lifecycle management:
 * - List, create, read, update, and delete users
 */
export declare class UserTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all user tools
     */
    getTools(): MCPTool[];
    /**
     * List users tool
     */
    private createListUsersTool;
    /**
     * Create user tool
     */
    private createCreateUserTool;
    /**
     * Read user tool
     */
    private createReadUserTool;
    /**
     * Update user tool
     */
    private createUpdateUserTool;
    /**
     * Delete user tool
     */
    private createDeleteUserTool;
}
//# sourceMappingURL=users.d.ts.map
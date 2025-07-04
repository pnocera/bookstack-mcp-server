import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Role management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete role lifecycle management:
 * - List, create, read, update, and delete roles
 */
export declare class RoleTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all role tools
     */
    getTools(): MCPTool[];
    /**
     * List roles tool
     */
    private createListRolesTool;
    /**
     * Create role tool
     */
    private createCreateRoleTool;
    /**
     * Read role tool
     */
    private createReadRoleTool;
    /**
     * Update role tool
     */
    private createUpdateRoleTool;
    /**
     * Delete role tool
     */
    private createDeleteRoleTool;
}
//# sourceMappingURL=roles.d.ts.map
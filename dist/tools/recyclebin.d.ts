import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Recycle bin management tools for BookStack MCP Server
 *
 * Provides 3 tools for recycle bin operations:
 * - List, restore, and permanently delete items
 */
export declare class RecycleBinTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all recycle bin tools
     */
    getTools(): MCPTool[];
    /**
     * List recycle bin tool
     */
    private createListRecycleBinTool;
    /**
     * Restore from recycle bin tool
     */
    private createRestoreFromRecycleBinTool;
    /**
     * Permanently delete tool
     */
    private createPermanentlyDeleteTool;
}
//# sourceMappingURL=recyclebin.d.ts.map
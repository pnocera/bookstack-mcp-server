import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Bookshelf management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete bookshelf lifecycle management:
 * - List, create, read, update, and delete bookshelves
 */
export declare class ShelfTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all shelf tools
     */
    getTools(): MCPTool[];
    /**
     * List shelves tool
     */
    private createListShelvesTool;
    /**
     * Create shelf tool
     */
    private createCreateShelfTool;
    /**
     * Read shelf tool
     */
    private createReadShelfTool;
    /**
     * Update shelf tool
     */
    private createUpdateShelfTool;
    /**
     * Delete shelf tool
     */
    private createDeleteShelfTool;
}
//# sourceMappingURL=shelves.d.ts.map
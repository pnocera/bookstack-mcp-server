import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Book management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete book lifecycle management:
 * - List, create, read, update, delete, and export books
 */
export declare class BookTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all book tools
     */
    getTools(): MCPTool[];
    /**
     * List books tool
     */
    private createListBooksTools;
    /**
     * Create book tool
     */
    private createCreateBookTool;
    /**
     * Read book tool
     */
    private createReadBookTool;
    /**
     * Update book tool
     */
    private createUpdateBookTool;
    /**
     * Delete book tool
     */
    private createDeleteBookTool;
    /**
     * Export book tool
     */
    private createExportBookTool;
}
export default BookTools;
//# sourceMappingURL=books.d.ts.map
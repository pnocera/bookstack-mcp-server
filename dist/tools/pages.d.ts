import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Page management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete page lifecycle management:
 * - List, create, read, update, delete, and export pages
 */
export declare class PageTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all page tools
     */
    getTools(): MCPTool[];
    /**
     * List pages tool
     */
    private createListPagesTools;
    /**
     * Create page tool
     */
    private createCreatePageTool;
    /**
     * Read page tool
     */
    private createReadPageTool;
    /**
     * Update page tool
     */
    private createUpdatePageTool;
    /**
     * Delete page tool
     */
    private createDeletePageTool;
    /**
     * Export page tool
     */
    private createExportPageTool;
}
export default PageTools;
//# sourceMappingURL=pages.d.ts.map
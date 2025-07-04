import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Search tools for BookStack MCP Server
 *
 * Provides comprehensive search functionality across all content types
 */
export declare class SearchTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all search tools
     */
    getTools(): MCPTool[];
    /**
     * Search tool
     */
    private createSearchTool;
}
export default SearchTools;
//# sourceMappingURL=search.d.ts.map
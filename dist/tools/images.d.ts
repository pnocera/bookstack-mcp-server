import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Image management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete image lifecycle management:
 * - List, create, read, update, and delete images
 */
export declare class ImageTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all image tools
     */
    getTools(): MCPTool[];
    /**
     * List images tool
     */
    private createListImagesTool;
    /**
     * Create image tool
     */
    private createCreateImageTool;
    /**
     * Read image tool
     */
    private createReadImageTool;
    /**
     * Update image tool
     */
    private createUpdateImageTool;
    /**
     * Delete image tool
     */
    private createDeleteImageTool;
}
//# sourceMappingURL=images.d.ts.map
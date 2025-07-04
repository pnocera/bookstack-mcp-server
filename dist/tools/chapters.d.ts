import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Chapter management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete chapter lifecycle management:
 * - List, create, read, update, delete, and export chapters
 */
export declare class ChapterTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all chapter tools
     */
    getTools(): MCPTool[];
    /**
     * List chapters tool
     */
    private createListChaptersTool;
    /**
     * Create chapter tool
     */
    private createCreateChapterTool;
    /**
     * Read chapter tool
     */
    private createReadChapterTool;
    /**
     * Update chapter tool
     */
    private createUpdateChapterTool;
    /**
     * Delete chapter tool
     */
    private createDeleteChapterTool;
    /**
     * Export chapter tool
     */
    private createExportChapterTool;
}
//# sourceMappingURL=chapters.d.ts.map
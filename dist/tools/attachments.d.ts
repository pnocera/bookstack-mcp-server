import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Attachment management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete attachment lifecycle management:
 * - List, create, read, update, and delete attachments
 */
export declare class AttachmentTools {
    private client;
    private validator;
    private logger;
    constructor(client: BookStackClient, validator: ValidationHandler, logger: Logger);
    /**
     * Get all attachment tools
     */
    getTools(): MCPTool[];
    /**
     * List attachments tool
     */
    private createListAttachmentsTool;
    /**
     * Create attachment tool
     */
    private createCreateAttachmentTool;
    /**
     * Read attachment tool
     */
    private createReadAttachmentTool;
    /**
     * Update attachment tool
     */
    private createUpdateAttachmentTool;
    /**
     * Delete attachment tool
     */
    private createDeleteAttachmentTool;
}
//# sourceMappingURL=attachments.d.ts.map
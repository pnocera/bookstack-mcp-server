import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Server Information Tools for MCP Self-Description
 *
 * Provides comprehensive server information to help LLMs understand
 * capabilities, usage patterns, and proper tool interaction.
 */
export declare class ServerInfoTools {
    private logger;
    private toolsMap;
    private resourcesMap;
    constructor(logger: Logger, toolsMap: Map<string, MCPTool>, resourcesMap: Map<string, any>);
    /**
     * Get all server info tools
     */
    getTools(): MCPTool[];
    /**
     * Main server information tool
     */
    private createServerInfoTool;
    /**
     * Tool categories information
     */
    private createToolCategoriesTool;
    /**
     * Usage examples tool
     */
    private createUsageExamplesTool;
    /**
     * Error handling guide tool
     */
    private createErrorGuidesTool;
    /**
     * Interactive help tool
     */
    private createHelpTool;
    /**
     * Get tool categories with detailed information
     */
    private getToolCategories;
    /**
     * Get resource types information
     */
    private getResourceTypes;
    /**
     * Get usage examples for common workflows
     */
    private getUsageExamples;
    /**
     * Get error handling information
     */
    private getErrorHandlingInfo;
    /**
     * Get help content for different topics
     */
    private getHelpContent;
    /**
     * Get contextual advice based on user input
     */
    private getContextualAdvice;
}
//# sourceMappingURL=server-info.d.ts.map
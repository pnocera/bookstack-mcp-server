import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * System tools for BookStack MCP Server
 *
 * Provides system information and health check functionality
 */
export declare class SystemTools {
    private client;
    private _validator;
    private logger;
    constructor(client: BookStackClient, _validator: ValidationHandler, logger: Logger);
    /**
     * Get all system tools
     */
    getTools(): MCPTool[];
    /**
     * System information tool
     */
    private createSystemInfoTool;
}
export default SystemTools;
//# sourceMappingURL=system.d.ts.map
import { AxiosError } from 'axios';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from './logger';
/**
 * Error handler for BookStack MCP Server
 */
export declare class ErrorHandler {
    private logger;
    private errorMappings;
    constructor(logger: Logger);
    /**
     * Handle Axios errors specifically
     */
    handleAxiosError(error: AxiosError): McpError;
    /**
     * Handle generic errors
     */
    handleError(error: any): McpError;
    /**
     * Map HTTP status codes to MCP error codes
     */
    private mapToMCPErrorCode;
    /**
     * Check if error is retryable
     */
    isRetryable(error: any): boolean;
    /**
     * Create a user-friendly error message
     */
    getUserFriendlyMessage(error: any): string;
}
export default ErrorHandler;
//# sourceMappingURL=errors.d.ts.map
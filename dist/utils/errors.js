"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorHandler = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
/**
 * Error handler for BookStack MCP Server
 */
class ErrorHandler {
    constructor(logger) {
        this.logger = logger;
        this.errorMappings = {
            400: { type: 'validation_error', message: 'Invalid request parameters' },
            401: { type: 'authentication_error', message: 'Invalid or missing authentication token' },
            403: { type: 'permission_error', message: 'Insufficient permissions for this operation' },
            404: { type: 'not_found_error', message: 'Requested resource not found' },
            422: { type: 'validation_error', message: 'Validation failed' },
            429: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
            500: { type: 'server_error', message: 'Internal server error' },
            502: { type: 'server_error', message: 'Bad gateway' },
            503: { type: 'server_error', message: 'Service unavailable' },
            504: { type: 'server_error', message: 'Gateway timeout' },
        };
    }
    /**
     * Handle Axios errors specifically
     */
    handleAxiosError(error) {
        const status = error.response?.status;
        const mapping = this.errorMappings[status] || {
            type: 'unknown_error',
            message: 'Unknown error occurred'
        };
        const mcpError = new types_js_1.McpError(this.mapToMCPErrorCode(status), mapping.message, {
            type: mapping.type,
            status,
            details: error.response?.data,
            url: error.config?.url,
            method: error.config?.method?.toUpperCase(),
        });
        this.logger.error('Axios error handled', {
            status,
            type: mapping.type,
            url: error.config?.url,
            method: error.config?.method,
            message: error.message,
        });
        return mcpError;
    }
    /**
     * Handle generic errors
     */
    handleError(error) {
        if (error instanceof types_js_1.McpError) {
            return error;
        }
        if (error.isAxiosError) {
            return this.handleAxiosError(error);
        }
        // Handle validation errors from Zod
        if (error.name === 'ZodError') {
            const validationDetails = error.errors.map((err) => ({
                field: err.path.join('.'),
                message: err.message,
            }));
            return new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, 'Validation failed', {
                type: 'validation_error',
                validation: validationDetails,
            });
        }
        // Handle generic errors
        const mcpError = new types_js_1.McpError(types_js_1.ErrorCode.InternalError, error.message || 'An unexpected error occurred', {
            type: 'internal_error',
            stack: error.stack,
        });
        this.logger.error('Generic error handled', {
            message: error.message,
            stack: error.stack,
            name: error.name,
        });
        return mcpError;
    }
    /**
     * Map HTTP status codes to MCP error codes
     */
    mapToMCPErrorCode(status) {
        switch (status) {
            case 400:
            case 422:
                return types_js_1.ErrorCode.InvalidParams;
            case 401:
                return types_js_1.ErrorCode.InvalidRequest;
            case 403:
                return types_js_1.ErrorCode.InvalidRequest;
            case 404:
                return types_js_1.ErrorCode.InvalidRequest;
            case 429:
                return types_js_1.ErrorCode.InternalError;
            case 500:
            case 502:
            case 503:
            case 504:
                return types_js_1.ErrorCode.InternalError;
            default:
                return types_js_1.ErrorCode.InternalError;
        }
    }
    /**
     * Check if error is retryable
     */
    isRetryable(error) {
        if (error.isAxiosError) {
            const status = error.response?.status;
            return [429, 500, 502, 503, 504].includes(status);
        }
        return false;
    }
    /**
     * Create a user-friendly error message
     */
    getUserFriendlyMessage(error) {
        if (error instanceof types_js_1.McpError) {
            return error.message;
        }
        if (error.isAxiosError) {
            const status = error.response?.status;
            const mapping = this.errorMappings[status];
            return mapping?.message || 'An error occurred while communicating with BookStack';
        }
        return 'An unexpected error occurred';
    }
}
exports.ErrorHandler = ErrorHandler;
exports.default = ErrorHandler;
//# sourceMappingURL=errors.js.map
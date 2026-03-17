"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SystemTools = void 0;
/**
 * System tools for BookStack MCP Server
 *
 * Provides system information and health check functionality
 */
class SystemTools {
    constructor(client, _validator, logger) {
        this.client = client;
        this._validator = _validator;
        this.logger = logger;
    }
    /**
     * Get all system tools
     */
    getTools() {
        return [
            this.createSystemInfoTool(),
        ];
    }
    /**
     * System information tool
     */
    createSystemInfoTool() {
        return {
            name: 'bookstack_system_info',
            description: 'Get information about the BookStack instance, including version, base URL, and configuration limits.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            examples: [
                {
                    description: 'Check system info',
                    input: {},
                    expected_output: 'System info object',
                    use_case: 'Verifying compatibility',
                }
            ],
            usage_patterns: [
                'Call on startup to verify connection and version',
            ],
            handler: async (_params) => {
                this.logger.debug('Getting system information');
                return await this.client.getSystemInfo();
            },
        };
    }
}
exports.SystemTools = SystemTools;
exports.default = SystemTools;
//# sourceMappingURL=system.js.map
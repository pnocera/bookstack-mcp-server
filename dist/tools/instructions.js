"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstructionsTools = void 0;
const manager_1 = require("../config/manager");
/**
 * Instructions Tool
 *
 * Exposes the SERVER_INSTRUCTIONS environment variable as an explicitly
 * callable MCP tool so that clients can actively fetch the mandatory server
 * behaviour rules, independent of whether they honour the `instructions` field
 * in the JSON-RPC `initialize` response.
 */
class InstructionsTools {
    constructor(logger) {
        this.logger = logger;
    }
    getTools() {
        return [this.createInstructionsTool()];
    }
    createInstructionsTool() {
        return {
            name: 'bookstack_instructions',
            description: 'Returns the mandatory server instructions for this BookStack MCP server. ' +
                'Call this FIRST, before any other tool, to learn the required behaviour ' +
                'and conventions for this instance.',
            category: 'meta',
            inputSchema: { type: 'object', properties: {} },
            usage_patterns: [
                'Call this first when connecting, before answering or using other tools.',
                'Re-call if you are unsure about server-specific rules or conventions.',
            ],
            examples: [
                {
                    description: 'Read the mandatory server instructions',
                    input: {},
                    use_case: 'Initial discovery / mandatory onboarding',
                },
            ],
            handler: async (_params) => {
                const instructions = manager_1.ConfigManager.getInstance().getConfig().server.instructions;
                this.logger.debug('bookstack_instructions called', { set: !!instructions });
                if (!instructions) {
                    return 'No server instructions are configured. Set the SERVER_INSTRUCTIONS environment variable to provide them.';
                }
                return instructions;
            },
        };
    }
}
exports.InstructionsTools = InstructionsTools;
//# sourceMappingURL=instructions.js.map
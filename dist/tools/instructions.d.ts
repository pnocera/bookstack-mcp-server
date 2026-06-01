import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
/**
 * Instructions Tool
 *
 * Exposes the SERVER_INSTRUCTIONS environment variable as an explicitly
 * callable MCP tool so that clients can actively fetch the mandatory server
 * behaviour rules, independent of whether they honour the `instructions` field
 * in the JSON-RPC `initialize` response.
 */
export declare class InstructionsTools {
    private logger;
    constructor(logger: Logger);
    getTools(): MCPTool[];
    private createInstructionsTool;
}
//# sourceMappingURL=instructions.d.ts.map
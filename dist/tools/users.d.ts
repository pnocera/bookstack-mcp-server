import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
export declare class UserTools {
    private client;
    private _validator;
    private _logger;
    constructor(client: BookStackClient, _validator: ValidationHandler, _logger: Logger);
    getTools(): MCPTool[];
}
//# sourceMappingURL=users.d.ts.map
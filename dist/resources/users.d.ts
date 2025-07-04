import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';
export declare class UserResources {
    private client;
    private _logger;
    constructor(client: BookStackClient, _logger: Logger);
    getResources(): MCPResource[];
}
//# sourceMappingURL=users.d.ts.map
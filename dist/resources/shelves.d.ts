import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';
export declare class ShelfResources {
    private client;
    private _logger;
    constructor(client: BookStackClient, _logger: Logger);
    getResources(): MCPResource[];
}
//# sourceMappingURL=shelves.d.ts.map
import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';
export declare class PageResources {
    private client;
    private _logger;
    constructor(client: BookStackClient, _logger: Logger);
    getResources(): MCPResource[];
}
//# sourceMappingURL=pages.d.ts.map
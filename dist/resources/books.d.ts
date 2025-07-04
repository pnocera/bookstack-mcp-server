import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';
export declare class BookResources {
    private client;
    private logger;
    constructor(client: BookStackClient, logger: Logger);
    getResources(): MCPResource[];
}
//# sourceMappingURL=books.d.ts.map
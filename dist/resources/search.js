"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchResources = void 0;
class SearchResources {
    constructor(client, _logger) {
        this.client = client;
        this._logger = _logger;
    }
    getResources() {
        return [
            {
                uri: 'bookstack://search/{query}',
                name: 'Search',
                description: 'Search results for a specific query',
                mimeType: 'application/json',
                handler: async (uri) => {
                    const match = uri.match(/^bookstack:\/\/search\/(.+)$/);
                    if (!match)
                        throw new Error('Invalid search resource URI');
                    const query = decodeURIComponent(match[1]);
                    return await this.client.search({ query });
                },
            },
        ];
    }
}
exports.SearchResources = SearchResources;
//# sourceMappingURL=search.js.map
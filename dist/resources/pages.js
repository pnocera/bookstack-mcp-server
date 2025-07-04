"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PageResources = void 0;
class PageResources {
    constructor(client, _logger) {
        this.client = client;
        this._logger = _logger;
    }
    getResources() {
        return [
            {
                uri: 'bookstack://pages',
                name: 'Pages',
                description: 'All pages in the BookStack instance',
                mimeType: 'application/json',
                handler: async (uri) => await this.client.listPages(),
            },
            {
                uri: 'bookstack://pages/{id}',
                name: 'Page',
                description: 'Specific page with full content',
                mimeType: 'application/json',
                handler: async (uri) => {
                    const match = uri.match(/^bookstack:\/\/pages\/(\d+)$/);
                    if (!match)
                        throw new Error('Invalid page resource URI');
                    const id = parseInt(match[1]);
                    return await this.client.getPage(id);
                },
            },
        ];
    }
}
exports.PageResources = PageResources;
//# sourceMappingURL=pages.js.map
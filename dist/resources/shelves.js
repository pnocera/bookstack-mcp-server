"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShelfResources = void 0;
class ShelfResources {
    constructor(client, _logger) {
        this.client = client;
        this._logger = _logger;
    }
    getResources() {
        return [
            {
                uri: 'bookstack://shelves',
                name: 'Shelves',
                description: 'All bookshelves in the BookStack instance',
                mimeType: 'application/json',
                handler: async (uri) => await this.client.listShelves(),
            },
            {
                uri: 'bookstack://shelves/{id}',
                name: 'Shelf',
                description: 'Specific bookshelf with books',
                mimeType: 'application/json',
                handler: async (uri) => {
                    const match = uri.match(/^bookstack:\/\/shelves\/(\d+)$/);
                    if (!match)
                        throw new Error('Invalid shelf resource URI');
                    const id = parseInt(match[1]);
                    return await this.client.getShelf(id);
                },
            },
        ];
    }
}
exports.ShelfResources = ShelfResources;
//# sourceMappingURL=shelves.js.map
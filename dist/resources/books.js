"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookResources = void 0;
class BookResources {
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;
    }
    getResources() {
        return [
            {
                uri: 'bookstack://books',
                name: 'Books',
                description: 'All books in the BookStack instance',
                mimeType: 'application/json',
                handler: async (_uri) => {
                    this.logger.debug('Fetching books resource');
                    return await this.client.listBooks();
                },
            },
            {
                uri: 'bookstack://books/{id}',
                name: 'Book',
                description: 'Specific book with full content hierarchy',
                mimeType: 'application/json',
                handler: async (uri) => {
                    const match = uri.match(/^bookstack:\/\/books\/(\d+)$/);
                    if (!match)
                        throw new Error('Invalid book resource URI');
                    const id = parseInt(match[1]);
                    this.logger.debug('Fetching book resource', { id });
                    return await this.client.getBook(id);
                },
            },
        ];
    }
}
exports.BookResources = BookResources;
//# sourceMappingURL=books.js.map
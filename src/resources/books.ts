import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';

export class BookResources {
  constructor(
    private client: BookStackClient,
    private logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://books',
        name: 'Books',
        description: 'All books in the BookStack instance',
        mimeType: 'application/json',
        handler: async (_uri: string) => {
          this.logger.debug('Fetching books resource');
          return await this.client.listBooks();
        },
      },
      {
        uri: 'bookstack://books/{id}',
        name: 'Book',
        description: 'Specific book with full content hierarchy',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/books\/(\d+)$/);
          if (!match) throw new Error('Invalid book resource URI');
          const id = parseInt(match[1]);
          this.logger.debug('Fetching book resource', { id });
          return await this.client.getBook(id);
        },
      },
    ];
  }
}
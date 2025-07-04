import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';

export class ShelfResources {
  constructor(
    private client: BookStackClient,
    private _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://shelves',
        name: 'Shelves',
        description: 'All bookshelves in the BookStack instance',
        mimeType: 'application/json',
        handler: async (uri: string) => await this.client.listShelves(),
      },
      {
        uri: 'bookstack://shelves/{id}',
        name: 'Shelf',
        description: 'Specific bookshelf with books',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/shelves\/(\d+)$/);
          if (!match) throw new Error('Invalid shelf resource URI');
          const id = parseInt(match[1]);
          return await this.client.getShelf(id);
        },
      },
    ];
  }
}
import type { BookStackClient } from '../api/client';
import type { MCPResource } from '../types';
import type { Logger } from '../utils/logger';

export class ShelfResources {
  constructor(
    private client: BookStackClient,
    _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://shelves',
        name: 'Shelves',
        description:
          "Bookshelves visible to the authenticated user, as a flat list. Returns BookStack's first page of results (100 shelves by default), not the whole instance, and each entry carries shelf metadata only - the books on each shelf are not included. Takes no parameters; use the bookstack_shelves_list tool to paginate or filter.",
        mimeType: 'application/json',
        handler: async (_uri: string) => await this.client.listShelves(),
      },
      {
        uri: 'bookstack://shelves/{id}',
        name: 'Shelf',
        description:
          'A single bookshelf, including its tags and a `books` array holding the full record of each book on the shelf, in shelf order. {id} must be a numeric shelf ID.',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/shelves\/(\d+)$/);
          if (!match) throw new Error('Invalid shelf resource URI');
          const id = parseInt(match[1], 10);
          return await this.client.getShelf(id);
        },
      },
    ];
  }
}

import type { BookStackClient } from '../api/client';
import type { MCPResource } from '../types';
import type { Logger } from '../utils/logger';

export class SearchResources {
  constructor(
    private client: BookStackClient,
    _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://search/{query}',
        name: 'Search',
        description:
          'Results of a search across shelves, books, chapters and pages. {query} is a URL-encoded BookStack search string and must not contain an unencoded "/". It supports the same syntax as the bookstack_search tool - "exact phrase", [tag=value], {type:page|book|chapter|bookshelf}, {created_by:me} - and returns BookStack\'s first page of results, page bodies excluded. Use the bookstack_search tool when you need paging.',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/search\/(.+)$/);
          if (!match) throw new Error('Invalid search resource URI');
          const query = decodeURIComponent(match[1]);
          return await this.client.search({ query });
        },
      },
    ];
  }
}

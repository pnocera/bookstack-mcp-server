import type { BookStackClient } from '../api/client';
import type { MCPResource } from '../types';
import type { Logger } from '../utils/logger';

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
        description:
          "Books visible to the authenticated user, as a flat list of book records with their metadata. Returns BookStack's first page of results (100 books by default) - it is not a complete dump of a larger instance, and it carries no chapters or pages. Takes no parameters; use the bookstack_books_list tool to paginate or filter, and bookstack://books/{id} for a book's contents.",
        mimeType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  description: { type: 'string' },
                  created_at: { type: 'string', format: 'date-time' },
                  updated_at: { type: 'string', format: 'date-time' },
                },
              },
            },
            total: { type: 'number' },
          },
        },
        examples: [
          {
            uri: 'bookstack://books',
            description: "Get BookStack's first page of books",
            expected_format: 'JSON object with a data array of book objects and a total count',
            use_case: 'Understanding available documentation structure',
          },
        ],
        access_patterns: [
          'Use for initial discovery of available content',
          'Compare `total` against the length of `data` to tell whether the instance holds more books than this resource returned',
          'Use the bookstack_books_list tool when you need pagination, filtering or sorting',
        ],
        handler: async (_uri: string) => {
          this.logger.debug('Fetching books resource');
          return await this.client.listBooks();
        },
      },
      {
        uri: 'bookstack://books/{id}',
        name: 'Book',
        description:
          "A single book, including tags and a `contents` array giving its structure: every chapter (with its pages nested inside) and every page sitting directly in the book. `contents` lists names, ids and URLs only - it does not carry page bodies, so read bookstack://pages/{id} for a page's actual content. {id} must be a numeric book ID.",
        mimeType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            slug: { type: 'string' },
            description: { type: 'string' },
            contents: {
              type: 'array',
              items: {
                oneOf: [
                  { type: 'object', properties: { type: { const: 'chapter' } } },
                  { type: 'object', properties: { type: { const: 'page' } } },
                ],
              },
            },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            tags: { type: 'array', items: { type: 'object' } },
          },
        },
        examples: [
          {
            uri: 'bookstack://books/123',
            description: 'Get book 123 with its chapter/page structure',
            expected_format: 'JSON object with book metadata and a contents array',
            use_case: 'Reading complete documentation structure',
          },
        ],
        access_patterns: [
          'Use after finding book ID from books list',
          'Reference for understanding book organization',
          'Use before making structural changes',
        ],
        dependencies: ['bookstack://books for discovering book IDs'],
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/books\/(\d+)$/);
          if (!match) throw new Error('Invalid book resource URI');
          const id = parseInt(match[1], 10);
          this.logger.debug('Fetching book resource', { id });
          return await this.client.getBook(id);
        },
      },
    ];
  }
}

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
        description: 'All books in the BookStack instance with complete metadata and hierarchical structure',
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
            description: 'Get all books with pagination',
            expected_format: 'JSON array of book objects with metadata',
            use_case: 'Understanding available documentation structure',
          },
        ],
        access_patterns: [
          'Use for initial discovery of available content',
          'Combine with filtering for specific topics',
          'Reference for hierarchical content planning',
        ],
        handler: async (_uri: string) => {
          this.logger.debug('Fetching books resource');
          return await this.client.listBooks();
        },
      },
      {
        uri: 'bookstack://books/{id}',
        name: 'Book',
        description: 'Specific book with full content hierarchy including all chapters and pages',
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
            description: 'Get complete book with all nested content',
            expected_format: 'JSON object with book metadata and contents array',
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
          const id = parseInt(match[1]);
          this.logger.debug('Fetching book resource', { id });
          return await this.client.getBook(id);
        },
      },
    ];
  }
}
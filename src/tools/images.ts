import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

export class ImageTools {
  constructor(
    private client: BookStackClient,
    private _validator: ValidationHandler,
    private _logger: Logger
  ) {}

  getTools(): MCPTool[] {
    return [
      {
        name: 'bookstack_images_list',
        description: 'List all images',
        inputSchema: { type: 'object', properties: {} },
        handler: async (params: any) => this.client.listImages(params),
      },
      // Additional image tools would be implemented here
    ];
  }
}
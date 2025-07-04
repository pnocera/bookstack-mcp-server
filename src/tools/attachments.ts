import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

export class AttachmentTools {
  constructor(
    private client: BookStackClient,
    private _validator: ValidationHandler,
    private _logger: Logger
  ) {}

  getTools(): MCPTool[] {
    return [
      {
        name: 'bookstack_attachments_list',
        description: 'List all attachments',
        inputSchema: { type: 'object', properties: {} },
        handler: async (params: any) => this.client.listAttachments(params),
      },
      // Additional attachment tools would be implemented here
    ];
  }
}
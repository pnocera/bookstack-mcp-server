import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

export class RecycleBinTools {
  constructor(
    private client: BookStackClient,
    private _validator: ValidationHandler,
    private _logger: Logger
  ) {}

  getTools(): MCPTool[] {
    return [
      {
        name: 'bookstack_recycle_bin_list',
        description: 'List deleted items in recycle bin',
        inputSchema: { type: 'object', properties: {} },
        handler: async (params: any) => this.client.listRecycleBin(params),
      },
      // Additional recycle bin tools would be implemented here
    ];
  }
}
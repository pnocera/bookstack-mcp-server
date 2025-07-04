import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

/**
 * System tools for BookStack MCP Server
 * 
 * Provides system information and health check functionality
 */
export class SystemTools {
  constructor(
    private client: BookStackClient,
    private _validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all system tools
   */
  getTools(): MCPTool[] {
    return [
      this.createSystemInfoTool(),
    ];
  }

  /**
   * System information tool
   */
  private createSystemInfoTool(): MCPTool {
    return {
      name: 'bookstack_system_info',
      description: 'Get comprehensive system information about the BookStack instance',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_params: any) => {
        this.logger.debug('Getting system information');
        return await this.client.getSystemInfo();
      },
    };
  }
}

export default SystemTools;
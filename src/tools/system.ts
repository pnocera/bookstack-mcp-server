import type { BookStackClient } from '../api/client';
import { type MCPTool, withClosedSchemas } from '../types';
import type { Logger } from '../utils/logger';
import type { ValidationHandler } from '../validation/validator';

/**
 * System tools for BookStack MCP Server
 *
 * Provides system information and health check functionality
 */
export class SystemTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all system tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([this.createSystemInfoTool()]);
  }

  /**
   * System information tool
   */
  private createSystemInfoTool(): MCPTool {
    return {
      name: 'bookstack_system_info',
      description:
        'Read details about the BookStack instance itself. Returns exactly five fields: version, instance_id, app_name, app_logo and base_url. Takes no parameters. This is instance identity only - it carries no configuration limits, no counts and no health metrics.',
      category: 'system',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      examples: [
        {
          description: 'Check system info',
          input: {},
          expected_output:
            '{ version: "v26.05.2", instance_id: "<uuid>", app_name: "BookStack", app_logo: "https://docs.example.com/logo.png", base_url: "https://docs.example.com" }',
          use_case: 'Verifying compatibility',
        },
      ],
      usage_patterns: [
        'Call on startup to verify connection and version',
        'The version is prefixed with "v" (e.g. "v26.05.2"), so strip it before comparing numerically',
        'app_logo may be null when no custom logo is set',
      ],
      handler: async (params: unknown) => {
        // "Takes no parameters" is enforced, not just documented. Anything sent here was
        // previously accepted and discarded, so a caller who thought they were scoping
        // the request got the whole instance's identity back and no sign of the mistake.
        this.validator.validateParams<Record<string, never>>(params, 'systemInfo');
        this.logger.debug('Getting system information');
        return await this.client.getSystemInfo();
      },
    };
  }
}

export default SystemTools;

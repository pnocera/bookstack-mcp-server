import { ConfigManager } from '../config/manager';
import { Logger } from '../utils/logger';
import { MCPTool, MCPServerInfo, ToolCategory, ResourceType, ServerUsageExample, ErrorHandlingInfo } from '../types';

/**
 * Server Information Tools for MCP Self-Description
 * 
 * Provides comprehensive server information to help LLMs understand
 * capabilities, usage patterns, and proper tool interaction.
 */
export class ServerInfoTools {
  constructor(
    private logger: Logger,
    private toolsMap: Map<string, MCPTool>,
    private resourcesMap: Map<string, any>
  ) {}

  /**
   * Get all server info tools
   */
  getTools(): MCPTool[] {
    return [
      this.createServerInfoTool(),
      this.createToolCategoriesTool(),
      this.createUsageExamplesTool(),
      this.createErrorGuidesTool(),
      this.createHelpTool(),
    ];
  }

  /**
   * Main server information tool
   */
  private createServerInfoTool(): MCPTool {
    return {
      name: 'bookstack_server_info',
      description: 'Get comprehensive server information including capabilities, tools, resources, and usage guidance for LLM interaction',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['all', 'capabilities', 'tools', 'resources', 'examples', 'errors'],
            default: 'all',
            description: 'Which section of server info to retrieve',
          },
        },
      },
      examples: [
        {
          description: 'Get complete server information',
          input: { section: 'all' },
          expected_output: 'Complete server info with all capabilities and guidance',
          use_case: 'Initial LLM connection to understand server capabilities',
        },
        {
          description: 'Get only tool capabilities',
          input: { section: 'tools' },
          expected_output: 'List of all tools with categories and usage patterns',
          use_case: 'Understanding available operations before task execution',
        },
      ],
      usage_patterns: [
        'Call at beginning of session to understand server capabilities',
        'Use before complex workflows to plan tool usage',
        'Reference when encountering errors for debugging guidance',
      ],
      error_codes: [
        {
          code: 'INVALID_SECTION',
          description: 'Requested section does not exist',
          recovery_suggestion: 'Use one of: all, capabilities, tools, resources, examples, errors',
        },
      ],
      handler: async (params: any) => {
        const section = params.section || 'all';
        const config = ConfigManager.getInstance().getConfig();
        
        const serverInfo: MCPServerInfo = {
          name: 'BookStack MCP Server',
          version: '1.0.0',
          description: 'Comprehensive MCP server providing full access to BookStack knowledge management system. Enables LLMs to read, write, organize, and manage documentation, books, pages, chapters, users, and system settings.',
          capabilities: {
            tools: {
              total: this.toolsMap.size,
              categories: this.getToolCategories().map(c => c.name),
              supports_batch_operations: true,
              supports_transactions: false,
            },
            resources: {
              total: this.resourcesMap.size,
              types: this.getResourceTypes().map(r => r.type),
              supports_streaming: false,
              supports_caching: true,
            },
            authentication: {
              required: true,
              methods: ['API Token'],
            },
            rate_limiting: {
              enabled: !!config.rateLimit,
              requests_per_minute: config.rateLimit?.requestsPerMinute,
              burst_limit: config.rateLimit?.burstLimit,
            },
            validation: {
              enabled: config.validation?.enabled || true,
              strict_mode: config.validation?.strictMode || false,
            },
          },
          tool_categories: this.getToolCategories(),
          resource_types: this.getResourceTypes(),
          usage_examples: this.getUsageExamples(),
          supported_bookstack_versions: ['23.x', '24.x'],
          api_documentation: 'https://demo.bookstackapp.com/api/docs',
          error_handling: this.getErrorHandlingInfo(),
        };

        switch (section) {
          case 'capabilities':
            return { capabilities: serverInfo.capabilities };
          case 'tools':
            return { 
              tool_categories: serverInfo.tool_categories,
              total_tools: serverInfo.capabilities.tools.total 
            };
          case 'resources':
            return { 
              resource_types: serverInfo.resource_types,
              total_resources: serverInfo.capabilities.resources.total 
            };
          case 'examples':
            return { usage_examples: serverInfo.usage_examples };
          case 'errors':
            return { error_handling: serverInfo.error_handling };
          default:
            return serverInfo;
        }
      },
    };
  }

  /**
   * Tool categories information
   */
  private createToolCategoriesTool(): MCPTool {
    return {
      name: 'bookstack_tool_categories',
      description: 'Get detailed information about tool categories and their specific use cases',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['books', 'pages', 'chapters', 'shelves', 'users', 'roles', 'search', 'system', 'attachments', 'images'],
            description: 'Specific category to get detailed info about',
          },
        },
      },
      handler: async (params: any) => {
        const categories = this.getToolCategories();
        
        if (params.category) {
          return categories.find(c => c.name === params.category) || { error: 'Category not found' };
        }
        
        return { categories };
      },
    };
  }

  /**
   * Usage examples tool
   */
  private createUsageExamplesTool(): MCPTool {
    return {
      name: 'bookstack_usage_examples',
      description: 'Get step-by-step workflow examples for common BookStack operations',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: {
            type: 'string',
            enum: ['create_documentation', 'organize_content', 'user_management', 'search_content', 'export_data'],
            description: 'Specific workflow to get example for',
          },
        },
      },
      handler: async (params: any) => {
        const examples = this.getUsageExamples();
        
        if (params.workflow) {
          return examples.find(e => e.title.toLowerCase().includes(params.workflow)) || { error: 'Workflow not found' };
        }
        
        return { examples };
      },
    };
  }

  /**
   * Error handling guide tool
   */
  private createErrorGuidesTool(): MCPTool {
    return {
      name: 'bookstack_error_guides',
      description: 'Get comprehensive error handling information and troubleshooting guides',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          error_code: {
            type: 'string',
            description: 'Specific error code to get guidance for',
          },
        },
      },
      handler: async (params: any) => {
        const errorInfo = this.getErrorHandlingInfo();
        
        if (params.error_code) {
          const error = errorInfo.common_errors.find(e => e.code === params.error_code);
          return error || { error: 'Error code not found' };
        }
        
        return errorInfo;
      },
    };
  }

  /**
   * Interactive help tool
   */
  private createHelpTool(): MCPTool {
    return {
      name: 'bookstack_help',
      description: 'Interactive help system providing contextual guidance for LLM tool usage',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: ['getting_started', 'authentication', 'content_creation', 'user_management', 'search', 'best_practices'],
            description: 'Help topic to get guidance about',
          },
          context: {
            type: 'string',
            description: 'Additional context about what you are trying to achieve',
          },
        },
      },
      handler: async (params: any) => {
        const helpContent = this.getHelpContent();
        
        if (params.topic) {
          const topicHelp = helpContent[params.topic as keyof typeof helpContent];
          return {
            topic: params.topic,
            guidance: topicHelp,
            context_advice: params.context ? this.getContextualAdvice(params.context) : null,
          };
        }
        
        return {
          available_topics: Object.keys(helpContent),
          general_guidance: 'Use bookstack_server_info for complete capabilities, then select specific tools based on your task.',
        };
      },
    };
  }

  /**
   * Get tool categories with detailed information
   */
  private getToolCategories(): ToolCategory[] {
    return [
      {
        name: 'books',
        description: 'Manage books - the top-level containers for documentation',
        tools: ['bookstack_books_list', 'bookstack_books_create', 'bookstack_books_read', 'bookstack_books_update', 'bookstack_books_delete', 'bookstack_books_export'],
        use_cases: ['Create new documentation projects', 'Organize content by topic', 'Export complete documentation'],
      },
      {
        name: 'pages',
        description: 'Manage individual pages - the core content units',
        tools: ['bookstack_pages_list', 'bookstack_pages_create', 'bookstack_pages_read', 'bookstack_pages_update', 'bookstack_pages_delete', 'bookstack_pages_export'],
        use_cases: ['Create articles and documentation', 'Update existing content', 'Manage page hierarchy'],
      },
      {
        name: 'chapters',
        description: 'Manage chapters - organize pages within books',
        tools: ['bookstack_chapters_list', 'bookstack_chapters_create', 'bookstack_chapters_read', 'bookstack_chapters_update', 'bookstack_chapters_delete'],
        use_cases: ['Structure documentation', 'Group related pages', 'Create logical content flow'],
      },
      {
        name: 'shelves',
        description: 'Manage shelves - organize multiple books',
        tools: ['bookstack_shelves_list', 'bookstack_shelves_create', 'bookstack_shelves_read', 'bookstack_shelves_update', 'bookstack_shelves_delete'],
        use_cases: ['Organize books by category', 'Create departmental collections', 'Manage large documentation sets'],
      },
      {
        name: 'search',
        description: 'Search across all content types',
        tools: ['bookstack_search_all', 'bookstack_search_books', 'bookstack_search_pages'],
        use_cases: ['Find existing content', 'Locate information quickly', 'Content discovery'],
      },
      {
        name: 'users',
        description: 'Manage user accounts and profiles',
        tools: ['bookstack_users_list', 'bookstack_users_create', 'bookstack_users_read', 'bookstack_users_update', 'bookstack_users_delete'],
        use_cases: ['User account management', 'Access control', 'Team collaboration setup'],
      },
      {
        name: 'system',
        description: 'System administration and monitoring',
        tools: ['bookstack_system_info', 'bookstack_audit_list', 'bookstack_permissions_get', 'bookstack_permissions_update'],
        use_cases: ['System monitoring', 'Security auditing', 'Permission management'],
      },
    ];
  }

  /**
   * Get resource types information
   */
  private getResourceTypes(): ResourceType[] {
    return [
      {
        type: 'books',
        description: 'Access book content and metadata',
        mime_types: ['application/json', 'text/html', 'text/markdown'],
        uri_patterns: ['bookstack://books/{id}', 'bookstack://books/{id}/contents'],
        examples: ['bookstack://books/1', 'bookstack://books/5/contents'],
      },
      {
        type: 'pages',
        description: 'Access individual page content',
        mime_types: ['application/json', 'text/html', 'text/markdown'],
        uri_patterns: ['bookstack://pages/{id}', 'bookstack://pages/{id}/content'],
        examples: ['bookstack://pages/42', 'bookstack://pages/42/content'],
      },
      {
        type: 'search',
        description: 'Search results across content types',
        mime_types: ['application/json'],
        uri_patterns: ['bookstack://search?query={query}'],
        examples: ['bookstack://search?query=api+documentation'],
      },
    ];
  }

  /**
   * Get usage examples for common workflows
   */
  private getUsageExamples(): ServerUsageExample[] {
    return [
      {
        title: 'Create Complete Documentation Project',
        description: 'Step-by-step workflow to create a new documentation project from scratch',
        workflow: [
          {
            step: 1,
            action: 'Create a new book',
            tool_or_resource: 'bookstack_books_create',
            parameters: { name: 'API Documentation', description: 'Complete API reference' },
            description: 'Establish the main container for your documentation',
          },
          {
            step: 2,
            action: 'Create chapters for organization',
            tool_or_resource: 'bookstack_chapters_create',
            parameters: { name: 'Getting Started', book_id: 'from_step_1' },
            description: 'Structure your content into logical sections',
          },
          {
            step: 3,
            action: 'Add pages with content',
            tool_or_resource: 'bookstack_pages_create',
            parameters: { name: 'Authentication', chapter_id: 'from_step_2', html: '<p>API authentication guide...</p>' },
            description: 'Create the actual content pages',
          },
          {
            step: 4,
            action: 'Set permissions',
            tool_or_resource: 'bookstack_permissions_update',
            description: 'Configure who can view and edit the documentation',
          },
        ],
        expected_outcome: 'A complete, structured documentation project ready for team collaboration',
      },
      {
        title: 'Search and Update Existing Content',
        description: 'Find and update existing documentation efficiently',
        workflow: [
          {
            step: 1,
            action: 'Search for content',
            tool_or_resource: 'bookstack_search_all',
            parameters: { query: 'authentication methods' },
            description: 'Locate existing content related to your topic',
          },
          {
            step: 2,
            action: 'Read current content',
            tool_or_resource: 'bookstack_pages_read',
            description: 'Review existing content before making changes',
          },
          {
            step: 3,
            action: 'Update with new information',
            tool_or_resource: 'bookstack_pages_update',
            description: 'Apply your changes to keep documentation current',
          },
        ],
        expected_outcome: 'Updated documentation with current and accurate information',
      },
    ];
  }

  /**
   * Get error handling information
   */
  private getErrorHandlingInfo(): ErrorHandlingInfo {
    return {
      common_errors: [
        {
          code: 'UNAUTHORIZED',
          message: 'Authentication failed or token invalid',
          causes: ['Invalid API token', 'Token expired', 'Insufficient permissions'],
          solutions: ['Check API token configuration', 'Verify token has required permissions', 'Contact administrator for new token'],
          prevention: 'Regularly rotate API tokens and validate permissions',
        },
        {
          code: 'NOT_FOUND',
          message: 'Requested resource does not exist',
          causes: ['Invalid ID', 'Resource deleted', 'No access permissions'],
          solutions: ['Verify resource ID', 'Check if resource was moved or deleted', 'Confirm access permissions'],
          prevention: 'Always validate resource existence before operations',
        },
        {
          code: 'VALIDATION_ERROR',
          message: 'Request parameters failed validation',
          causes: ['Required fields missing', 'Invalid data format', 'Data too long'],
          solutions: ['Check required parameters', 'Validate data format', 'Reduce content size'],
          prevention: 'Use schema validation before sending requests',
        },
      ],
      debugging_tips: [
        'Use bookstack_system_info to check server status',
        'Verify authentication with a simple read operation first',
        'Check audit logs for permission-related issues',
        'Start with list operations to understand available resources',
      ],
      support_contact: 'https://github.com/pnocera/bookstack-mcp-server/issues',
    };
  }

  /**
   * Get help content for different topics
   */
  private getHelpContent() {
    return {
      getting_started: {
        overview: 'Start by calling bookstack_server_info to understand capabilities',
        first_steps: ['Verify authentication', 'List existing content', 'Try a simple read operation'],
        common_patterns: ['Always list before reading specific items', 'Use search to find existing content', 'Check permissions before write operations'],
      },
      authentication: {
        overview: 'BookStack uses API token authentication',
        setup: ['Get token from BookStack admin panel', 'Set BOOKSTACK_API_TOKEN environment variable', 'Test with bookstack_system_info'],
        troubleshooting: ['Verify token is active', 'Check token permissions', 'Contact administrator'],
      },
      content_creation: {
        overview: 'Follow the hierarchy: Shelves > Books > Chapters > Pages',
        best_practices: ['Create books for major topics', 'Use chapters to organize pages', 'Add meaningful descriptions and tags'],
        workflow: ['Plan structure first', 'Create containers (books/chapters)', 'Add content (pages)', 'Set permissions'],
      },
    };
  }

  /**
   * Get contextual advice based on user input
   */
  private getContextualAdvice(context: string): string {
    const lowerContext = context.toLowerCase();
    
    if (lowerContext.includes('create') || lowerContext.includes('new')) {
      return 'For creating content: Start with books, add chapters for organization, then create pages. Always provide clear names and descriptions.';
    }
    
    if (lowerContext.includes('search') || lowerContext.includes('find')) {
      return 'For finding content: Use bookstack_search_all for general searches, or specific search tools for targeted results. Try different keywords if initial search fails.';
    }
    
    if (lowerContext.includes('update') || lowerContext.includes('edit')) {
      return 'For updating content: First read the current content, make your changes, then update. Consider checking permissions before attempting updates.';
    }
    
    if (lowerContext.includes('permission') || lowerContext.includes('access')) {
      return 'For permission issues: Check your API token permissions, verify resource ownership, and use audit logs to understand access patterns.';
    }
    
    return 'Use bookstack_server_info for complete capabilities overview, then select appropriate tools based on your specific task.';
  }
}
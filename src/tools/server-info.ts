import { ConfigManager } from '../config/manager';
import {
  type ErrorHandlingInfo,
  type MCPResource,
  type MCPServerInfo,
  type MCPTool,
  type ResourceType,
  type ServerUsageExample,
  type ToolCategory,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import { ValidationHandler } from '../validation/validator';

/**
 * The sections `bookstack_server_info` can return. Single source of truth for
 * the advertised enum, the validation and the error payload.
 */
const SERVER_INFO_SECTIONS: readonly string[] = [
  'all',
  'capabilities',
  'tools',
  'resources',
  'examples',
  'errors',
];

/**
 * The one BookStack version this server's behaviour has actually been verified against,
 * end to end, by exercising every tool against a live instance.
 *
 * Reported as a single exact version rather than a range of majors on purpose. BookStack
 * ships breaking API details in point releases (the response shape of a role differs
 * between its own create and read endpoints, for one), so a claim like "24.x" would be
 * an assertion nobody here has evidence for. Compare with `bookstack_system_info`, which
 * reports what the connected instance actually runs.
 */
const BOOKSTACK_VERIFIED_VERSION = 'v26.05.2';

/**
 * Server Information Tools for MCP Self-Description
 *
 * Provides comprehensive server information to help LLMs understand
 * capabilities, usage patterns, and proper tool interaction.
 */
export class ServerInfoTools {
  constructor(
    _logger: Logger,
    private toolsMap: Map<string, MCPTool>,
    private resourcesMap: Map<string, MCPResource>
  ) {}

  /**
   * The validator these tools check their own requests with.
   *
   * Built per call from the ConfigManager singleton rather than injected, because that
   * singleton is the only place the enabled/strictMode settings live and this class is
   * constructed without a validator (see `setupTools()` in src/server.ts). Per call, not
   * cached: `bookstack_server_info` already reads the same singleton on every invocation,
   * and reload() must not leave a stale copy behind here. It costs two boolean reads.
   */
  private validator(): ValidationHandler {
    return new ValidationHandler(ConfigManager.getInstance().getConfig().validation);
  }

  /**
   * Get all server info tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createServerInfoTool(),
      this.createToolCategoriesTool(),
      this.createUsageExamplesTool(),
      this.createErrorGuidesTool(),
      this.createHelpTool(),
    ]);
  }

  /**
   * Main server information tool
   */
  private createServerInfoTool(): MCPTool {
    return {
      name: 'bookstack_server_info',
      description:
        'Get comprehensive information about this BookStack MCP server. Includes capabilities, version, available tools, and usage examples.',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: [...SERVER_INFO_SECTIONS],
            default: 'all',
            description: 'Specific section to retrieve. Defaults to "all".',
          },
        },
      },
      examples: [
        {
          description: 'Get all server info',
          input: { section: 'all' },
          expected_output: 'Full server metadata',
          use_case: 'Initial discovery',
        },
      ],
      usage_patterns: ['Call this first when connecting to understand what the server can do'],
      error_codes: [
        {
          code: 'INVALID_SECTION',
          description: 'Invalid section requested',
          recovery_suggestion: 'Use one of the allowed enum values',
        },
      ],
      handler: async (params: unknown) => {
        // Shape-checked, not enum-checked: an unrecognised section is answered by the
        // advertised INVALID_SECTION payload below, which names the ones that work. What
        // this catches is the unknown KEY - `{sektion: 'tools'}` used to be discarded and
        // silently answered with the full payload, exactly as if 'all' had been asked for.
        const validated = this.validator().validateParams<{ section?: string }>(
          params,
          'serverInfo'
        );
        const section = validated.section || 'all';

        // Advertised as an error code, so it has to actually be enforced: an
        // unknown section previously fell through and returned the full payload.
        if (!SERVER_INFO_SECTIONS.includes(section)) {
          return {
            error: 'INVALID_SECTION',
            message: `Unknown section '${section}'.`,
            requested: section,
            available_sections: [...SERVER_INFO_SECTIONS],
          };
        }

        const config = ConfigManager.getInstance().getConfig();

        const serverInfo: MCPServerInfo = {
          name: 'BookStack MCP Server',
          // From config, like MCP initialize and GET / — not a literal. A literal
          // here is invisible to release-please and would outlive every release.
          version: config.server.version,
          description:
            'Comprehensive MCP server providing full access to BookStack knowledge management system. Enables LLMs to read, write, organize, and manage documentation, books, pages, chapters, users, and system settings.',
          capabilities: {
            tools: {
              total: this.toolsMap.size,
              categories: this.getToolCategories().map((c) => c.name),
              // Every tool acts on a single item; there is no batch tool and no
              // batching layer, so callers must loop and issue one call each.
              supports_batch_operations: false,
              supports_transactions: false,
            },
            resources: {
              total: this.resourcesMap.size,
              types: this.getResourceTypes().map((r) => r.type),
              supports_streaming: false,
              // No cache exists anywhere in this server: every resource read is
              // a fresh call through to BookStack.
              supports_caching: false,
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
              // `?? `, not `|| `: with `||` a configured `false` reported as
              // `true`, so this could never report validation as disabled.
              enabled: config.validation?.enabled ?? true,
              strict_mode: config.validation?.strictMode ?? false,
            },
          },
          tool_categories: this.getToolCategories(),
          resource_types: this.getResourceTypes(),
          usage_examples: this.getUsageExamples(),
          // What was actually tested, rather than a hand-maintained compatibility claim.
          // The previous list read ['23.x', '24.x', '26.x'] - inventing coverage of two
          // majors nothing here has ever run against, while skipping the 25.x that
          // src/api/client.ts documents real observations from. Every endpoint, filter
          // and response shape this server relies on was verified against the version
          // named below; anything else is untested rather than known-broken, so callers
          // are told how to check for themselves.
          supported_bookstack_versions: [BOOKSTACK_VERIFIED_VERSION],
          api_documentation: 'https://demo.bookstackapp.com/api/docs',
          error_handling: this.getErrorHandlingInfo(),
        };

        switch (section) {
          case 'capabilities':
            return { capabilities: serverInfo.capabilities };
          case 'tools':
            return {
              tool_categories: serverInfo.tool_categories,
              total_tools: serverInfo.capabilities.tools.total,
            };
          case 'resources':
            return {
              resource_types: serverInfo.resource_types,
              total_resources: serverInfo.capabilities.resources.total,
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
      description:
        'Get a list of tool categories (e.g., books, pages, users) and their descriptions.',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            // Must stay in the same order as getToolCategories(): the two are
            // hand-maintained lists and a name in one but not the other is either
            // an unaskable category or an enum value that only answers "not found".
            enum: [
              'books',
              'pages',
              'chapters',
              'shelves',
              'search',
              'users',
              'roles',
              'system',
              'permissions',
              'recyclebin',
              'attachments',
              'images',
              'meta',
            ],
            description: 'Specific category name. Omit to list every category.',
          },
        },
      },
      handler: async (params: unknown) => {
        const categories = this.getToolCategories();
        // See bookstack_server_info: shape and unknown keys are enforced here, while an
        // unrecognised value keeps its "here are the ones that exist" answer. Without
        // this, `{catgeory: 'books'}` read as "list every category".
        const { category } = this.validator().validateParams<{ category?: string }>(
          params,
          'toolCategories'
        );

        if (category) {
          const match = categories.find((c) => c.name === category);
          if (!match) {
            return {
              error: 'Category not found',
              requested: category,
              available_categories: categories.map((c) => c.name),
            };
          }
          return match;
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
      description:
        'Get common workflow examples, such as how to create documentation or manage users.',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: {
            type: 'string',
            enum: [
              'create_documentation',
              'organize_content',
              'user_management',
              'search_content',
              'export_data',
            ],
            description: 'Specific workflow name.',
          },
        },
      },
      handler: async (params: unknown) => {
        const examples = this.getUsageExamples();
        const { workflow } = this.validator().validateParams<{ workflow?: string }>(
          params,
          'usageExamples'
        );

        if (workflow) {
          // Match on the stable key. A previous version searched the prose title
          // for the enum value, which no title could ever contain (every key has
          // an underscore, no title does), so every lookup missed.
          const match = examples.find((e) => e.key === workflow);
          if (!match) {
            return {
              error: 'Workflow not found',
              requested: workflow,
              available_workflows: examples.map((e) => e.key),
            };
          }
          return match;
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
      description:
        "Get information about common error codes and how to resolve them. Covers the three general failure modes shared by every tool (UNAUTHORIZED, NOT_FOUND, VALIDATION_ERROR); a tool's own error_codes list is the place to look for codes specific to it.",
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          error_code: {
            type: 'string',
            // Only these three have content behind them. Left unadvertised, the
            // caller had to guess a code and got a bare "not found" when it missed.
            enum: ['UNAUTHORIZED', 'NOT_FOUND', 'VALIDATION_ERROR'],
            description: 'Error code to look up. Omit to get the whole guide.',
          },
        },
      },
      handler: async (params: unknown) => {
        const errorInfo = this.getErrorHandlingInfo();
        const { error_code: errorCode } = this.validator().validateParams<{ error_code?: string }>(
          params,
          'errorGuides'
        );

        if (errorCode) {
          const error = errorInfo.common_errors.find((e) => e.code === errorCode);
          if (!error) {
            // Name the codes that would have worked, as every other lookup tool
            // here does, rather than leaving the caller to guess again.
            return {
              error: 'Error code not found',
              requested: errorCode,
              available_error_codes: errorInfo.common_errors.map((e) => e.code),
            };
          }
          return error;
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
      description: 'Get context-aware help and advice on how to use this MCP server.',
      category: 'meta',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: [
              'getting_started',
              'authentication',
              'content_creation',
              'user_management',
              'search',
              'best_practices',
            ],
            description: 'Topic to ask about.',
          },
          context: {
            type: 'string',
            description: 'Describe what you are trying to do.',
          },
        },
      },
      handler: async (params: unknown) => {
        const helpContent = this.getHelpContent();
        const { topic, context } = this.validator().validateParams<{
          topic?: string;
          context?: string;
        }>(params, 'help');

        if (topic) {
          // Guard the lookup: an unrecognised topic used to fall through to
          // `guidance: undefined`, which reads as success but carries nothing.
          if (!Object.hasOwn(helpContent, topic)) {
            return {
              error: 'Topic not found',
              requested: topic,
              available_topics: Object.keys(helpContent),
            };
          }

          return {
            topic,
            guidance: helpContent[topic as keyof typeof helpContent],
            context_advice: context ? this.getContextualAdvice(context) : null,
          };
        }

        return {
          available_topics: Object.keys(helpContent),
          general_guidance:
            'Use bookstack_server_info for complete capabilities, then select specific tools based on your task.',
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
        tools: [
          'bookstack_books_list',
          'bookstack_books_create',
          'bookstack_books_read',
          'bookstack_books_update',
          'bookstack_books_delete',
          'bookstack_books_export',
        ],
        use_cases: [
          'Create new documentation projects',
          'Organize content by topic',
          'Export complete documentation',
        ],
      },
      {
        name: 'pages',
        description: 'Manage individual pages - the core content units',
        tools: [
          'bookstack_pages_list',
          'bookstack_pages_create',
          'bookstack_pages_read',
          'bookstack_pages_update',
          'bookstack_pages_delete',
          'bookstack_pages_export',
        ],
        use_cases: [
          'Create articles and documentation',
          'Update existing content',
          'Manage page hierarchy',
        ],
      },
      {
        name: 'chapters',
        description: 'Manage chapters - organize pages within books',
        tools: [
          'bookstack_chapters_list',
          'bookstack_chapters_create',
          'bookstack_chapters_read',
          'bookstack_chapters_update',
          'bookstack_chapters_delete',
          'bookstack_chapters_export',
        ],
        use_cases: [
          'Structure documentation',
          'Group related pages',
          'Create logical content flow',
        ],
      },
      {
        name: 'shelves',
        description: 'Manage shelves - organize multiple books',
        tools: [
          'bookstack_shelves_list',
          'bookstack_shelves_create',
          'bookstack_shelves_read',
          'bookstack_shelves_update',
          'bookstack_shelves_delete',
        ],
        use_cases: [
          'Organize books by category',
          'Create departmental collections',
          'Manage large documentation sets',
        ],
      },
      {
        name: 'search',
        description: 'Search across all content types',
        tools: ['bookstack_search'],
        use_cases: ['Find existing content', 'Locate information quickly', 'Content discovery'],
      },
      {
        name: 'users',
        description: 'Manage user accounts and profiles',
        tools: [
          'bookstack_users_list',
          'bookstack_users_create',
          'bookstack_users_read',
          'bookstack_users_update',
          'bookstack_users_delete',
        ],
        use_cases: ['User account management', 'Access control', 'Team collaboration setup'],
      },
      {
        name: 'roles',
        description: 'Manage user roles and permissions',
        tools: [
          'bookstack_roles_list',
          'bookstack_roles_create',
          'bookstack_roles_read',
          'bookstack_roles_update',
          'bookstack_roles_delete',
        ],
        use_cases: ['Define access levels', 'Manage privileges', 'Group permissions'],
      },
      {
        name: 'system',
        description: 'System administration and monitoring',
        tools: ['bookstack_system_info', 'bookstack_audit_log_list'],
        use_cases: ['System monitoring', 'Security auditing'],
      },
      {
        name: 'permissions',
        description: 'Inspect and set content-level permission overrides',
        tools: ['bookstack_permissions_read', 'bookstack_permissions_update'],
        use_cases: [
          'Restrict a book or page to specific roles',
          'Debug why a user cannot see content',
          'Return an item to inheriting its parent permissions',
        ],
      },
      {
        name: 'recyclebin',
        description: 'Manage deleted content',
        tools: [
          'bookstack_recyclebin_list',
          'bookstack_recyclebin_restore',
          'bookstack_recyclebin_delete_permanently',
        ],
        use_cases: [
          'Restore accidental deletions',
          'Permanently purge content',
          'Audit deleted items',
        ],
      },
      {
        name: 'attachments',
        description: 'Manage file attachments',
        tools: [
          'bookstack_attachments_list',
          'bookstack_attachments_create',
          'bookstack_attachments_read',
          'bookstack_attachments_update',
          'bookstack_attachments_delete',
        ],
        use_cases: ['Attach files to pages', 'Manage external links'],
      },
      {
        name: 'images',
        description: 'Manage image gallery',
        tools: [
          'bookstack_images_list',
          'bookstack_images_create',
          'bookstack_images_read',
          'bookstack_images_update',
          'bookstack_images_delete',
        ],
        use_cases: ['Upload images', 'Manage gallery assets'],
      },
      {
        // Without this entry the categories described 51 of the server's 56 tools:
        // the five self-describing tools belonged to no category, so the listing an
        // LLM consults to find out what exists omitted the tools that tell it what
        // exists. They all declare `category: 'meta'` themselves.
        name: 'meta',
        description: 'Ask this server about itself - its tools, resources and conventions',
        tools: [
          'bookstack_server_info',
          'bookstack_tool_categories',
          'bookstack_usage_examples',
          'bookstack_error_guides',
          'bookstack_help',
        ],
        use_cases: [
          'Discover what the server can do before choosing a tool',
          'Look up a workflow for a multi-step task',
          'Resolve an error code',
        ],
      },
    ];
  }

  /**
   * Get resource types information
   *
   * These URIs are matched against the resource registry as `^pattern$` with each
   * `{placeholder}` becoming `([^/]+)`, so an advertised URI that does not resolve
   * is a dead end an LLM cannot recover from. Every pattern below is a literal
   * entry in that registry; every resource this server registers is JSON-only.
   */
  private getResourceTypes(): ResourceType[] {
    return [
      {
        type: 'books',
        description: 'List books, or read one book with its metadata',
        mime_types: ['application/json'],
        uri_patterns: ['bookstack://books', 'bookstack://books/{id}'],
        examples: ['bookstack://books', 'bookstack://books/1'],
      },
      {
        type: 'pages',
        description: 'List pages, or read one page including its content',
        mime_types: ['application/json'],
        uri_patterns: ['bookstack://pages', 'bookstack://pages/{id}'],
        examples: ['bookstack://pages', 'bookstack://pages/42'],
      },
      {
        type: 'chapters',
        description: 'List chapters, or read one chapter',
        mime_types: ['application/json'],
        uri_patterns: ['bookstack://chapters', 'bookstack://chapters/{id}'],
        examples: ['bookstack://chapters', 'bookstack://chapters/7'],
      },
      {
        type: 'shelves',
        description: 'List shelves, or read one shelf',
        mime_types: ['application/json'],
        uri_patterns: ['bookstack://shelves', 'bookstack://shelves/{id}'],
        examples: ['bookstack://shelves', 'bookstack://shelves/3'],
      },
      {
        type: 'users',
        description: 'List users, or read one user',
        mime_types: ['application/json'],
        uri_patterns: ['bookstack://users', 'bookstack://users/{id}'],
        examples: ['bookstack://users', 'bookstack://users/1'],
      },
      {
        type: 'search',
        description:
          'Search results across content types. The query goes in the path, URL-encoded - there is no query-string form',
        mime_types: ['application/json'],
        uri_patterns: ['bookstack://search/{query}'],
        examples: ['bookstack://search/api%20documentation'],
      },
    ];
  }

  /**
   * Get usage examples for common workflows
   */
  private getUsageExamples(): ServerUsageExample[] {
    return [
      {
        key: 'create_documentation',
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
            parameters: {
              name: 'Authentication',
              chapter_id: 'from_step_2',
              html: '<p>API authentication guide...</p>',
            },
            description: 'Create the actual content pages',
          },
          {
            step: 4,
            action: 'Set permissions',
            tool_or_resource: 'bookstack_permissions_update',
            description: 'Configure who can view and edit the documentation',
          },
        ],
        expected_outcome:
          'A complete, structured documentation project ready for team collaboration',
      },
      {
        key: 'search_content',
        title: 'Search and Update Existing Content',
        description: 'Find and update existing documentation efficiently',
        workflow: [
          {
            step: 1,
            action: 'Search for content',
            tool_or_resource: 'bookstack_search',
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
      {
        key: 'organize_content',
        title: 'Reorganize Existing Content',
        description: 'Group existing books onto a shelf and tidy pages into chapters',
        workflow: [
          {
            step: 1,
            action: 'Survey what already exists',
            tool_or_resource: 'bookstack_books_list',
            parameters: { count: 100 },
            description: 'Collect the book IDs you intend to group together',
          },
          {
            step: 2,
            action: 'Create a shelf holding those books',
            tool_or_resource: 'bookstack_shelves_create',
            parameters: { name: 'Engineering', books: [1, 2, 3] },
            description:
              'Shelves are the only level above books, and `books` sets their membership',
          },
          {
            step: 3,
            action: 'Add a chapter to group loose pages',
            tool_or_resource: 'bookstack_chapters_create',
            parameters: { name: 'Runbooks', book_id: 1 },
            description: 'Chapters subdivide a single book',
          },
          {
            step: 4,
            action: 'Move a page into the chapter',
            tool_or_resource: 'bookstack_pages_update',
            parameters: { id: 42, chapter_id: 7 },
            description:
              'Setting chapter_id moves the page. To pull a page back out to the book root, send book_id on its own instead',
          },
        ],
        expected_outcome: 'The same content, reachable through a shelf/book/chapter hierarchy',
      },
      {
        key: 'user_management',
        title: 'Onboard and Offboard Users',
        description: 'Create an account with the right roles, then remove it without losing work',
        workflow: [
          {
            step: 1,
            action: 'Find the role IDs to assign',
            tool_or_resource: 'bookstack_roles_list',
            parameters: { filter: { display_name: 'Editor' } },
            description: 'Roles are referenced by ID, so resolve the name first',
          },
          {
            step: 2,
            action: 'Create the account',
            tool_or_resource: 'bookstack_users_create',
            parameters: { name: 'Jane Doe', email: 'jane@example.com', roles: [2] },
            description:
              'Send send_invite: true instead of a password to have BookStack email them',
          },
          {
            step: 3,
            action: 'Adjust roles later as needed',
            tool_or_resource: 'bookstack_users_update',
            parameters: { id: 5, roles: [2, 3] },
            description:
              '`roles` replaces the existing set, so read the user first and send the full list you want them to end up with',
          },
          {
            step: 4,
            action: 'Offboard, keeping their content',
            tool_or_resource: 'bookstack_users_delete',
            parameters: { id: 5, migrate_ownership_id: 1 },
            description:
              'migrate_ownership_id hands their books and pages to another user. BookStack has no deactivate flag, so removal (or stripping roles) is how access ends',
          },
        ],
        expected_outcome:
          'Accounts carrying the correct roles, and departures that orphan no content',
      },
      {
        key: 'export_data',
        title: 'Export Content for Backup or Migration',
        description: 'Pull content out of BookStack in a portable format',
        workflow: [
          {
            step: 1,
            action: 'Enumerate the books to export',
            tool_or_resource: 'bookstack_books_list',
            parameters: { count: 100 },
            description: 'Gives you the IDs to iterate over',
          },
          {
            step: 2,
            action: 'Export each book as Markdown',
            tool_or_resource: 'bookstack_books_export',
            parameters: { id: 1, format: 'markdown' },
            description:
              'markdown and plaintext come back as text (encoding "utf8"); they are the most token-efficient formats to feed back to an LLM',
          },
          {
            step: 3,
            action: 'Export a PDF when a rendered copy is wanted',
            tool_or_resource: 'bookstack_books_export',
            parameters: { id: 1, format: 'pdf' },
            description:
              'PDF is binary: content arrives base64-encoded with encoding "base64", and byte_length carries the true file size',
          },
        ],
        expected_outcome: 'A local copy of the content in a format you can archive or re-import',
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
          solutions: [
            'Check API token configuration',
            'Verify token has required permissions',
            'Contact administrator for new token',
          ],
          prevention: 'Regularly rotate API tokens and validate permissions',
        },
        {
          code: 'NOT_FOUND',
          message: 'Requested resource does not exist',
          causes: ['Invalid ID', 'Resource deleted', 'No access permissions'],
          solutions: [
            'Verify resource ID',
            'Check if resource was moved or deleted',
            'Confirm access permissions',
          ],
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
        first_steps: [
          'Verify authentication',
          'List existing content',
          'Try a simple read operation',
        ],
        common_patterns: [
          'Always list before reading specific items',
          'Use search to find existing content',
          'Check permissions before write operations',
        ],
      },
      authentication: {
        overview: 'BookStack uses API token authentication',
        setup: [
          'Get token from BookStack admin panel',
          'Set BOOKSTACK_API_TOKEN environment variable',
          'Test with bookstack_system_info',
        ],
        troubleshooting: [
          'Verify token is active',
          'Check token permissions',
          'Contact administrator',
        ],
      },
      content_creation: {
        overview: 'Follow the hierarchy: Shelves > Books > Chapters > Pages',
        best_practices: [
          'Create books for major topics',
          'Use chapters to organize pages',
          'Add meaningful descriptions and tags',
        ],
        workflow: [
          'Plan structure first',
          'Create containers (books/chapters)',
          'Add content (pages)',
          'Set permissions',
        ],
      },
      user_management: {
        overview:
          'Users hold roles, and roles carry the permissions. Assign access by putting a user into the right role rather than by editing permissions per person.',
        setup: [
          'List roles with bookstack_roles_list to resolve the role IDs you need',
          'Create the account with bookstack_users_create, passing roles: [id, ...]',
          'Use send_invite: true to have BookStack email an invitation instead of setting a password',
        ],
        best_practices: [
          '`roles` on update replaces the whole set - read the user first, then send the full list you want them to keep',
          'To offboard, delete the user with migrate_ownership_id so their books and pages pass to someone else',
          'BookStack exposes no active/deactivate flag on a user: removing roles or deleting the account is how access is revoked',
        ],
        troubleshooting: [
          'A 422 on create usually means the email is already taken',
          'Deleting a role does not move its users anywhere - they simply lose it, so re-assign them first',
        ],
      },
      search: {
        overview:
          "bookstack_search runs BookStack's own search syntax across shelves, books, chapters and pages in one call.",
        syntax: [
          'Bare terms match content and titles: authentication guide',
          '{type:page} restricts the content type; combine with | as in {type:page|chapter}',
          '[tagname=value] matches a tag; [tagname] matches anything carrying the tag',
          '"exact phrase" in quotes requires those words together',
          'Prefix a quoted phrase, [tag] or {filter} with - to negate it, e.g. -{type:page}. Plain terms cannot be negated this way',
          'Other useful filters: {created_by:me}, {updated_after:2026-01-01}, {in_name:term}, {is_template:true}',
        ],
        best_practices: [
          'Start broad, then narrow with a {type:...} or tag filter once you see the shape of the results',
          'Search returns previews, not full content - follow up with bookstack_pages_read for the real text',
          'If a search comes back empty, retry with fewer or more general words before concluding nothing exists',
        ],
      },
      best_practices: {
        overview: 'Read before you write, and prefer the narrowest tool that does the job.',
        content: [
          'Prefer markdown over html when creating pages: fewer tokens and easier to get right',
          'Update tools replace the field they are given - read the current value first if you mean to append',
          'Tags on update replace all existing tags, so send the complete set',
        ],
        efficiency: [
          'Use list tools with filters instead of fetching everything and filtering locally',
          'Use markdown or plaintext exports for LLM context; html and pdf cost far more tokens',
          'There is no batch tool: each call handles one item, so prefer a filtered list call over many individual reads, and avoid polling in a loop - outbound calls are rate-limited',
        ],
        safety: [
          'Deletes are recoverable: entity deletes land in the recycle bin, reachable via bookstack_recyclebin_list',
          'Check bookstack_permissions_read before assuming content is private',
          'Use bookstack_audit_log_list to find out who changed something and when',
        ],
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
      // `bookstack_search_all` never existed: the tool is `bookstack_search`, and
      // it is the only search tool there is.
      return 'For finding content: Use bookstack_search, which covers shelves, books, chapters and pages in one call. Narrow it with {type:page} or [tag] filters, and try broader keywords if the first search comes back empty.';
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

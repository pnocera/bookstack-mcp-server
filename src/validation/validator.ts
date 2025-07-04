import { z } from 'zod';

/**
 * Validation schemas for BookStack entities
 */
const ValidationSchemas = {
  // Pagination
  pagination: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.string().optional(),
  }),

  // Books
  booksList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at']).default('name'),
    filter: z.object({
      name: z.string().optional(),
      created_by: z.number().optional(),
    }).optional(),
  }),

  bookCreate: z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    default_template_id: z.number().optional(),
  }),

  bookUpdate: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    default_template_id: z.number().optional(),
  }),

  // Pages
  pagesList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at', 'priority']).default('name'),
    filter: z.object({
      book_id: z.number().optional(),
      chapter_id: z.number().optional(),
      name: z.string().optional(),
      draft: z.boolean().optional(),
      template: z.boolean().optional(),
    }).optional(),
  }),

  pageCreate: z.object({
    book_id: z.number().optional(),
    chapter_id: z.number().optional(),
    name: z.string().min(1).max(255),
    html: z.string().optional(),
    markdown: z.string().optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    priority: z.number().optional(),
  }).refine(data => data.html || data.markdown, {
    message: "Either html or markdown content is required",
  }).refine(data => data.book_id || data.chapter_id, {
    message: "Either book_id or chapter_id is required",
  }),

  pageUpdate: z.object({
    book_id: z.number().optional(),
    chapter_id: z.number().optional(),
    name: z.string().min(1).max(255).optional(),
    html: z.string().optional(),
    markdown: z.string().optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    priority: z.number().optional(),
  }),

  // Chapters
  chaptersList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at', 'priority']).default('name'),
    filter: z.object({
      book_id: z.number().optional(),
      name: z.string().optional(),
    }).optional(),
  }),

  chapterCreate: z.object({
    name: z.string().min(1).max(255),
    book_id: z.number(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    priority: z.number().optional(),
  }),

  chapterUpdate: z.object({
    name: z.string().min(1).max(255).optional(),
    book_id: z.number().optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    priority: z.number().optional(),
  }),

  // Shelves
  shelvesList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at']).default('name'),
    filter: z.object({
      name: z.string().optional(),
      created_by: z.number().optional(),
    }).optional(),
  }),

  shelfCreate: z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    books: z.array(z.number()).optional(),
  }),

  shelfUpdate: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    books: z.array(z.number()).optional(),
  }),

  // Users
  usersList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'email', 'created_at', 'updated_at']).default('name'),
    filter: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      active: z.boolean().optional(),
    }).optional(),
  }),

  userCreate: z.object({
    name: z.string().min(1).max(255),
    email: z.string().email().max(255),
    password: z.string().min(8).optional(),
    roles: z.array(z.number()).optional(),
    send_invite: z.boolean().optional(),
  }),

  userUpdate: z.object({
    name: z.string().min(1).max(255).optional(),
    email: z.string().email().max(255).optional(),
    password: z.string().min(8).optional(),
    roles: z.array(z.number()).optional(),
    active: z.boolean().optional(),
  }),

  // Roles
  rolesList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['display_name', 'created_at', 'updated_at']).default('display_name'),
  }),

  roleCreate: z.object({
    display_name: z.string().min(1).max(255),
    description: z.string().max(1900).optional(),
    permissions: z.array(z.string()).optional(),
    mfa_enforced: z.boolean().optional(),
  }),

  roleUpdate: z.object({
    display_name: z.string().min(1).max(255).optional(),
    description: z.string().max(1900).optional(),
    permissions: z.array(z.string()).optional(),
    mfa_enforced: z.boolean().optional(),
  }),

  // Attachments
  attachmentsList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'extension', 'uploaded_to', 'created_at', 'updated_at']).default('name'),
    filter: z.object({
      name: z.string().optional(),
      uploaded_to: z.number().optional(),
      extension: z.string().optional(),
    }).optional(),
  }),

  attachmentCreate: z.object({
    uploaded_to: z.number(),
    name: z.string().min(1).max(255),
    file: z.string().optional(), // base64 encoded
    link: z.string().url().optional(),
  }).refine(data => data.file || data.link, {
    message: "Either file or link is required",
  }),

  attachmentUpdate: z.object({
    uploaded_to: z.number().optional(),
    name: z.string().min(1).max(255).optional(),
    file: z.string().optional(), // base64 encoded
    link: z.string().url().optional(),
  }),

  // Images
  imagesList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at']).default('name'),
    filter: z.object({
      name: z.string().optional(),
      type: z.enum(['gallery', 'drawio']).optional(),
    }).optional(),
  }),

  imageCreate: z.object({
    name: z.string().min(1).max(255),
    image: z.string(), // base64 encoded
    type: z.enum(['gallery', 'drawio']).default('gallery'),
  }),

  imageUpdate: z.object({
    name: z.string().min(1).max(255).optional(),
    image: z.string().optional(), // base64 encoded
  }),

  // Search
  search: z.object({
    query: z.string().min(1),
    page: z.number().min(1).default(1),
    count: z.number().min(1).max(100).default(20),
  }),

  // Audit Log
  auditLogList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['created_at', 'type', 'user_id']).default('created_at'),
    filter: z.object({
      type: z.string().optional(),
      user_id: z.number().optional(),
      entity_type: z.string().optional(),
      entity_id: z.number().optional(),
    }).optional(),
  }),

  // Content Permissions
  contentPermissionsUpdate: z.object({
    permissions: z.array(z.object({
      role_id: z.number(),
      view: z.boolean(),
      create: z.boolean(),
      update: z.boolean(),
      delete: z.boolean(),
    })),
  }),

  // Export
  export: z.object({
    id: z.number(),
    format: z.enum(['html', 'pdf', 'plaintext', 'markdown']),
  }),

  // Generic ID parameter
  id: z.object({
    id: z.number().positive(),
  }),

  // Recycle bin operations
  recycleBinList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['deleted_at', 'deletable_type', 'deletable_id']).default('deleted_at'),
  }),

  recycleBinOperation: z.object({
    deletion_id: z.number().positive(),
  }),

  // Content permissions
  contentPermissions: z.object({
    content_type: z.enum(['bookshelf', 'book', 'chapter', 'page']),
    content_id: z.number().positive(),
  }),
};

/**
 * Validation handler
 */
export class ValidationHandler {
  private enabled: boolean;
  private strictMode: boolean;

  constructor(config: { enabled: boolean; strictMode: boolean }) {
    this.enabled = config.enabled;
    this.strictMode = config.strictMode;
  }

  /**
   * Validate parameters against a schema
   */
  validateParams<T>(params: any, schemaName: keyof typeof ValidationSchemas): T {
    if (!this.enabled) {
      return params as T;
    }

    const schema = ValidationSchemas[schemaName];
    if (!schema) {
      throw new Error(`No validation schema found for ${schemaName}`);
    }

    try {
      return schema.parse(params) as T;
    } catch (error) {
      if (this.strictMode) {
        throw error;
      }
      
      // In non-strict mode, log the error but continue with original params
      console.warn(`Validation warning for ${schemaName}:`, (error as Error).message);
      return params as T;
    }
  }

  /**
   * Validate required fields are present
   */
  validateRequired(params: any, requiredFields: string[]): void {
    if (!this.enabled) {
      return;
    }

    const missing = requiredFields.filter(field => 
      params[field] === undefined || params[field] === null
    );

    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }
  }

  /**
   * Validate ID parameter
   */
  validateId(id: any): number {
    if (!this.enabled) {
      return Number(id);
    }

    const parsed = ValidationSchemas.id.parse({ id: Number(id) });
    return parsed.id;
  }

  /**
   * Get available schemas
   */
  getAvailableSchemas(): string[] {
    return Object.keys(ValidationSchemas);
  }
}

export default ValidationHandler;
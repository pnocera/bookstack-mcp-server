"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationHandler = void 0;
const zod_1 = require("zod");
/**
 * Validation schemas for BookStack entities
 */
const ValidationSchemas = {
    // Pagination
    pagination: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.string().optional(),
    }),
    // Books
    booksList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['name', 'created_at', 'updated_at']).default('name'),
        filter: zod_1.z.object({
            name: zod_1.z.string().optional(),
            created_by: zod_1.z.number().optional(),
        }).optional(),
    }),
    bookCreate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255),
        description: zod_1.z.string().max(1900).optional(),
        description_html: zod_1.z.string().max(2000).optional(),
        tags: zod_1.z.array(zod_1.z.object({
            name: zod_1.z.string(),
            value: zod_1.z.string(),
        })).optional(),
        default_template_id: zod_1.z.number().optional(),
    }),
    bookUpdate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255).optional(),
        description: zod_1.z.string().max(1900).optional(),
        description_html: zod_1.z.string().max(2000).optional(),
        tags: zod_1.z.array(zod_1.z.object({
            name: zod_1.z.string(),
            value: zod_1.z.string(),
        })).optional(),
        default_template_id: zod_1.z.number().optional(),
    }),
    // Pages
    pagesList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['name', 'created_at', 'updated_at', 'priority']).default('name'),
        filter: zod_1.z.object({
            book_id: zod_1.z.number().optional(),
            chapter_id: zod_1.z.number().optional(),
            name: zod_1.z.string().optional(),
            draft: zod_1.z.boolean().optional(),
            template: zod_1.z.boolean().optional(),
        }).optional(),
    }),
    pageCreate: zod_1.z.object({
        book_id: zod_1.z.number().optional(),
        chapter_id: zod_1.z.number().optional(),
        name: zod_1.z.string().min(1).max(255),
        html: zod_1.z.string().optional(),
        markdown: zod_1.z.string().optional(),
        tags: zod_1.z.array(zod_1.z.object({
            name: zod_1.z.string(),
            value: zod_1.z.string(),
        })).optional(),
        priority: zod_1.z.number().optional(),
    }).refine(data => data.html || data.markdown, {
        message: "Either html or markdown content is required",
    }).refine(data => data.book_id || data.chapter_id, {
        message: "Either book_id or chapter_id is required",
    }),
    pageUpdate: zod_1.z.object({
        book_id: zod_1.z.number().optional(),
        chapter_id: zod_1.z.number().optional(),
        name: zod_1.z.string().min(1).max(255).optional(),
        html: zod_1.z.string().optional(),
        markdown: zod_1.z.string().optional(),
        tags: zod_1.z.array(zod_1.z.object({
            name: zod_1.z.string(),
            value: zod_1.z.string(),
        })).optional(),
        priority: zod_1.z.number().optional(),
    }),
    // Chapters
    chaptersList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['name', 'created_at', 'updated_at', 'priority']).default('name'),
        filter: zod_1.z.object({
            book_id: zod_1.z.number().optional(),
            name: zod_1.z.string().optional(),
        }).optional(),
    }),
    chapterCreate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255),
        book_id: zod_1.z.number(),
        description: zod_1.z.string().max(1900).optional(),
        description_html: zod_1.z.string().max(2000).optional(),
        tags: zod_1.z.array(zod_1.z.object({
            name: zod_1.z.string(),
            value: zod_1.z.string(),
        })).optional(),
        priority: zod_1.z.number().optional(),
    }),
    chapterUpdate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255).optional(),
        book_id: zod_1.z.number().optional(),
        description: zod_1.z.string().max(1900).optional(),
        description_html: zod_1.z.string().max(2000).optional(),
        tags: zod_1.z.array(zod_1.z.object({
            name: zod_1.z.string(),
            value: zod_1.z.string(),
        })).optional(),
        priority: zod_1.z.number().optional(),
    }),
    // Shelves
    shelvesList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['name', 'created_at', 'updated_at']).default('name'),
        filter: zod_1.z.object({
            name: zod_1.z.string().optional(),
            created_by: zod_1.z.number().optional(),
        }).optional(),
    }),
    shelfCreate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255),
        description: zod_1.z.string().max(1900).optional(),
        description_html: zod_1.z.string().max(2000).optional(),
        tags: zod_1.z.array(zod_1.z.object({
            name: zod_1.z.string(),
            value: zod_1.z.string(),
        })).optional(),
        books: zod_1.z.array(zod_1.z.number()).optional(),
    }),
    shelfUpdate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255).optional(),
        description: zod_1.z.string().max(1900).optional(),
        description_html: zod_1.z.string().max(2000).optional(),
        tags: zod_1.z.array(zod_1.z.object({
            name: zod_1.z.string(),
            value: zod_1.z.string(),
        })).optional(),
        books: zod_1.z.array(zod_1.z.number()).optional(),
    }),
    // Users
    usersList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['name', 'email', 'created_at', 'updated_at']).default('name'),
        filter: zod_1.z.object({
            name: zod_1.z.string().optional(),
            email: zod_1.z.string().optional(),
            active: zod_1.z.boolean().optional(),
        }).optional(),
    }),
    userCreate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255),
        email: zod_1.z.string().email().max(255),
        password: zod_1.z.string().min(8).optional(),
        roles: zod_1.z.array(zod_1.z.number()).optional(),
        send_invite: zod_1.z.boolean().optional(),
    }),
    userUpdate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255).optional(),
        email: zod_1.z.string().email().max(255).optional(),
        password: zod_1.z.string().min(8).optional(),
        roles: zod_1.z.array(zod_1.z.number()).optional(),
        active: zod_1.z.boolean().optional(),
    }),
    // Roles
    rolesList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['display_name', 'created_at', 'updated_at']).default('display_name'),
    }),
    roleCreate: zod_1.z.object({
        display_name: zod_1.z.string().min(1).max(255),
        description: zod_1.z.string().max(1900).optional(),
        permissions: zod_1.z.array(zod_1.z.string()).optional(),
        mfa_enforced: zod_1.z.boolean().optional(),
    }),
    roleUpdate: zod_1.z.object({
        display_name: zod_1.z.string().min(1).max(255).optional(),
        description: zod_1.z.string().max(1900).optional(),
        permissions: zod_1.z.array(zod_1.z.string()).optional(),
        mfa_enforced: zod_1.z.boolean().optional(),
    }),
    // Attachments
    attachmentsList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['name', 'extension', 'uploaded_to', 'created_at', 'updated_at']).default('name'),
        filter: zod_1.z.object({
            name: zod_1.z.string().optional(),
            uploaded_to: zod_1.z.number().optional(),
            extension: zod_1.z.string().optional(),
        }).optional(),
    }),
    attachmentCreate: zod_1.z.object({
        uploaded_to: zod_1.z.number(),
        name: zod_1.z.string().min(1).max(255),
        file: zod_1.z.string().optional(), // base64 encoded
        link: zod_1.z.string().url().optional(),
    }).refine(data => data.file || data.link, {
        message: "Either file or link is required",
    }),
    attachmentUpdate: zod_1.z.object({
        uploaded_to: zod_1.z.number().optional(),
        name: zod_1.z.string().min(1).max(255).optional(),
        file: zod_1.z.string().optional(), // base64 encoded
        link: zod_1.z.string().url().optional(),
    }),
    // Images
    imagesList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['name', 'created_at', 'updated_at']).default('name'),
        filter: zod_1.z.object({
            name: zod_1.z.string().optional(),
            type: zod_1.z.enum(['gallery', 'drawio']).optional(),
        }).optional(),
    }),
    imageCreate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255),
        image: zod_1.z.string(), // base64 encoded
        type: zod_1.z.enum(['gallery', 'drawio']).default('gallery'),
    }),
    imageUpdate: zod_1.z.object({
        name: zod_1.z.string().min(1).max(255).optional(),
        image: zod_1.z.string().optional(), // base64 encoded
    }),
    // Search
    search: zod_1.z.object({
        query: zod_1.z.string().min(1),
        page: zod_1.z.number().min(1).default(1),
        count: zod_1.z.number().min(1).max(100).default(20),
    }),
    // Audit Log
    auditLogList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['created_at', 'type', 'user_id']).default('created_at'),
        filter: zod_1.z.object({
            type: zod_1.z.string().optional(),
            user_id: zod_1.z.number().optional(),
            entity_type: zod_1.z.string().optional(),
            entity_id: zod_1.z.number().optional(),
        }).optional(),
    }),
    // Content Permissions
    contentPermissionsUpdate: zod_1.z.object({
        permissions: zod_1.z.array(zod_1.z.object({
            role_id: zod_1.z.number(),
            view: zod_1.z.boolean(),
            create: zod_1.z.boolean(),
            update: zod_1.z.boolean(),
            delete: zod_1.z.boolean(),
        })),
    }),
    // Export
    export: zod_1.z.object({
        id: zod_1.z.number(),
        format: zod_1.z.enum(['html', 'pdf', 'plaintext', 'markdown']),
    }),
    // Generic ID parameter
    id: zod_1.z.object({
        id: zod_1.z.number().positive(),
    }),
    // Recycle bin operations
    recycleBinList: zod_1.z.object({
        count: zod_1.z.number().min(1).max(500).default(20),
        offset: zod_1.z.number().min(0).default(0),
        sort: zod_1.z.enum(['deleted_at', 'deletable_type', 'deletable_id']).default('deleted_at'),
    }),
    recycleBinOperation: zod_1.z.object({
        deletion_id: zod_1.z.number().positive(),
    }),
    // Content permissions
    contentPermissions: zod_1.z.object({
        content_type: zod_1.z.enum(['bookshelf', 'book', 'chapter', 'page']),
        content_id: zod_1.z.number().positive(),
    }),
};
/**
 * Validation handler
 */
class ValidationHandler {
    constructor(config) {
        this.enabled = config.enabled;
        this.strictMode = config.strictMode;
    }
    /**
     * Validate parameters against a schema
     */
    validateParams(params, schemaName) {
        if (!this.enabled) {
            return params;
        }
        const schema = ValidationSchemas[schemaName];
        if (!schema) {
            throw new Error(`No validation schema found for ${schemaName}`);
        }
        try {
            return schema.parse(params);
        }
        catch (error) {
            if (this.strictMode) {
                throw error;
            }
            // In non-strict mode, log the error but continue with original params
            console.warn(`Validation warning for ${schemaName}:`, error.message);
            return params;
        }
    }
    /**
     * Validate required fields are present
     */
    validateRequired(params, requiredFields) {
        if (!this.enabled) {
            return;
        }
        const missing = requiredFields.filter(field => params[field] === undefined || params[field] === null);
        if (missing.length > 0) {
            throw new Error(`Missing required fields: ${missing.join(', ')}`);
        }
    }
    /**
     * Validate ID parameter
     */
    validateId(id) {
        if (!this.enabled) {
            return Number(id);
        }
        const parsed = ValidationSchemas.id.parse({ id: Number(id) });
        return parsed.id;
    }
    /**
     * Get available schemas
     */
    getAvailableSchemas() {
        return Object.keys(ValidationSchemas);
    }
}
exports.ValidationHandler = ValidationHandler;
exports.default = ValidationHandler;
//# sourceMappingURL=validator.js.map
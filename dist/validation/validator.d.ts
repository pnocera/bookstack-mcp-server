import { z } from 'zod';
/**
 * Validation schemas for BookStack entities
 */
declare const ValidationSchemas: {
    pagination: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        count: number;
        offset: number;
        sort?: string | undefined;
    }, {
        sort?: string | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    booksList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["name", "created_at", "updated_at"]>>;
        filter: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            created_by: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            name?: string | undefined;
            created_by?: number | undefined;
        }, {
            name?: string | undefined;
            created_by?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        sort: "name" | "created_at" | "updated_at";
        count: number;
        offset: number;
        filter?: {
            name?: string | undefined;
            created_by?: number | undefined;
        } | undefined;
    }, {
        sort?: "name" | "created_at" | "updated_at" | undefined;
        filter?: {
            name?: string | undefined;
            created_by?: number | undefined;
        } | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    bookCreate: z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        description_html: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            name: string;
        }, {
            value: string;
            name: string;
        }>, "many">>;
        default_template_id: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        default_template_id?: number | undefined;
    }, {
        name: string;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        default_template_id?: number | undefined;
    }>;
    bookUpdate: z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        description_html: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            name: string;
        }, {
            value: string;
            name: string;
        }>, "many">>;
        default_template_id: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        name?: string | undefined;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        default_template_id?: number | undefined;
    }, {
        name?: string | undefined;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        default_template_id?: number | undefined;
    }>;
    pagesList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["name", "created_at", "updated_at", "priority"]>>;
        filter: z.ZodOptional<z.ZodObject<{
            book_id: z.ZodOptional<z.ZodNumber>;
            chapter_id: z.ZodOptional<z.ZodNumber>;
            name: z.ZodOptional<z.ZodString>;
            draft: z.ZodOptional<z.ZodBoolean>;
            template: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            name?: string | undefined;
            book_id?: number | undefined;
            chapter_id?: number | undefined;
            draft?: boolean | undefined;
            template?: boolean | undefined;
        }, {
            name?: string | undefined;
            book_id?: number | undefined;
            chapter_id?: number | undefined;
            draft?: boolean | undefined;
            template?: boolean | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        sort: "name" | "created_at" | "updated_at" | "priority";
        count: number;
        offset: number;
        filter?: {
            name?: string | undefined;
            book_id?: number | undefined;
            chapter_id?: number | undefined;
            draft?: boolean | undefined;
            template?: boolean | undefined;
        } | undefined;
    }, {
        sort?: "name" | "created_at" | "updated_at" | "priority" | undefined;
        filter?: {
            name?: string | undefined;
            book_id?: number | undefined;
            chapter_id?: number | undefined;
            draft?: boolean | undefined;
            template?: boolean | undefined;
        } | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    pageCreate: z.ZodEffects<z.ZodEffects<z.ZodObject<{
        book_id: z.ZodOptional<z.ZodNumber>;
        chapter_id: z.ZodOptional<z.ZodNumber>;
        name: z.ZodString;
        html: z.ZodOptional<z.ZodString>;
        markdown: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            name: string;
        }, {
            value: string;
            name: string;
        }>, "many">>;
        priority: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        html?: string | undefined;
        markdown?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
        chapter_id?: number | undefined;
    }, {
        name: string;
        html?: string | undefined;
        markdown?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
        chapter_id?: number | undefined;
    }>, {
        name: string;
        html?: string | undefined;
        markdown?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
        chapter_id?: number | undefined;
    }, {
        name: string;
        html?: string | undefined;
        markdown?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
        chapter_id?: number | undefined;
    }>, {
        name: string;
        html?: string | undefined;
        markdown?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
        chapter_id?: number | undefined;
    }, {
        name: string;
        html?: string | undefined;
        markdown?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
        chapter_id?: number | undefined;
    }>;
    pageUpdate: z.ZodObject<{
        book_id: z.ZodOptional<z.ZodNumber>;
        chapter_id: z.ZodOptional<z.ZodNumber>;
        name: z.ZodOptional<z.ZodString>;
        html: z.ZodOptional<z.ZodString>;
        markdown: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            name: string;
        }, {
            value: string;
            name: string;
        }>, "many">>;
        priority: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        name?: string | undefined;
        html?: string | undefined;
        markdown?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
        chapter_id?: number | undefined;
    }, {
        name?: string | undefined;
        html?: string | undefined;
        markdown?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
        chapter_id?: number | undefined;
    }>;
    chaptersList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["name", "created_at", "updated_at", "priority"]>>;
        filter: z.ZodOptional<z.ZodObject<{
            book_id: z.ZodOptional<z.ZodNumber>;
            name: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            name?: string | undefined;
            book_id?: number | undefined;
        }, {
            name?: string | undefined;
            book_id?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        sort: "name" | "created_at" | "updated_at" | "priority";
        count: number;
        offset: number;
        filter?: {
            name?: string | undefined;
            book_id?: number | undefined;
        } | undefined;
    }, {
        sort?: "name" | "created_at" | "updated_at" | "priority" | undefined;
        filter?: {
            name?: string | undefined;
            book_id?: number | undefined;
        } | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    chapterCreate: z.ZodObject<{
        name: z.ZodString;
        book_id: z.ZodNumber;
        description: z.ZodOptional<z.ZodString>;
        description_html: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            name: string;
        }, {
            value: string;
            name: string;
        }>, "many">>;
        priority: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        book_id: number;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
    }, {
        name: string;
        book_id: number;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
    }>;
    chapterUpdate: z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        book_id: z.ZodOptional<z.ZodNumber>;
        description: z.ZodOptional<z.ZodString>;
        description_html: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            name: string;
        }, {
            value: string;
            name: string;
        }>, "many">>;
        priority: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        name?: string | undefined;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
    }, {
        name?: string | undefined;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        priority?: number | undefined;
        book_id?: number | undefined;
    }>;
    shelvesList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["name", "created_at", "updated_at"]>>;
        filter: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            created_by: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            name?: string | undefined;
            created_by?: number | undefined;
        }, {
            name?: string | undefined;
            created_by?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        sort: "name" | "created_at" | "updated_at";
        count: number;
        offset: number;
        filter?: {
            name?: string | undefined;
            created_by?: number | undefined;
        } | undefined;
    }, {
        sort?: "name" | "created_at" | "updated_at" | undefined;
        filter?: {
            name?: string | undefined;
            created_by?: number | undefined;
        } | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    shelfCreate: z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        description_html: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            name: string;
        }, {
            value: string;
            name: string;
        }>, "many">>;
        books: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        books?: number[] | undefined;
    }, {
        name: string;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        books?: number[] | undefined;
    }>;
    shelfUpdate: z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        description_html: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            value: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            value: string;
            name: string;
        }, {
            value: string;
            name: string;
        }>, "many">>;
        books: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    }, "strip", z.ZodTypeAny, {
        name?: string | undefined;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        books?: number[] | undefined;
    }, {
        name?: string | undefined;
        description?: string | undefined;
        description_html?: string | undefined;
        tags?: {
            value: string;
            name: string;
        }[] | undefined;
        books?: number[] | undefined;
    }>;
    usersList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["name", "email", "created_at", "updated_at"]>>;
        filter: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            email: z.ZodOptional<z.ZodString>;
            active: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            name?: string | undefined;
            email?: string | undefined;
            active?: boolean | undefined;
        }, {
            name?: string | undefined;
            email?: string | undefined;
            active?: boolean | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        sort: "name" | "created_at" | "updated_at" | "email";
        count: number;
        offset: number;
        filter?: {
            name?: string | undefined;
            email?: string | undefined;
            active?: boolean | undefined;
        } | undefined;
    }, {
        sort?: "name" | "created_at" | "updated_at" | "email" | undefined;
        filter?: {
            name?: string | undefined;
            email?: string | undefined;
            active?: boolean | undefined;
        } | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    userCreate: z.ZodObject<{
        name: z.ZodString;
        email: z.ZodString;
        password: z.ZodOptional<z.ZodString>;
        roles: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        send_invite: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        email: string;
        password?: string | undefined;
        roles?: number[] | undefined;
        send_invite?: boolean | undefined;
    }, {
        name: string;
        email: string;
        password?: string | undefined;
        roles?: number[] | undefined;
        send_invite?: boolean | undefined;
    }>;
    userUpdate: z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        email: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodString>;
        roles: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
        active: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        name?: string | undefined;
        email?: string | undefined;
        active?: boolean | undefined;
        password?: string | undefined;
        roles?: number[] | undefined;
    }, {
        name?: string | undefined;
        email?: string | undefined;
        active?: boolean | undefined;
        password?: string | undefined;
        roles?: number[] | undefined;
    }>;
    rolesList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["display_name", "created_at", "updated_at"]>>;
    }, "strip", z.ZodTypeAny, {
        sort: "display_name" | "created_at" | "updated_at";
        count: number;
        offset: number;
    }, {
        sort?: "display_name" | "created_at" | "updated_at" | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    roleCreate: z.ZodObject<{
        display_name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        permissions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        mfa_enforced: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        display_name: string;
        description?: string | undefined;
        permissions?: string[] | undefined;
        mfa_enforced?: boolean | undefined;
    }, {
        display_name: string;
        description?: string | undefined;
        permissions?: string[] | undefined;
        mfa_enforced?: boolean | undefined;
    }>;
    roleUpdate: z.ZodObject<{
        display_name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        permissions: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        mfa_enforced: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        display_name?: string | undefined;
        description?: string | undefined;
        permissions?: string[] | undefined;
        mfa_enforced?: boolean | undefined;
    }, {
        display_name?: string | undefined;
        description?: string | undefined;
        permissions?: string[] | undefined;
        mfa_enforced?: boolean | undefined;
    }>;
    attachmentsList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["name", "extension", "uploaded_to", "created_at", "updated_at"]>>;
        filter: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            uploaded_to: z.ZodOptional<z.ZodNumber>;
            extension: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            name?: string | undefined;
            extension?: string | undefined;
            uploaded_to?: number | undefined;
        }, {
            name?: string | undefined;
            extension?: string | undefined;
            uploaded_to?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        sort: "name" | "created_at" | "updated_at" | "extension" | "uploaded_to";
        count: number;
        offset: number;
        filter?: {
            name?: string | undefined;
            extension?: string | undefined;
            uploaded_to?: number | undefined;
        } | undefined;
    }, {
        sort?: "name" | "created_at" | "updated_at" | "extension" | "uploaded_to" | undefined;
        filter?: {
            name?: string | undefined;
            extension?: string | undefined;
            uploaded_to?: number | undefined;
        } | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    attachmentCreate: z.ZodEffects<z.ZodObject<{
        uploaded_to: z.ZodNumber;
        name: z.ZodString;
        file: z.ZodOptional<z.ZodString>;
        link: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        uploaded_to: number;
        link?: string | undefined;
        file?: string | undefined;
    }, {
        name: string;
        uploaded_to: number;
        link?: string | undefined;
        file?: string | undefined;
    }>, {
        name: string;
        uploaded_to: number;
        link?: string | undefined;
        file?: string | undefined;
    }, {
        name: string;
        uploaded_to: number;
        link?: string | undefined;
        file?: string | undefined;
    }>;
    attachmentUpdate: z.ZodObject<{
        uploaded_to: z.ZodOptional<z.ZodNumber>;
        name: z.ZodOptional<z.ZodString>;
        file: z.ZodOptional<z.ZodString>;
        link: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name?: string | undefined;
        link?: string | undefined;
        uploaded_to?: number | undefined;
        file?: string | undefined;
    }, {
        name?: string | undefined;
        link?: string | undefined;
        uploaded_to?: number | undefined;
        file?: string | undefined;
    }>;
    imagesList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["name", "created_at", "updated_at"]>>;
        filter: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            type: z.ZodOptional<z.ZodEnum<["gallery", "drawio"]>>;
        }, "strip", z.ZodTypeAny, {
            type?: "gallery" | "drawio" | undefined;
            name?: string | undefined;
        }, {
            type?: "gallery" | "drawio" | undefined;
            name?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        sort: "name" | "created_at" | "updated_at";
        count: number;
        offset: number;
        filter?: {
            type?: "gallery" | "drawio" | undefined;
            name?: string | undefined;
        } | undefined;
    }, {
        sort?: "name" | "created_at" | "updated_at" | undefined;
        filter?: {
            type?: "gallery" | "drawio" | undefined;
            name?: string | undefined;
        } | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    imageCreate: z.ZodObject<{
        name: z.ZodString;
        image: z.ZodString;
        type: z.ZodDefault<z.ZodEnum<["gallery", "drawio"]>>;
    }, "strip", z.ZodTypeAny, {
        type: "gallery" | "drawio";
        name: string;
        image: string;
    }, {
        name: string;
        image: string;
        type?: "gallery" | "drawio" | undefined;
    }>;
    imageUpdate: z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        image: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name?: string | undefined;
        image?: string | undefined;
    }, {
        name?: string | undefined;
        image?: string | undefined;
    }>;
    search: z.ZodObject<{
        query: z.ZodString;
        page: z.ZodDefault<z.ZodNumber>;
        count: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        page: number;
        count: number;
        query: string;
    }, {
        query: string;
        page?: number | undefined;
        count?: number | undefined;
    }>;
    auditLogList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["created_at", "type", "user_id"]>>;
        filter: z.ZodOptional<z.ZodObject<{
            type: z.ZodOptional<z.ZodString>;
            user_id: z.ZodOptional<z.ZodNumber>;
            entity_type: z.ZodOptional<z.ZodString>;
            entity_id: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            type?: string | undefined;
            user_id?: number | undefined;
            entity_type?: string | undefined;
            entity_id?: number | undefined;
        }, {
            type?: string | undefined;
            user_id?: number | undefined;
            entity_type?: string | undefined;
            entity_id?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        sort: "type" | "created_at" | "user_id";
        count: number;
        offset: number;
        filter?: {
            type?: string | undefined;
            user_id?: number | undefined;
            entity_type?: string | undefined;
            entity_id?: number | undefined;
        } | undefined;
    }, {
        sort?: "type" | "created_at" | "user_id" | undefined;
        filter?: {
            type?: string | undefined;
            user_id?: number | undefined;
            entity_type?: string | undefined;
            entity_id?: number | undefined;
        } | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    contentPermissionsUpdate: z.ZodObject<{
        permissions: z.ZodArray<z.ZodObject<{
            role_id: z.ZodNumber;
            view: z.ZodBoolean;
            create: z.ZodBoolean;
            update: z.ZodBoolean;
            delete: z.ZodBoolean;
        }, "strip", z.ZodTypeAny, {
            delete: boolean;
            role_id: number;
            view: boolean;
            create: boolean;
            update: boolean;
        }, {
            delete: boolean;
            role_id: number;
            view: boolean;
            create: boolean;
            update: boolean;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        permissions: {
            delete: boolean;
            role_id: number;
            view: boolean;
            create: boolean;
            update: boolean;
        }[];
    }, {
        permissions: {
            delete: boolean;
            role_id: number;
            view: boolean;
            create: boolean;
            update: boolean;
        }[];
    }>;
    export: z.ZodObject<{
        id: z.ZodNumber;
        format: z.ZodEnum<["html", "pdf", "plaintext", "markdown"]>;
    }, "strip", z.ZodTypeAny, {
        format: "html" | "pdf" | "plaintext" | "markdown";
        id: number;
    }, {
        format: "html" | "pdf" | "plaintext" | "markdown";
        id: number;
    }>;
    id: z.ZodObject<{
        id: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        id: number;
    }, {
        id: number;
    }>;
    recycleBinList: z.ZodObject<{
        count: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        sort: z.ZodDefault<z.ZodEnum<["deleted_at", "deletable_type", "deletable_id"]>>;
    }, "strip", z.ZodTypeAny, {
        sort: "deleted_at" | "deletable_type" | "deletable_id";
        count: number;
        offset: number;
    }, {
        sort?: "deleted_at" | "deletable_type" | "deletable_id" | undefined;
        count?: number | undefined;
        offset?: number | undefined;
    }>;
    recycleBinOperation: z.ZodObject<{
        deletion_id: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        deletion_id: number;
    }, {
        deletion_id: number;
    }>;
    contentPermissions: z.ZodObject<{
        content_type: z.ZodEnum<["bookshelf", "book", "chapter", "page"]>;
        content_id: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        content_type: "bookshelf" | "book" | "chapter" | "page";
        content_id: number;
    }, {
        content_type: "bookshelf" | "book" | "chapter" | "page";
        content_id: number;
    }>;
};
/**
 * Validation handler
 */
export declare class ValidationHandler {
    private enabled;
    private strictMode;
    constructor(config: {
        enabled: boolean;
        strictMode: boolean;
    });
    /**
     * Validate parameters against a schema
     */
    validateParams<T>(params: any, schemaName: keyof typeof ValidationSchemas): T;
    /**
     * Validate required fields are present
     */
    validateRequired(params: any, requiredFields: string[]): void;
    /**
     * Validate ID parameter
     */
    validateId(id: any): number;
    /**
     * Get available schemas
     */
    getAvailableSchemas(): string[];
}
export default ValidationHandler;
//# sourceMappingURL=validator.d.ts.map
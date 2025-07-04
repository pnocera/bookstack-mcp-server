/**
 * TypeScript interfaces for BookStack MCP Server
 * Generated from comprehensive API analysis
 */
export interface Book {
    id: number;
    name: string;
    slug: string;
    description?: string;
    description_html?: string;
    created_at: string;
    updated_at: string;
    created_by: number;
    updated_by: number;
    owned_by: number;
    image_id?: number;
    default_template_id?: number;
    tags: Tag[];
    cover?: Image;
}
export interface BookWithContents extends Book {
    contents: (Chapter | Page)[];
}
export interface Page {
    id: number;
    book_id: number;
    chapter_id?: number;
    name: string;
    slug: string;
    priority: number;
    draft: boolean;
    template: boolean;
    created_at: string;
    updated_at: string;
    created_by: number;
    updated_by: number;
    owned_by: number;
    revision_count: number;
    editor: string;
    tags: Tag[];
}
export interface PageWithContent extends Page {
    html: string;
    raw_html: string;
    markdown?: string;
}
export interface Chapter {
    id: number;
    book_id: number;
    name: string;
    slug: string;
    description?: string;
    description_html?: string;
    priority: number;
    created_at: string;
    updated_at: string;
    created_by: number;
    updated_by: number;
    owned_by: number;
    tags: Tag[];
}
export interface ChapterWithPages extends Chapter {
    pages: Page[];
}
export interface Bookshelf {
    id: number;
    name: string;
    slug: string;
    description?: string;
    description_html?: string;
    created_at: string;
    updated_at: string;
    created_by: number;
    updated_by: number;
    owned_by: number;
    image_id?: number;
    tags: Tag[];
    cover?: Image;
}
export interface BookshelfWithBooks extends Bookshelf {
    books: Book[];
}
export interface User {
    id: number;
    name: string;
    email: string;
    avatar_url?: string;
    external_auth_id?: string;
    slug: string;
    created_at: string;
    updated_at: string;
    last_activity_at?: string;
}
export interface UserWithRoles extends User {
    roles: Role[];
}
export interface Role {
    id: number;
    display_name: string;
    description?: string;
    mfa_enforced: boolean;
    external_auth_id?: string;
    created_at: string;
    updated_at: string;
}
export interface RoleWithPermissions extends Role {
    permissions: string[];
}
export interface Attachment {
    id: number;
    name: string;
    extension: string;
    uploaded_to: number;
    external: boolean;
    order: number;
    created_at: string;
    updated_at: string;
    created_by: number;
    updated_by: number;
    links: {
        html: string;
        markdown: string;
    };
}
export interface Image {
    id: number;
    name: string;
    url: string;
    type: string;
    path: string;
    created_at: string;
    updated_at: string;
    created_by: number;
    updated_by: number;
}
export interface Tag {
    name: string;
    value: string;
    order: number;
}
export interface SearchResult {
    id: number;
    name: string;
    slug: string;
    type: 'bookshelf' | 'book' | 'chapter' | 'page';
    url: string;
    preview_html: {
        name: string;
        content: string;
    };
    tags: Tag[];
    book?: Book;
    chapter?: Chapter;
}
export interface RecycleBinItem {
    id: number;
    deleted_at: string;
    deletable_type: string;
    deletable_id: number;
    deleted_by: number;
    deletable: any;
}
export interface ContentPermissions {
    inheriting: boolean;
    permissions: {
        role_id: number;
        role_name: string;
        view: boolean;
        create: boolean;
        update: boolean;
        delete: boolean;
    }[];
}
export interface AuditLogEntry {
    id: number;
    type: string;
    detail: string;
    user_id: number;
    entity_type?: string;
    entity_id?: number;
    ip: string;
    created_at: string;
    user: User;
    entity?: any;
}
export interface SystemInfo {
    version: string;
    instance_id: string;
    php_version: string;
    theme: string;
    language: string;
    timezone: string;
    app_url: string;
    drawing_enabled: boolean;
    registrations_enabled: boolean;
    upload_limit: number;
}
export interface ListResponse<T> {
    data: T[];
    total: number;
}
export interface ErrorResponse {
    error: {
        code: number;
        message: string;
        validation?: Record<string, string[]>;
    };
}
export interface MCPServerConfig {
    name: string;
    version: string;
    description: string;
    baseUrl: string;
    apiToken: string;
    rateLimit: {
        requestsPerMinute: number;
        burstLimit: number;
    };
    retryPolicy: {
        enabled: boolean;
        maxRetries: number;
        backoffStrategy: 'exponential' | 'linear';
        retryableStatusCodes: number[];
    };
    validation: {
        enabled: boolean;
        strictMode: boolean;
    };
}
export interface PaginationParams {
    count?: number;
    offset?: number;
    sort?: string;
}
export interface BooksListParams extends PaginationParams {
    filter?: {
        name?: string;
        created_by?: number;
    };
}
export interface PagesListParams extends PaginationParams {
    filter?: {
        book_id?: number;
        chapter_id?: number;
        name?: string;
        draft?: boolean;
        template?: boolean;
    };
}
export interface ChaptersListParams extends PaginationParams {
    filter?: {
        book_id?: number;
        name?: string;
    };
}
export interface ShelvesListParams extends PaginationParams {
    filter?: {
        name?: string;
        created_by?: number;
    };
}
export interface UsersListParams extends PaginationParams {
    filter?: {
        name?: string;
        email?: string;
        active?: boolean;
    };
}
export interface RolesListParams extends PaginationParams {
    sort?: 'display_name' | 'created_at' | 'updated_at';
}
export interface AttachmentsListParams extends PaginationParams {
    filter?: {
        name?: string;
        uploaded_to?: number;
        extension?: string;
    };
}
export interface SearchParams {
    query: string;
    page?: number;
    count?: number;
}
export interface ImageGalleryListParams extends PaginationParams {
    filter?: {
        name?: string;
        type?: 'gallery' | 'drawio';
    };
}
export interface AuditLogListParams extends PaginationParams {
    filter?: {
        type?: string;
        user_id?: number;
        entity_type?: string;
        entity_id?: number;
    };
}
export interface CreateBookParams {
    name: string;
    description?: string;
    description_html?: string;
    tags?: Tag[];
    default_template_id?: number;
}
export interface UpdateBookParams {
    name?: string;
    description?: string;
    description_html?: string;
    tags?: Tag[];
    default_template_id?: number;
}
export interface CreatePageParams {
    book_id?: number;
    chapter_id?: number;
    name: string;
    html?: string;
    markdown?: string;
    tags?: Tag[];
    priority?: number;
}
export interface UpdatePageParams {
    book_id?: number;
    chapter_id?: number;
    name?: string;
    html?: string;
    markdown?: string;
    tags?: Tag[];
    priority?: number;
}
export interface CreateChapterParams {
    name: string;
    book_id: number;
    description?: string;
    description_html?: string;
    tags?: Tag[];
    priority?: number;
}
export interface UpdateChapterParams {
    name?: string;
    book_id?: number;
    description?: string;
    description_html?: string;
    tags?: Tag[];
    priority?: number;
}
export interface CreateShelfParams {
    name: string;
    description?: string;
    description_html?: string;
    tags?: Tag[];
    books?: number[];
}
export interface UpdateShelfParams {
    name?: string;
    description?: string;
    description_html?: string;
    tags?: Tag[];
    books?: number[];
}
export interface CreateUserParams {
    name: string;
    email: string;
    password?: string;
    roles?: number[];
    send_invite?: boolean;
}
export interface UpdateUserParams {
    name?: string;
    email?: string;
    password?: string;
    roles?: number[];
    active?: boolean;
}
export interface CreateRoleParams {
    display_name: string;
    description?: string;
    permissions?: string[];
    mfa_enforced?: boolean;
}
export interface UpdateRoleParams {
    display_name?: string;
    description?: string;
    permissions?: string[];
    mfa_enforced?: boolean;
}
export interface CreateAttachmentParams {
    uploaded_to: number;
    name: string;
    file?: string;
    link?: string;
}
export interface UpdateAttachmentParams {
    uploaded_to?: number;
    name?: string;
    file?: string;
    link?: string;
}
export interface CreateImageParams {
    name: string;
    image: string;
    type?: 'gallery' | 'drawio';
}
export interface UpdateImageParams {
    name?: string;
    image?: string;
}
export interface UpdateContentPermissionsParams {
    permissions: {
        role_id: number;
        view: boolean;
        create: boolean;
        update: boolean;
        delete: boolean;
    }[];
}
export interface MCPTool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
    handler: (params: any) => Promise<any>;
}
export interface MCPResource {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
    handler: (uri: string) => Promise<any>;
}
export type ExportFormat = 'html' | 'pdf' | 'plaintext' | 'markdown';
export interface ExportResult {
    content: string;
    filename: string;
    mime_type: string;
}
export type ContentType = 'bookshelf' | 'book' | 'chapter' | 'page';
export interface BookStackAPIClient {
    listBooks(params?: BooksListParams): Promise<ListResponse<Book>>;
    createBook(params: CreateBookParams): Promise<Book>;
    getBook(id: number): Promise<BookWithContents>;
    updateBook(id: number, params: UpdateBookParams): Promise<Book>;
    deleteBook(id: number): Promise<void>;
    exportBook(id: number, format: ExportFormat): Promise<ExportResult>;
    listPages(params?: PagesListParams): Promise<ListResponse<Page>>;
    createPage(params: CreatePageParams): Promise<Page>;
    getPage(id: number): Promise<PageWithContent>;
    updatePage(id: number, params: UpdatePageParams): Promise<Page>;
    deletePage(id: number): Promise<void>;
    exportPage(id: number, format: ExportFormat): Promise<ExportResult>;
    listChapters(params?: ChaptersListParams): Promise<ListResponse<Chapter>>;
    createChapter(params: CreateChapterParams): Promise<Chapter>;
    getChapter(id: number): Promise<ChapterWithPages>;
    updateChapter(id: number, params: UpdateChapterParams): Promise<Chapter>;
    deleteChapter(id: number): Promise<void>;
    exportChapter(id: number, format: ExportFormat): Promise<ExportResult>;
    listShelves(params?: ShelvesListParams): Promise<ListResponse<Bookshelf>>;
    createShelf(params: CreateShelfParams): Promise<Bookshelf>;
    getShelf(id: number): Promise<BookshelfWithBooks>;
    updateShelf(id: number, params: UpdateShelfParams): Promise<Bookshelf>;
    deleteShelf(id: number): Promise<void>;
    listUsers(params?: UsersListParams): Promise<ListResponse<User>>;
    createUser(params: CreateUserParams): Promise<User>;
    getUser(id: number): Promise<UserWithRoles>;
    updateUser(id: number, params: UpdateUserParams): Promise<User>;
    deleteUser(id: number, migrateOwnershipId?: number): Promise<void>;
    listRoles(params?: RolesListParams): Promise<ListResponse<Role>>;
    createRole(params: CreateRoleParams): Promise<Role>;
    getRole(id: number): Promise<RoleWithPermissions>;
    updateRole(id: number, params: UpdateRoleParams): Promise<Role>;
    deleteRole(id: number, migrateOwnershipId?: number): Promise<void>;
    listAttachments(params?: AttachmentsListParams): Promise<ListResponse<Attachment>>;
    createAttachment(params: CreateAttachmentParams): Promise<Attachment>;
    getAttachment(id: number): Promise<Attachment>;
    updateAttachment(id: number, params: UpdateAttachmentParams): Promise<Attachment>;
    deleteAttachment(id: number): Promise<void>;
    listImages(params?: ImageGalleryListParams): Promise<ListResponse<Image>>;
    createImage(params: CreateImageParams): Promise<Image>;
    getImage(id: number): Promise<Image>;
    updateImage(id: number, params: UpdateImageParams): Promise<Image>;
    deleteImage(id: number): Promise<void>;
    search(params: SearchParams): Promise<ListResponse<SearchResult>>;
    listRecycleBin(params?: PaginationParams): Promise<ListResponse<RecycleBinItem>>;
    restoreFromRecycleBin(deletionId: number): Promise<void>;
    permanentlyDelete(deletionId: number): Promise<void>;
    getContentPermissions(contentType: ContentType, contentId: number): Promise<ContentPermissions>;
    updateContentPermissions(contentType: ContentType, contentId: number, params: UpdateContentPermissionsParams): Promise<ContentPermissions>;
    listAuditLog(params?: AuditLogListParams): Promise<ListResponse<AuditLogEntry>>;
    getSystemInfo(): Promise<SystemInfo>;
}
//# sourceMappingURL=types.d.ts.map
import { Config } from '../config/manager';
import { Logger } from '../utils/logger';
import { ErrorHandler } from '../utils/errors';
import { BookStackAPIClient, Book, BookWithContents, Page, PageWithContent, Chapter, ChapterWithPages, Bookshelf, BookshelfWithBooks, User, UserWithRoles, Role, RoleWithPermissions, Attachment, Image, SearchResult, RecycleBinItem, ContentPermissions, AuditLogEntry, SystemInfo, ListResponse, BooksListParams, PagesListParams, ChaptersListParams, ShelvesListParams, UsersListParams, RolesListParams, AttachmentsListParams, SearchParams, ImageGalleryListParams, AuditLogListParams, CreateBookParams, UpdateBookParams, CreatePageParams, UpdatePageParams, CreateChapterParams, UpdateChapterParams, CreateShelfParams, UpdateShelfParams, CreateUserParams, UpdateUserParams, CreateRoleParams, UpdateRoleParams, CreateAttachmentParams, UpdateAttachmentParams, CreateImageParams, UpdateImageParams, UpdateContentPermissionsParams, ExportFormat, ExportResult, ContentType, PaginationParams } from '../types';
/**
 * BookStack API Client
 *
 * Provides a comprehensive wrapper around the BookStack REST API
 * with built-in error handling, rate limiting, and retry logic.
 */
export declare class BookStackClient implements BookStackAPIClient {
    private client;
    private logger;
    private errorHandler;
    private rateLimiter;
    private config;
    constructor(config: Config, logger: Logger, errorHandler: ErrorHandler);
    /**
     * Setup request and response interceptors
     */
    private setupInterceptors;
    /**
     * Generic request method with retry logic
     */
    private request;
    /**
     * Health check method
     */
    healthCheck(): Promise<boolean>;
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
export default BookStackClient;
//# sourceMappingURL=client.d.ts.map
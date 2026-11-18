import type { BookStackClient } from '../api/client';
import {
  type MCPTool,
  NONBLANK_PATTERN,
  type ScopedSearchParams,
  type SearchParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { ValidationHandler } from '../validation/validator';

/**
 * Search tools for BookStack MCP Server
 *
 * Provides comprehensive search functionality across all content types
 */
export class SearchTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all search tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createSearchTool(),
      this.createSearchBookTool(),
      this.createSearchChapterTool(),
    ]);
  }

  /**
   * Search tool
   */
  private createSearchTool(): MCPTool {
    return {
      name: 'bookstack_search',
      description:
        'Search across all BookStack content (shelves, books, chapters & pages). Supports advanced query syntax. Each result carries a `type` of bookshelf, book, chapter or page. Note: Page results only contain snippets of content, on `preview_html`. To read the full content of a page, use the `bookstack_pages_read` tool with the page ID from the search results.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            // BookStack's rule is `['required']`, and Laravel's `required` is judged after
            // the global TrimStrings middleware - so a query of spaces is missing, not
            // short. `minLength: 1` counted the spaces and offered a call that upstream
            // answers with 422 "The query field is required." (verified live on v26.05.2;
            // see NONBLANK_PATTERN in src/types.ts for the shared rule and R5-W4 for the
            // gap this closes).
            pattern: NONBLANK_PATTERN,
            description:
              'Search query string. Must contain a non-whitespace character: BookStack trims the query before validating, so "   " is rejected as missing rather than searched for. Bare terms match names and content. Advanced syntax: "exact phrase"; [tag] or [tag=value] for tags; {type:page|book|chapter|bookshelf} (combine types with |); {created_by:me} (also updated_by / owned_by, taking `me` or a username slug); {in_name:text}; {in_body:text}. Negate an exact phrase, tag or filter with a leading "-" (-"phrase", -[tag], -{filter}); a bare term cannot be negated. IMPORTANT: an unrecognised {filter:...} term is silently discarded rather than rejected, which makes the query match everything - so use the tag syntax [name=value], never {tag:name=value}.',
          },
          page: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: 'Page number for pagination.',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20,
            description: 'Results per page.',
          },
        },
      },
      examples: [
        {
          description: 'Search for "API" in pages only',
          input: { query: 'API {type:page}' },
          expected_output: 'List of matching pages',
          use_case: 'Finding specific documentation',
        },
        {
          description: 'Search by tag',
          input: { query: '[status=active]' },
          expected_output: 'Content tagged status=active',
          use_case: 'Filtering by metadata',
        },
        {
          description: 'Find shelves created by the calling user',
          input: { query: '{type:bookshelf} {created_by:me}' },
          expected_output: 'Bookshelves the authenticated user created',
          use_case: 'Reviewing your own collections',
        },
      ],
      usage_patterns: [
        'Search for pages with desired info, then read the page.',
        'Restrict the result types with `{type:book}` etc. A book or chapter matches on its own name and description only - the text of the pages inside it is matched by `{type:page}` results instead.',
        'Newly created or edited content is indexed immediately, so it is searchable on the very next query.',
        'If a filtered query unexpectedly returns everything, suspect a mistyped filter: BookStack drops unknown {filter:...} terms silently instead of erroring.',
      ],
      related_tools: ['bookstack_pages_read', 'bookstack_books_list'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description:
            'Empty or whitespace-only query. BookStack trims the value first, so "   " is missing rather than short - upstream answers 422 "The query field is required."',
          recovery_suggestion: 'Provide a search term with at least one non-whitespace character',
        },
      ],
      handler: async (params: unknown) => {
        // Validated before it is read, here and in every other handler: nothing in this
        // file casts a request into a type it has not been checked against.
        const validatedParams = this.validator.validateParams<SearchParams>(params, 'search');
        // The query's SIZE, not the query. R5-W3 found this line writing the caller's whole
        // search string at `info` - the default level - and a search term is the last thing
        // that should be assumed innocuous: it is routinely a person's name, a case
        // reference, or a phrase copied out of the document being looked for. The length,
        // the page and the count are what make the line operationally useful, and none of
        // them is the caller's text. (The central redactor would now reduce `query` to its
        // size anyway; this says the same thing on purpose rather than by rescue.)
        this.logger.info('Searching content', {
          query_length: validatedParams.query.length,
          page: validatedParams.page,
          count: validatedParams.count,
        });
        return await this.client.search(validatedParams);
      },
    };
  }

  /**
   * Book-scoped search.
   *
   * Deliberately a separate tool rather than an optional `book_id` on bookstack_search.
   * The two scopes are mutually exclusive, which in one schema means a top-level `oneOf`
   * or `allOf` - and several MCP clients reject a tool schema carrying a top-level
   * combinator outright, taking the whole tool list down with it rather than just the call.
   * One required id per tool needs no combinator at all.
   */
  private createSearchBookTool(): MCPTool {
    return {
      name: 'bookstack_search_book',
      description:
        'Search within ONE book, by its id. Returns the pages and chapters inside that book which match the query, in the same shape as bookstack_search. Use this instead of bookstack_search whenever the search belongs to a known book: an unscoped search ranges over the whole instance, so on a large wiki the wanted page competes with every other book.',
      inputSchema: {
        type: 'object',
        required: ['id', 'query'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'Id of the book to search inside. From bookstack_books_list or a search result.',
          },
          query: {
            type: 'string',
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            description:
              'Search query string, same syntax as bookstack_search. Must contain a non-whitespace character. A {type:...} term can NARROW what comes back but cannot widen it past this book.',
          },
          page: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: 'Page number for pagination.',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20,
            description: 'Results per page.',
          },
        },
      },
      examples: [
        {
          description: 'Find the onboarding page inside one book',
          input: { id: 12, query: 'onboarding' },
          expected_output: 'Matching pages and chapters from book 12 only',
          use_case: 'Looking something up in a known handbook',
        },
      ],
      usage_patterns: [
        'Resolve the book first (bookstack_books_list or a bookstack_search with {type:book}), then search inside it.',
        'Results cover pages and chapters within the book. Shelves and the book record itself are out of scope by construction.',
      ],
      related_tools: ['bookstack_search', 'bookstack_search_chapter', 'bookstack_books_list'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description:
            'Missing or whitespace-only query, or an id below 1. BookStack casts the id with intval and does not validate it, so 0 would answer 200 with an empty set - indistinguishable from a book that simply holds no match.',
          recovery_suggestion: 'Pass a positive book id and a query with at least one non-whitespace character',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<ScopedSearchParams>(
          params,
          'searchBook'
        );
        // The id and the SIZE of the query, never the query: a search term is routinely a
        // person's name or a phrase copied out of the document being looked for.
        this.logger.info('Searching within book', {
          book_id: validatedParams.id,
          query_length: validatedParams.query.length,
          page: validatedParams.page,
          count: validatedParams.count,
        });
        return await this.client.searchBook(validatedParams);
      },
    };
  }

  /**
   * Chapter-scoped search. Same reasoning as createSearchBookTool.
   */
  private createSearchChapterTool(): MCPTool {
    return {
      name: 'bookstack_search_chapter',
      description:
        'Search within ONE chapter, by its id. Returns the pages inside that chapter which match the query, in the same shape as bookstack_search. Narrower than bookstack_search_book: use it when the chapter is known.',
      inputSchema: {
        type: 'object',
        required: ['id', 'query'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'Id of the chapter to search inside. From bookstack_chapters_list or a search result.',
          },
          query: {
            type: 'string',
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            description:
              'Search query string, same syntax as bookstack_search. Must contain a non-whitespace character. A {type:...} term can NARROW what comes back but cannot widen it past this chapter.',
          },
          page: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: 'Page number for pagination.',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20,
            description: 'Results per page.',
          },
        },
      },
      examples: [
        {
          description: 'Find a step inside one chapter',
          input: { id: 193, query: 'rollback' },
          expected_output: 'Matching pages from chapter 193 only',
          use_case: 'Locating a step in a known runbook chapter',
        },
      ],
      usage_patterns: [
        'Resolve the chapter first (bookstack_chapters_list or a search result carrying a chapter), then search inside it.',
        'Results are pages only: a chapter holds no chapters.',
      ],
      related_tools: ['bookstack_search', 'bookstack_search_book', 'bookstack_chapters_list'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description:
            'Missing or whitespace-only query, or an id below 1. As with the book endpoint, BookStack does not validate the id, so 0 answers 200 with an empty set.',
          recovery_suggestion: 'Pass a positive chapter id and a query with at least one non-whitespace character',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<ScopedSearchParams>(
          params,
          'searchChapter'
        );
        this.logger.info('Searching within chapter', {
          chapter_id: validatedParams.id,
          query_length: validatedParams.query.length,
          page: validatedParams.page,
          count: validatedParams.count,
        });
        return await this.client.searchChapter(validatedParams);
      },
    };
  }
}

export default SearchTools;

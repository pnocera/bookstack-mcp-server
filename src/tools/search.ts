import type { BookStackClient } from '../api/client';
import { type MCPTool, NONBLANK_PATTERN, type SearchParams, withClosedSchemas } from '../types';
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
    return withClosedSchemas([this.createSearchTool()]);
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
}

export default SearchTools;

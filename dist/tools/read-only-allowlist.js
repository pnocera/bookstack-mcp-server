"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.READ_ONLY_TOOL_ALLOWLIST = void 0;
/**
 * Canonical allowlist of tool names available in PUBLIC_READ_ONLY mode.
 *
 * Any tool NOT in this set is filtered out at registration time (setupTools)
 * and blocked at invocation time (CallToolRequestSchema handler).
 *
 * To support a new read-only tool, add its exact name here.
 */
exports.READ_ONLY_TOOL_ALLOWLIST = new Set([
    // Books — read-only
    'bookstack_books_list',
    'bookstack_books_read',
    'bookstack_books_export',
    // Pages — read-only
    'bookstack_pages_list',
    'bookstack_pages_read',
    'bookstack_pages_export',
    // Chapters — read-only
    'bookstack_chapters_list',
    'bookstack_chapters_read',
    'bookstack_chapters_export',
    // Shelves — read-only
    'bookstack_shelves_list',
    'bookstack_shelves_read',
    // Search
    'bookstack_search',
    // System info (read-only)
    'bookstack_system_info',
    // Server meta tools (self-description, no side effects)
    'bookstack_server_info',
    'bookstack_tool_categories',
    'bookstack_usage_examples',
    'bookstack_error_guides',
    'bookstack_help',
]);
//# sourceMappingURL=read-only-allowlist.js.map
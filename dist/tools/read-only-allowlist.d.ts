/**
 * Canonical allowlist of tool names available in PUBLIC_READ_ONLY mode.
 *
 * Any tool NOT in this set is filtered out at registration time (setupTools)
 * and blocked at invocation time (CallToolRequestSchema handler).
 *
 * To support a new read-only tool, add its exact name here.
 */
export declare const READ_ONLY_TOOL_ALLOWLIST: Set<string>;
//# sourceMappingURL=read-only-allowlist.d.ts.map
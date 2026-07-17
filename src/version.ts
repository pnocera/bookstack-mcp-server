import pkg from '../package.json' with { type: 'json' };

/**
 * The single source of truth for the version this server reports.
 *
 * It is read from package.json because that is the ONE file release-please's node
 * strategy actually rewrites — it updates package.json, the lockfile and the
 * CHANGELOG, and does not touch arbitrary TypeScript or env files. A version
 * literal anywhere else in src/ silently keeps its old value through a release,
 * so a 2.0.0 tarball would introduce itself as 1.0.0 over MCP initialize, from
 * GET /, and from bookstack_server_info — exactly the artifact clients use to
 * tell the Node-capable 1.0.0 server from the Bun-only 2.0.0 one. npm always
 * ships package.json in the tarball, so this resolves for consumers too.
 */
export const VERSION: string = pkg.version;

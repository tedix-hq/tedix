export const DOCS_TOOL_SCOPES = {
	list_docs_sites: "mcp:content.read",
	get_docs_site: "mcp:content.read",
	list_docs_builds: "mcp:content.read",
	get_docs_build: "mcp:content.read",
	get_docs_preview_link: "mcp:content.read",
	list_docs_releases: "mcp:content.read",
	list_docs_changes: "mcp:content.read",
	get_docs_change: "mcp:content.read",
	list_docs_files: "mcp:content.read",
	get_docs_file: "mcp:content.read",
	get_docs_diff: "mcp:content.read",
	search_docs: "mcp:content.read",
	start_docs_build: "mcp:content.write",
	propose_docs_change: "mcp:content.write",
	validate_docs_change: "mcp:content.write",
	upsert_docs_site: "mcp:content.admin",
	import_docs_repository: "mcp:content.admin",
	commit_docs_change: "mcp:content.admin",
	publish_docs_build: "mcp:content.admin",
	rollback_docs_build: "mcp:content.admin",
} as const;

export type DocsToolName = keyof typeof DOCS_TOOL_SCOPES;
export type DocsDelegatedScope = (typeof DOCS_TOOL_SCOPES)[DocsToolName];

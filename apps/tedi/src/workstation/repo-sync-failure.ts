export function repoSyncFailure(repoUrl: string, detail: string): string {
	if (!URL.canParse(repoUrl)) return detail;
	const url = new URL(repoUrl);
	if (url.hostname !== "github.com") return detail;
	const repository = url.pathname
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/, "");
	if (
		!/blocked host|egress blocked|github_app_(?:upstream_(?:401|403|404|422)|scope_invalid|token_invalid|installation_invalid)|github_repository_scope_mismatch|authentication failed|repository not found|could not read Username|(?:HTTP|error:)\s*40[134]/i.test(
			detail,
		)
	)
		return detail;
	return [
		`GitHub repository access blocked for ${repository}. Do not retry git clone or push until access changes.`,
		"Use GitHub MCP tools or a codeload tarball for read-only source inspection; an archive does not provide Git history or push authority.",
		`For commit/push, the repository owner must grant the coding broker GitHub App access to ${repository}; then verify the configured repository-scoped broker route and egress policy. Keep tokens at the egress broker, never on container disk.`,
		detail,
	].join("\n");
}

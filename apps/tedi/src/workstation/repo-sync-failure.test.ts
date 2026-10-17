import { describe, expect, it } from "vite-plus/test";
import { repoSyncFailure } from "./repo-sync-failure";

describe("repository access failures", () => {
	it.each([
		"fatal: unable to access: 403 Egress blocked: Blocked host",
		"github_app_upstream_422",
		"fatal: repository not found",
	])("gives a bounded recovery for %s", (detail) => {
		const result = repoSyncFailure(
			"https://github.com/example/project.git",
			detail,
		);
		expect(result).toContain(
			"Do not retry git clone or push until access changes",
		);
		expect(result).toContain("GitHub MCP tools or a codeload tarball");
		expect(result).toContain("GitHub App access to example/project");
		expect(result).toContain(detail);
	});
	it("preserves unrelated failures without inventing an access diagnosis", () => {
		expect(
			repoSyncFailure("https://github.com/example/project.git", "disk full"),
		).toBe("disk full");
		expect(
			repoSyncFailure(
				"https://github.com/example/project.git",
				"github_app_upstream_503",
			),
		).toBe("github_app_upstream_503");
		expect(repoSyncFailure("invalid-url", "disk full")).toBe("disk full");
		expect(repoSyncFailure("file:///tmp/project", "repository not found")).toBe(
			"repository not found",
		);
	});
});

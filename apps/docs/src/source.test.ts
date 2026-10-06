import { describe, expect, it } from "vite-plus/test";
import {
	assertArtifactsRepositoryUrl,
	assertBranch,
	assertContentRoot,
	assertRepositoryUrl,
	assertSlug,
	docsContentFindExclusions,
	gitProviderAuthorization,
	shellQuote,
} from "./source";

describe("docs source validation", () => {
	it("accepts safe tenant and Git coordinates", () => {
		expect(assertSlug("acme-docs")).toBe("acme-docs");
		expect(assertBranch("release/v2")).toBe("release/v2");
		expect(assertContentRoot("./documentation")).toBe("documentation");
		expect(
			assertRepositoryUrl("github", "https://github.com/acme/docs.git"),
		).toBe("https://github.com/acme/docs.git");
	});

	it("rejects traversal, credentials, private hosts, and wrong providers", () => {
		expect(() => assertContentRoot("../secrets")).toThrow();
		expect(() => assertBranch("main; curl bad")).toThrow();
		expect(() =>
			assertRepositoryUrl("generic", "https://token@example.com/private.git"),
		).toThrow();
		expect(() =>
			assertRepositoryUrl("generic", "https://127.0.0.1/repo.git"),
		).toThrow();
		expect(() =>
			assertRepositoryUrl("github", "https://gitlab.com/acme/docs.git"),
		).toThrow();
	});

	it("binds an Artifacts remote to the selected repository", () => {
		const remote =
			"https://00000000000000000000000000000000.artifacts.cloudflare.net/git/example-account/tedix-public-docs.git";
		expect(assertArtifactsRepositoryUrl(remote, "tedix-public-docs")).toBe(
			remote,
		);
		expect(() =>
			assertArtifactsRepositoryUrl(remote, "another-repository"),
		).toThrow();
	});

	it("quotes shell values without changing their content", () => {
		expect(shellQuote("docs' guide")).toBe("'docs'\\'' guide'");
	});

	it("excludes executable skill manifests from rendered documentation", () => {
		expect(docsContentFindExclusions()).toBe("! -name 'SKILL.md'");
	});

	it("converts governed GitHub bearer tokens to Git smart-HTTP basic auth", () => {
		expect(gitProviderAuthorization("github", "Bearer tenant-token")).toBe(
			`Basic ${btoa("x-access-token:tenant-token")}`,
		);
		expect(gitProviderAuthorization("github", "Basic encoded")).toBe(
			"Basic encoded",
		);
		expect(gitProviderAuthorization("gitlab", "Bearer tenant-token")).toBe(
			`Basic ${btoa("oauth2:tenant-token")}`,
		);
		expect(gitProviderAuthorization("generic", "Bearer tenant-token")).toBe(
			"Bearer tenant-token",
		);
	});
});

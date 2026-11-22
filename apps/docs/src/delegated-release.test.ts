import { afterEach, expect, it, vi } from "vite-plus/test";
import { scheduleDocsRelease } from "./delegated-release";
import { getBuild, getSiteById, listReleases } from "./registry";
import type { AppBindings, DocsSite } from "./types";

vi.mock("./registry", () => ({
	getBuild: vi.fn(),
	getSiteById: vi.fn(),
	listReleases: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

it("schedules only the configured site's advertised main revision", async () => {
	const policy = {
		siteId: "10000000-0000-4000-8000-000000000001",
		orgSlug: "example",
		canonicalUrl: "https://docs.example.com",
		repository: "example/project",
	};
	const site: DocsSite = {
		id: policy.siteId,
		orgSlug: policy.orgSlug,
		canonicalUrl: policy.canonicalUrl,
		slug: "docs",
		title: "Example Docs",
		description: "Example public docs",
		locale: "en",
		sourceProvider: "github",
		sourceAuthMode: "public",
		repositoryUrl: "https://github.com/example/project.git",
		artifactsRepository: null,
		branch: "main",
		contentRoot: "docs/public",
		accessMode: "public",
		status: "active",
		activeBuildId: "build-previous",
		latestBuildId: "build-previous",
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	};
	const createBatch = vi.fn();
	const env = {
		ENVIRONMENT: "production",
		DOCS_DELEGATED_RELEASE: JSON.stringify(policy),
		DOCS_BUILD_WORKFLOW: { createBatch },
	} as unknown as AppBindings;
	const previous = "a".repeat(40);
	const candidate = "b".repeat(40);
	const fetchSource = vi.fn();
	vi.stubGlobal("fetch", fetchSource);
	vi.mocked(getSiteById).mockResolvedValue({ ...site, id: "other-site" });
	await scheduleDocsRelease(env);
	expect(fetchSource).not.toHaveBeenCalled();

	vi.mocked(getSiteById).mockResolvedValue(site);
	vi.mocked(getBuild).mockResolvedValue({
		id: "build-previous",
		siteId: site.id,
		sourceBranch: "main",
		sourceRevision: previous,
		status: "complete",
		phase: "ready",
		manifestKey: "manifest.json",
		proposalId: null,
		error: null,
		requestedBy: null,
		createdAt: "2026-01-01",
		startedAt: null,
		finishedAt: null,
	});
	vi.mocked(listReleases).mockResolvedValue([
		{
			id: "release-previous",
			siteId: site.id,
			buildId: "build-previous",
			previousBuildId: null,
			action: "publish",
			actor: { type: "user", id: "publisher", sessionId: null },
			createdAt: "2026-01-01",
		},
	]);
	fetchSource.mockResolvedValueOnce(Response.redirect("https://example.com/"));
	await expect(scheduleDocsRelease(env)).rejects.toThrow(
		"Docs source check failed with HTTP 302",
	);
	expect(fetchSource).toHaveBeenCalledWith(
		expect.any(String),
		expect.objectContaining({ redirect: "manual" }),
	);
	expect(createBatch).not.toHaveBeenCalled();
	fetchSource.mockClear();

	fetchSource.mockResolvedValueOnce(
		new Response(
			`001e# service=git-upload-pack\n0000003d${previous} refs/heads/work\n003d${candidate} refs/heads/main\n0000`,
			{
				headers: {
					"Content-Type": "application/x-git-upload-pack-advertisement",
				},
			},
		),
	);
	await scheduleDocsRelease(env);
	expect(fetchSource.mock.calls.map(([url]) => url)).toEqual([
		"https://github.com/example/project.git/info/refs?service=git-upload-pack",
	]);
	expect(createBatch).toHaveBeenCalledExactlyOnceWith([
		{
			id: `release-release-previous-${candidate}`,
			params: {
				operation: "release",
				siteId: site.id,
				sourceRevision: candidate,
				previousRevision: previous,
				previousBuildId: "build-previous",
				previousReleaseId: "release-previous",
			},
		},
	]);
});

import type {
	DocsBuild as DocsBuildRow,
	DocsChange as DocsChangeRow,
	DocsSite as DocsSiteRow,
} from "@tedix/db/schema/docs-sites";
import { describe, expect, it } from "vite-plus/test";
import { mapBuild, mapChange, mapSite } from "./registry";

const siteRow: DocsSiteRow = {
	id: "site-1",
	orgSlug: "tedix",
	slug: "platform",
	title: "Platform",
	description: "Platform docs",
	locale: "en",
	canonicalUrl: "https://platform.docs.tedix.dev",
	sourceProvider: "artifacts",
	sourceAuthMode: "public",
	repositoryUrl: null,
	artifactsRepository: "platform-docs",
	branch: "main",
	contentRoot: "docs",
	accessMode: "organization",
	status: "active",
	activeBuildId: "build-1",
	latestBuildId: "build-2",
	createdAt: "2026-08-01T00:00:00.000Z",
	updatedAt: "2026-08-01T01:00:00.000Z",
};

describe("Docs registry contract mapping", () => {
	it("maps a DB-native site row without exposing SQL column names", () => {
		expect(mapSite(siteRow)).toEqual(siteRow);
	});

	it("reconstructs the requested actor from persisted build columns", () => {
		const row: DocsBuildRow = {
			id: "build-1",
			siteId: "site-1",
			status: "complete",
			phase: "ready",
			sourceBranch: "main",
			sourceRevision: "abc123",
			proposalId: null,
			manifestKey: "sites/site-1/builds/build-1/manifest.json",
			error: null,
			requestedByType: "external_agent",
			requestedById: "codex:session-1",
			requestedBySessionId: "session-1",
			createdAt: "2026-08-01T00:00:00.000Z",
			startedAt: "2026-08-01T00:01:00.000Z",
			finishedAt: "2026-08-01T00:02:00.000Z",
		};

		expect(mapBuild(row).requestedBy).toEqual({
			type: "external_agent",
			id: "codex:session-1",
			sessionId: "session-1",
		});
	});

	it("rejects an unknown persisted actor type at the application boundary", () => {
		const row: DocsChangeRow = {
			id: "change-1",
			siteId: "site-1",
			status: "proposed",
			path: "guide.md",
			message: "Add guide",
			baseRevision: "abc123",
			proposalBranch: "proposal/change-1",
			proposalRevision: "def456",
			contentSha256: "digest",
			previewBuildId: null,
			committedRevision: null,
			proposedByType: "future_actor",
			proposedById: "actor-1",
			proposedBySessionId: null,
			committedByType: null,
			committedById: null,
			committedBySessionId: null,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
			committedAt: null,
		};

		expect(() => mapChange(row)).toThrow(
			"Unsupported persisted Docs actor type: future_actor",
		);
	});
});

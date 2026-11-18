import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppBindings } from "../types";

vi.mock("../sandbox", () => ({ getSiteBuilderSandbox: vi.fn(() => ({})) }));
vi.mock("./storage", () => ({ getCmsTemplateSelection: vi.fn() }));
vi.mock("./template-sync", () => ({
	snapshotForTemplate: () => ({
		snapshot: {
			"src/theme-release.json": JSON.stringify({
				upstreamStarterRevision: "a".repeat(40),
				supportedBlocks: { hero: [1] },
			}),
		},
	}),
}));
vi.mock("./theme-artifacts", async (original) => ({
	...(await original<typeof import("./theme-artifacts")>()),
	startThemeArtifactRepoCommit: vi.fn(),
	readThemeArtifactRepoCommitStatus: vi.fn(),
}));
import { getCmsTemplateSelection } from "./storage";
import {
	startThemeArtifactRepoCommit,
	readThemeArtifactRepoCommitStatus,
} from "./theme-artifacts";
import { migrateThemeRelease } from "./theme-release-migration";

const head = "b".repeat(40);
const commit = "c".repeat(40);
const jobId = "tac-12345678-1234-1234-1234-123456789abc";
function fixture() {
	const state = { present: false, content: "", readFailure: false };
	const storage = new Map<string, string>();
	const repo = {
		[Symbol.dispose]: vi.fn(),
		log: vi.fn(async () => [{ hash: head }]),
		readCommit: vi.fn(async (hash: string) => ({
			hash,
			treeHash: "d".repeat(40),
		})),
		readTree: vi.fn(async (hash: string) => {
			if (state.readFailure) throw new Error("provider failure with secret");
			return hash === "d".repeat(40)
				? [{ name: "src", type: "tree", mode: "40000", hash: "e".repeat(40) }]
				: state.present
					? [
							{
								name: "theme-release.json",
								type: "blob",
								mode: "100644",
								hash: "f".repeat(40),
							},
						]
					: [];
		}),
		readBlob: vi.fn(async () => new Blob([state.content])),
		createToken: vi.fn(async () => ({ plaintext: "private-git-token" })),
	};
	const fetch = vi.fn(async (request: Request) => {
		const url = new URL(request.url);
		expect(request.headers.get("X-Tedix-CMS-Internal-Auth")).toBe("internal");
		const data = url.pathname.endsWith("/schema/collections")
			? { items: [{ slug: "pages" }] }
			: url.searchParams.has("cursor")
				? {
						items: [
							{
								data: {
									nested: [
										{ _type: "hero", _version: 2 },
										{ _type: "card", _version: 3 },
									],
								},
							},
						],
					}
				: {
						items: [{ data: { content: [{ _type: "hero", _version: 1 }] } }],
						nextCursor: "next",
					};
		return Response.json({ success: true, data });
	});
	const env = {
		DB: {},
		CF_ACCOUNT_ID: "fictional-account",
		CMS_INTERNAL_AUTH_TOKEN: "internal",
		ENVIRONMENT: "production",
		ARTIFACTS: { get: vi.fn(async () => repo) },
		CMS_DISPATCH: { fetch },
		SITE_BUILDER_STORAGE: {
			get: vi.fn(async (key: string) =>
				storage.has(key)
					? { json: async () => JSON.parse(storage.get(key)!) }
					: null,
			),
			put: vi.fn(async (key: string, value: string) => {
				storage.set(key, value);
			}),
		},
	} as unknown as AppBindings;
	return { state, storage, repo, fetch, env };
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getCmsTemplateSelection).mockResolvedValue({
		organizationId: "fictional-org",
		blogTemplateSlug: "tedix",
		metaTemplateSlug: null,
	});
	vi.mocked(startThemeArtifactRepoCommit).mockResolvedValue({
		jobId,
		processId: "process",
		startedAt: 1,
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
describe("one-time theme release migration", () => {
	it("unions template defaults and all published pages, commits once, then trusts the file at HEAD", async () => {
		const f = fixture();
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "running",
			jobId,
			expectedHead: head,
		});
		const input = vi.mocked(startThemeArtifactRepoCommit).mock.calls[0]![1];
		expect(input).toMatchObject({
			branch: "main",
			expectedHead: head,
			files: [{ path: "src/theme-release.json" }],
		});
		expect(JSON.parse(input.files[0]!.content)).toEqual({
			upstreamStarterRevision: "a".repeat(40),
			supportedBlocks: { hero: [1, 2], card: [3] },
		});
		vi.mocked(readThemeArtifactRepoCommitStatus).mockResolvedValue({
			status: "running",
		} as never);
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "running",
		});
		expect(startThemeArtifactRepoCommit).toHaveBeenCalledOnce();
		// The job's own status no longer matters once the file is at HEAD.
		vi.mocked(readThemeArtifactRepoCommitStatus).mockResolvedValue({
			status: "failed",
		} as never);
		f.state.present = true;
		f.state.content = input.files[0]!.content;
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "already-present",
			sourceCommit: head,
		});
		expect(startThemeArtifactRepoCommit).toHaveBeenCalledOnce();
		expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
			"private-git-token",
		);
	});
	it("leaves an existing valid declaration untouched without reading content or minting a token", async () => {
		const f = fixture();
		f.state.present = true;
		f.state.content = JSON.stringify({
			upstreamStarterRevision: "a".repeat(40),
			supportedBlocks: {},
		});
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "already-present",
			sourceCommit: head,
		});
		expect(f.fetch).not.toHaveBeenCalled();
		expect(f.repo.createToken).not.toHaveBeenCalled();
	});
	it.each([
		"unreadable-tree",
		"invalid-declaration",
		"content-denied",
		"unknown-site",
	])("fails closed for %s without launching a commit", async (fault) => {
		const f = fixture();
		if (fault === "unreadable-tree") f.state.readFailure = true;
		if (fault === "invalid-declaration") {
			f.state.present = true;
			f.state.content = "{}";
		}
		if (fault === "content-denied")
			f.fetch.mockResolvedValue(new Response("denied", { status: 403 }));
		if (fault === "unknown-site")
			vi.mocked(getCmsTemplateSelection).mockResolvedValue(null);
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "failed",
		});
		expect(startThemeArtifactRepoCommit).not.toHaveBeenCalled();
		expect(f.repo.createToken).not.toHaveBeenCalled();
	});
	it("waits on an unreadable fresh job, then relaunches once it is stale", async () => {
		const f = fixture();
		await migrateThemeRelease(f.env, "acme");
		vi.mocked(readThemeArtifactRepoCommitStatus).mockRejectedValue(
			new Error("unavailable"),
		);
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "running",
			code: "COMMIT_STATUS_FAILED",
			jobId,
		});
		expect(startThemeArtifactRepoCommit).toHaveBeenCalledOnce();
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 31 * 60_000);
		try {
			expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
				status: "running",
			});
		} finally {
			vi.useRealTimers();
		}
		expect(startThemeArtifactRepoCommit).toHaveBeenCalledTimes(2);
	});
	it.each(["conflict", "failed", "committed-but-missing"])(
		"relaunches instead of claiming committed when the job reports %s and HEAD lacks the file",
		async (fault) => {
			const f = fixture();
			await migrateThemeRelease(f.env, "acme");
			vi.mocked(readThemeArtifactRepoCommitStatus).mockResolvedValue({
				status: fault === "failed" ? "failed" : "complete",
				seed:
					fault === "conflict"
						? { conflict: true }
						: { committed: true, commit },
			} as never);
			// A finished job without a declaration at HEAD is retried at once;
			// expectedHead keeps the retry from overwriting newer theme work.
			expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
				status: "running",
			});
			expect(startThemeArtifactRepoCommit).toHaveBeenCalledTimes(2);
		},
	);
	it("recovers receipts written before launch times were recorded", async () => {
		const f = fixture();
		f.storage.set(
			"cms-theme-release-migration/v1/acme.json",
			JSON.stringify({
				orgSlug: "acme",
				status: "failed",
				code: "COMMIT_FAILED",
				jobId,
				updatedAt: "2026-11-18T14:01:00.000Z",
			}),
		);
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "running",
		});
		expect(startThemeArtifactRepoCommit).toHaveBeenCalledOnce();
	});
});

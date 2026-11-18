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
	it("unions template defaults and all published pages, commits once, then verifies the immutable file", async () => {
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
		vi.mocked(readThemeArtifactRepoCommitStatus).mockResolvedValue({
			status: "complete",
			seed: { committed: true, commit },
		} as never);
		f.state.present = true;
		f.state.content = input.files[0]!.content;
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "committed",
			sourceCommit: commit,
		});
		expect(f.repo.readCommit).toHaveBeenCalledWith(commit);
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
	it("keeps the job receipt after a failed status read so a later call never relaunches it", async () => {
		const f = fixture();
		await migrateThemeRelease(f.env, "acme");
		vi.mocked(readThemeArtifactRepoCommitStatus).mockRejectedValueOnce(
			new Error("unavailable"),
		);
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "failed",
			code: "COMMIT_STATUS_FAILED",
			jobId,
		});
		vi.mocked(readThemeArtifactRepoCommitStatus).mockResolvedValue({
			status: "running",
		} as never);
		expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
			status: "running",
			jobId,
		});
		expect(startThemeArtifactRepoCommit).toHaveBeenCalledOnce();
	});
	it.each(["conflict", "failed", "mismatched-file"])(
		"does not claim committed for %s",
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
			expect(await migrateThemeRelease(f.env, "acme")).toMatchObject({
				status: "failed",
			});
			expect(startThemeArtifactRepoCommit).toHaveBeenCalledOnce();
		},
	);
});

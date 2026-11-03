import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkRepositoryReviewInputSchema } from "@tedix/api-contract/schemas/work-items";
import { readWorkRepositoryReview } from "./work-repository-review";

const work = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const admission = "33333333-3333-4333-8333-333333333333";
const base = "a".repeat(40),
	head = "b".repeat(40);
const baseTree = "c".repeat(40),
	headTree = "d".repeat(40);
const repositoryName = `work-11111111-${attemptId}`;
const prefix = `tedix-work:${work};attempt:${attemptId};admission:${admission}`;
const repo = {
	info: vi.fn(),
	readCommit: vi.fn(),
	readTree: vi.fn(),
	readFile: vi.fn(),
	log: vi.fn(),
	[Symbol.dispose]: vi.fn(),
};
const artifacts = { get: vi.fn(async () => repo) };
function fixture(
	operation: "tree" | "history" | "compare" = "tree",
	path = "",
) {
	return {
		artifacts: artifacts as unknown as Pick<Artifacts, "get">,
		input: WorkRepositoryReviewInputSchema.parse({
			id: work,
			attemptId,
			expectedHeadRevision: head,
			operation,
			path,
		}),
		attempt: {
			id: attemptId,
			workItemId: work,
			admissionId: admission,
			finishedAt: "2026-11-03T17:00:00.000Z",
			outcome: "succeeded",
			metadata: {
				repository: {
					version: 1,
					provider: "cloudflare_artifacts",
					status: "ready",
					mode: "fork",
					repositoryName,
					repositoryId: "repo-1",
					remote: "https://example.test/repo.git",
					defaultBranch: "main",
					sourceRepositoryName: "source",
					sourceRef: "main",
					baseRevision: base,
					workItemId: work,
					workItemVersion: 1,
					admissionSpecRevision: "spec-1",
					admissionId: admission,
					attemptId,
					observedAt: "2026-11-03T16:00:00.000Z",
					reason: null,
				},
				repositoryLifecycle: {
					version: 1,
					headRevision: head,
					review: {
						status: "not_reviewed",
						evidenceRef: null,
						reviewedAt: null,
					},
					merge: {
						status: "not_merged",
						canonicalLedger: null,
						repository: null,
						commitSha: null,
						mergedAt: null,
					},
					deployment: {
						status: "not_deployed",
						surface: null,
						revision: null,
						evidenceRef: null,
						observedAt: null,
					},
				},
			},
		},
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	repo.info.mockResolvedValue({
		id: "repo-1",
		name: repositoryName,
		description: `${prefix};source:source;ref:main;base:${base}`,
	});
	repo.readCommit.mockImplementation(async (ref: string) => ({
		hash: ref,
		treeHash: ref === base ? baseTree : headTree,
	}));
	repo.readTree.mockResolvedValue([]);
	repo.readFile.mockResolvedValue(new Blob(["hello"]));
	repo.log.mockResolvedValue([]);
});

describe("immutable Work repository review", () => {
	it("retains removed entries and compares the exact base and settlement result", async () => {
		repo.readTree.mockImplementation(async (hash: string) =>
			hash === baseTree
				? [{ name: "gone.ts", type: "blob", hash: base }]
				: [{ name: "new.ts", type: "blob", hash: head }],
		);
		const tree = await readWorkRepositoryReview(fixture());
		expect(tree.entries.map(({ name, change }) => [name, change])).toEqual([
			["gone.ts", "removed"],
			["new.ts", "added"],
		]);
		await readWorkRepositoryReview(fixture("compare", "gone.ts"));
		expect(repo.readFile.mock.calls.map(([args]) => args)).toEqual([
			{ ref: base, path: "gone.ts" },
			{ ref: head, path: "gone.ts" },
		]);
		expect(repo[Symbol.dispose]).toHaveBeenCalledTimes(2);
	});
	it.each(["head", "provenance", "active", "missing_receipt"])(
		"refuses %s mismatch before opening a repository",
		async (condition) => {
			const f = fixture();
			if (condition === "head") f.input.expectedHeadRevision = base;
			if (condition === "provenance")
				f.attempt.metadata.repository.attemptId = work;
			if (condition === "active")
				f.attempt.finishedAt = null as unknown as string;
			if (condition === "missing_receipt")
				delete (f.attempt.metadata as Record<string, unknown>)
					.repositoryLifecycle;
			await expect(readWorkRepositoryReview(f)).rejects.toThrow(
				"immutable repository result",
			);
			expect(artifacts.get).not.toHaveBeenCalled();
		},
	);
	it("refuses replaced repositories and missing result commits", async () => {
		repo.info.mockResolvedValueOnce({
			id: "other",
			name: repositoryName,
			description: prefix,
		});
		await expect(readWorkRepositoryReview(fixture())).rejects.toThrow(
			"provenance",
		);
		repo.readCommit.mockResolvedValueOnce(null);
		await expect(readWorkRepositoryReview(fixture())).rejects.toThrow(
			"result commit",
		);
		expect(repo[Symbol.dispose]).toHaveBeenCalledTimes(2);
	});
	it("never renders binary or oversized content as text", async () => {
		repo.readFile
			.mockResolvedValueOnce(new Blob(["a\0b"]))
			.mockResolvedValueOnce(new Blob(["x".repeat(262_145)]));
		const result = await readWorkRepositoryReview(fixture("compare", "file"));
		expect(result.base).toMatchObject({ status: "binary", text: null });
		expect(result.head).toMatchObject({ status: "too_large", text: null });
	});
	it("pins and paginates history at the recorded SHA", async () => {
		repo.log.mockResolvedValue(
			Array.from({ length: 51 }, () => ({
				hash: head,
				message: "result",
				authoredAt: 1,
			})),
		);
		const result = await readWorkRepositoryReview(fixture("history"));
		expect(repo.log).toHaveBeenCalledWith({ ref: head, limit: 51, offset: 0 });
		expect(result.commits).toHaveLength(50);
		expect(result.nextOffset).toBe(50);
	});
	it.each(["../secret", "/absolute", "a/../b", "a\\b", "a//b", "a\0b"])(
		"rejects unsafe path %s",
		(path) => {
			expect(
				WorkRepositoryReviewInputSchema.safeParse({ ...fixture().input, path })
					.success,
			).toBe(false);
		},
	);
});

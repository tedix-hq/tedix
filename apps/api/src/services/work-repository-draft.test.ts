import { describe, expect, it, vi } from "vite-plus/test";
import { WorkAttemptRepositorySchema } from "@tedix/api-contract/schemas/work-items";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import {
	hydrateRepositoryCandidate,
	liveRepositoryCandidateScope,
	recordedRepositoryCandidate,
	repositoryCandidateDescriptor,
} from "./work-repository-draft";

const work = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org",
	disposition: "accepted",
	completedAt: null,
	cancelledAt: null,
} as WorkItem;
const attempt = {
	id: "22222222-2222-4222-8222-222222222222",
	workItemId: work.id,
	orgId: work.orgId,
	admissionId: "33333333-3333-4333-8333-333333333333",
	runtimeState: "running",
	expiresAt: "2099-01-01T00:00:00.000Z",
	metadata: {},
} as WorkAttempt;
const repository = WorkAttemptRepositorySchema.parse({
	version: 1,
	provider: "cloudflare_artifacts",
	status: "ready",
	mode: "create",
	repositoryId: "fixture-repo",
	repositoryName: "fixture",
	remote: "https://artifacts.example/fixture.git",
	defaultBranch: "main",
	sourceRepositoryName: null,
	sourceRef: null,
	baseRevision: null,
	workItemId: work.id,
	workItemVersion: 1,
	admissionSpecRevision: "spec",
	admissionId: attempt.admissionId,
	attemptId: attempt.id,
	observedAt: "2026-11-01T00:00:00.000Z",
	reason: null,
});
attempt.metadata.repository = repository;
const baseRevision = "a".repeat(40);
const blobRevision = "b".repeat(40);
const head = { hash: baseRevision, treeHash: "c".repeat(40) };

function fixture() {
	const info = {
		id: repository.repositoryId,
		name: repository.repositoryName,
		description: `tedix-work:${work.id};attempt:${attempt.id};admission:${attempt.admissionId}`,
		defaultBranch: "main",
	};
	const entry = {
		name: "README.md",
		type: "blob",
		mode: "100644",
		hash: blobRevision,
	};
	const repo = {
		info: vi.fn(async () => info),
		log: vi.fn(async () => [head]),
		readTree: vi.fn(async () => [entry]),
		readBlob: vi.fn(async () => new Blob(["hello\n"])),
		[Symbol.dispose]: vi.fn(),
	};
	const artifacts = { get: vi.fn(async () => repo) };
	return {
		repo,
		artifacts,
		info,
		entry,
		params: {
			artifacts: artifacts as unknown as Pick<Artifacts, "get">,
			repository,
			baseRevision,
			paths: ["README.md"],
		},
	};
}

describe("trusted pinned repository candidate hydration", () => {
	it("refuses excessive traversal depth before contacting Artifacts", async () => {
		const f = fixture();
		await expect(
			hydrateRepositoryCandidate({
				...f.params,
				paths: [Array.from({ length: 33 }, () => "dir").join("/")],
			}),
		).rejects.toThrow("paths exceed");
		expect(f.artifacts.get).not.toHaveBeenCalled();
	});
	it("refuses broad or malformed trees before reading selected blobs", async () => {
		const f = fixture();
		f.repo.readTree.mockResolvedValueOnce(
			Array.from({ length: 1025 }, (_, index) => ({
				...f.entry,
				name: `file${index}`,
			})),
		);
		await expect(hydrateRepositoryCandidate(f.params)).rejects.toThrow(
			"tree is missing or exceeds",
		);
		f.repo.readTree.mockResolvedValueOnce([
			{ ...f.entry, hash: "not-a-git-sha" },
		]);
		await expect(hydrateRepositoryCandidate(f.params)).rejects.toThrow(
			"tree is missing or exceeds",
		);
		expect(f.repo.readBlob).not.toHaveBeenCalled();
	});
	it("caches shared ancestor trees within bounded multi-file hydration", async () => {
		const f = fixture();
		f.repo.readTree.mockResolvedValue([
			{ ...f.entry, name: "README.md" },
			{ ...f.entry, name: "notes.txt" },
		]);
		await hydrateRepositoryCandidate({
			...f.params,
			paths: ["README.md", "notes.txt"],
		});
		expect(f.repo.readTree).toHaveBeenCalledOnce();
	});
	it("reads only exact pinned blobs and releases the capability", async () => {
		const f = fixture();
		expect(await hydrateRepositoryCandidate(f.params)).toEqual({
			files: { "README.md": "hello\n" },
			selected: [{ path: "README.md", blobRevision, bytes: 6 }],
		});
		expect(f.repo.readBlob).toHaveBeenCalledWith(blobRevision);
		expect(f.repo[Symbol.dispose]).toHaveBeenCalledOnce();
		expect(Object.keys(f.repo)).not.toContain("createToken");
	});
	it.each(["id", "description"] as const)(
		"rejects live %s provenance changes before blob reads",
		async (key) => {
			const f = fixture();
			f.info[key] = "foreign";
			await expect(hydrateRepositoryCandidate(f.params)).rejects.toThrow(
				"provenance",
			);
			expect(f.repo.readBlob).not.toHaveBeenCalled();
		},
	);
	it("refuses stale base and missing selected files", async () => {
		const f = fixture();
		await expect(
			hydrateRepositoryCandidate({ ...f.params, baseRevision: "d".repeat(40) }),
		).rejects.toThrow("stale");
		await expect(
			hydrateRepositoryCandidate({ ...f.params, paths: ["missing"] }),
		).rejects.toThrow("does not exist");
	});
	it.each(["symlink", "gitlink", "tree"])(
		"rejects %s entries",
		async (type) => {
			const f = fixture();
			f.entry.type = type;
			await expect(hydrateRepositoryCandidate(f.params)).rejects.toThrow(
				"regular text",
			);
		},
	);
	it.each([
		new Blob([new Uint8Array([255])]),
		new Blob(["\0"]),
		new Blob(["x".repeat(65537)]),
	])("refuses malformed, binary or oversized contents", async (blob) => {
		const f = fixture();
		f.repo.readBlob.mockResolvedValue(blob);
		await expect(hydrateRepositoryCandidate(f.params)).rejects.toThrow();
	});
});

describe("candidate discovery is not authority", () => {
	it("derives identity from the exact Work, Attempt, admission and pinned blob map", async () => {
		const descriptor = await repositoryCandidateDescriptor({
			work,
			attempt,
			baseRevision,
			selected: [{ path: "README.md", blobRevision, bytes: 6 }],
		});
		expect(
			recordedRepositoryCandidate(work, {
				...attempt,
				metadata: { ...attempt.metadata, repositoryCandidate: descriptor },
			}),
		).toEqual(descriptor);
		expect(() =>
			recordedRepositoryCandidate(work, {
				...attempt,
				metadata: {
					...attempt.metadata,
					repositoryCandidate: {
						...descriptor,
						admissionId: crypto.randomUUID(),
					},
				},
			}),
		).toThrow("provenance");
	});
	it("refuses inactive Work, elapsed Attempt, and a foreign organization", () => {
		for (const changed of [
			{ ...work, completedAt: "2026-11-01" },
			{ ...work, disposition: "cancelled" },
			{ ...work, orgId: "foreign" },
		])
			expect(() =>
				liveRepositoryCandidateScope(changed as WorkItem, attempt),
			).toThrow("active admitted");
		expect(() =>
			liveRepositoryCandidateScope(work, {
				...attempt,
				expiresAt: "2000-01-01T00:00:00.000Z",
			}),
		).toThrow("active admitted");
		expect(() => recordedRepositoryCandidate(work, attempt)).toThrow(
			"has not initialized",
		);
	});
});

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	author: vi.fn(),
	attempt: vi.fn(),
	artifactsGet: vi.fn(),
}));

vi.mock("./policy-helpers", async (original) => ({
	...(await original<Record<string, unknown>>()),
	assertWorkItemAccess: mocks.access,
	requireOwnerAdminWorkItemAuthor: mocks.author,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getRecordedWorkItemAttempt: mocks.attempt,
}));

import { readAttemptRepository } from "./repository-read";

const workItemId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const admissionId = "33333333-3333-4333-8333-333333333333";

const provenance = {
	version: 1,
	provider: "cloudflare_artifacts",
	status: "ready",
	mode: "create",
	repositoryName: `work-${workItemId.slice(0, 8)}-${attemptId}`,
	repositoryId: "repo-1",
	remote: "https://artifacts.example/namespace/work.git",
	defaultBranch: "main",
	sourceRepositoryName: null,
	sourceRef: null,
	baseRevision: "b".repeat(40),
	workItemId,
	workItemVersion: 3,
	admissionSpecRevision: "rev-1",
	admissionId,
	attemptId,
	observedAt: "2026-11-01T00:00:00.000Z",
	reason: null,
};

const info = {
	id: "repo-1",
	name: provenance.repositoryName,
	description: `tedix-work:${workItemId};attempt:${attemptId};admission:${admissionId}`,
	defaultBranch: "main",
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-01T00:00:00.000Z",
	lastPushAt: "2026-11-01T00:00:00.000Z",
	source: null,
	readOnly: false,
	remote: provenance.remote,
};

const headCommit = {
	hash: "c".repeat(40),
	treeHash: "d".repeat(40),
	message: "Add feature\n\nBody.",
	author: { name: "Tedi", email: "tedi@example.com" },
	committer: { name: "Tedi", email: "tedi@example.com" },
	parents: ["b".repeat(40)],
	authoredAt: 1_762_000_000,
	committedAt: 1_762_000_100,
};

const trees: Record<string, Array<Record<string, string>>> = {
	[headCommit.treeHash]: [
		{ name: "src", mode: "40000", hash: "e".repeat(40), type: "tree" },
		{
			name: "README.md",
			mode: "100644",
			hash: "f".repeat(40),
			type: "blob",
		},
	],
	["e".repeat(40)]: [
		{ name: "index.ts", mode: "100644", hash: "1".repeat(40), type: "blob" },
	],
};

const files: Record<string, Blob> = {
	[`${headCommit.hash}:README.md`]: new Blob(["hello\n"], {
		type: "text/markdown",
	}),
};

function repoHandle() {
	return {
		info: async () => info,
		log: async ({
			ref,
			limit = 50,
			offset = 0,
		}: {
			ref?: string;
			limit?: number;
			offset?: number;
		} = {}) =>
			ref === "missing" ? [] : [headCommit].slice(offset, offset + limit),
		readTree: async (hash: string) => trees[hash] ?? null,
		readFile: async ({ ref, path }: { ref: string; path: string }) =>
			files[`${ref}:${path}`] ?? null,
		[Symbol.dispose]: () => {},
	};
}

function args(input: Record<string, unknown> = {}) {
	return {
		input: {
			id: workItemId,
			attemptId,
			operation: "log" as const,
			limit: 20,
			offset: 0,
			...input,
		},
		context: {
			db: "db",
			user: { id: "owner-1" },
			userRole: "owner",
			env: { ARTIFACTS: { get: mocks.artifactsGet } },
		},
	} as never;
}

describe("OS attempt repository review", () => {
	beforeEach(() => {
		mocks.access
			.mockReset()
			.mockResolvedValue({ id: workItemId, orgId: "org-1" });
		mocks.author.mockReset().mockResolvedValue("owner-1");
		mocks.attempt.mockReset().mockResolvedValue({
			id: attemptId,
			admissionId,
			metadata: { repository: provenance },
		});
		mocks.artifactsGet.mockReset().mockResolvedValue(repoHandle());
	});

	it.each(["external_agent", "tedi"])(
		"reads an expired settled %s Attempt without granting executor authority",
		async (executorType) => {
			mocks.attempt.mockResolvedValue({
				id: attemptId,
				admissionId,
				executorType,
				finishedAt: "2026-11-01T01:00:00.000Z",
				expiresAt: "2026-11-01T00:30:00.000Z",
				metadata: { repository: provenance },
			});
			await expect(readAttemptRepository(args())).resolves.toMatchObject({
				operation: "log",
			});
			expect(mocks.attempt).toHaveBeenCalledWith("db", {
				orgId: "org-1",
				workItemId,
				attemptId,
			});
		},
	);
	it("rejects an Attempt outside the scoped Work", async () => {
		mocks.attempt.mockResolvedValue(null);
		await expect(readAttemptRepository(args())).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.artifactsGet).not.toHaveBeenCalled();
	});
	it("rejects mismatched admission provenance", async () => {
		mocks.attempt.mockResolvedValue({
			id: attemptId,
			admissionId: "other",
			metadata: { repository: provenance },
		});
		await expect(readAttemptRepository(args())).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.artifactsGet).not.toHaveBeenCalled();
	});

	it("returns first-parent history with the persisted provenance", async () => {
		const result = await readAttemptRepository(args());
		expect(result).toMatchObject({
			operation: "log",
			resolvedRevision: headCommit.hash,
			repository: { repositoryName: provenance.repositoryName },
		});
		expect(result.operation === "log" ? result.commits[0] : null).toMatchObject(
			{
				hash: headCommit.hash,
				author: { name: "Tedi" },
				committedAt: new Date(headCommit.committedAt * 1000).toISOString(),
			},
		);
	});

	it("walks directory trees at the resolved head revision", async () => {
		const result = await readAttemptRepository(
			args({ operation: "tree", path: "src" }),
		);
		expect(result).toMatchObject({
			operation: "tree",
			exists: true,
			path: "src",
			entries: [{ name: "index.ts", path: "src/index.ts" }],
		});
	});

	it("reports a missing directory instead of an error", async () => {
		const result = await readAttemptRepository(
			args({ operation: "tree", path: "nope" }),
		);
		expect(result).toMatchObject({ operation: "tree", exists: false });
	});

	it("reads a file's bytes at a pinned revision", async () => {
		const result = await readAttemptRepository(
			args({ operation: "file", path: "README.md" }),
		);
		expect(result).toMatchObject({
			operation: "file",
			exists: true,
			size: 6,
			binary: false,
			truncated: false,
		});
		expect(
			result.operation === "file" ? atob(result.dataBase64 ?? "") : null,
		).toBe("hello\n");
	});

	it("denies an ordinary same-org reader before the binding is touched", async () => {
		mocks.author.mockRejectedValue(new Error("owner/admin required"));
		await expect(readAttemptRepository(args())).rejects.toThrow(
			"owner/admin required",
		);
		expect(mocks.attempt).not.toHaveBeenCalled();
		expect(mocks.artifactsGet).not.toHaveBeenCalled();
	});

	it("denies an owner without explicit secrets authority", async () => {
		const request = args() as Parameters<typeof readAttemptRepository>[0];
		request.context.userRole = "member";
		await expect(readAttemptRepository(request)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.artifactsGet).not.toHaveBeenCalled();
	});

	it.each([
		["no repository record", { metadata: {} }],
		[
			"an unavailable repository",
			{ metadata: { repository: { ...provenance, status: "unavailable" } } },
		],
		[
			"another attempt's repository",
			{
				metadata: {
					repository: {
						...provenance,
						attemptId: "99999999-9999-4999-8999-999999999999",
					},
				},
			},
		],
	])("rejects %s without reaching the binding", async (_label, attemptRow) => {
		mocks.attempt.mockResolvedValue({ id: attemptId, ...attemptRow });
		await expect(readAttemptRepository(args())).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.artifactsGet).not.toHaveBeenCalled();
	});

	it("refuses a live repository whose provenance no longer matches", async () => {
		mocks.artifactsGet.mockResolvedValue({
			...repoHandle(),
			info: async () => ({ ...info, description: "unrelated" }),
		});
		await expect(readAttemptRepository(args())).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it.each([
		{ ...info, id: "replacement-repo" },
		{ ...info, description: `${info.description}-other` },
	])(
		"rejects a recreated repository or extended admission marker",
		async (replacement) => {
			mocks.artifactsGet.mockResolvedValue({
				...repoHandle(),
				info: async () => replacement,
			});
			await expect(readAttemptRepository(args())).rejects.toMatchObject({
				code: "CONFLICT",
			});
		},
	);
	it("reads the resolved commit even when the branch moves between reads", async () => {
		const handle = repoHandle();
		const readFile = vi.fn(handle.readFile);
		mocks.artifactsGet.mockResolvedValue({ ...handle, readFile });
		await readAttemptRepository(
			args({ operation: "file", path: "README.md", ref: "main" }),
		);
		expect(readFile).toHaveBeenCalledWith({
			ref: headCommit.hash,
			path: "README.md",
		});
	});

	it("maps a missing repository to a conflict", async () => {
		mocks.artifactsGet.mockRejectedValue(
			Object.assign(new Error("missing"), { code: "NOT_FOUND" }),
		);
		await expect(readAttemptRepository(args())).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});
});

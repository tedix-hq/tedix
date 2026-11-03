import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { repositoryCandidateContentDigest } from "@tedix/api-contract/utils/repository-candidate";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	author: vi.fn(),
	external: vi.fn(),
	attempt: vi.fn(),
	record: vi.fn(),
	admission: vi.fn(),
	hydrate: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("./policy-helpers", async (original) => ({
	...(await original<Record<string, unknown>>()),
	assertWorkItemAccess: mocks.access,
	requireOwnerAdminWorkItemAuthor: mocks.author,
}));
vi.mock("../work-items-principal", () => ({
	verifiedExternalAgent: mocks.external,
	assertTediAccess: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getAuthoritativeWorkItemAttempt: mocks.attempt,
	getRecordedWorkItemAttempt: mocks.attempt,
	recordWorkAttemptRepositoryCandidate: mocks.record,
}));
vi.mock("../../../services/work-repository-candidate-access", () => ({
	assertRepositoryCandidateAdmission: mocks.admission,
}));
vi.mock("../../../services/work-repository-draft", async (original) => ({
	...(await original<Record<string, unknown>>()),
	hydrateRepositoryCandidate: mocks.hydrate,
}));
import {
	initializeRepositoryCandidate,
	readRepositoryCandidate,
	submitRepositoryCandidate,
	sealRepositoryCandidate,
} from "./repository-draft";
import { repositoryCandidateDescriptor } from "../../../services/work-repository-draft";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../../orpc";

const id = "11111111-1111-4111-8111-111111111111",
	attemptId = "22222222-2222-4222-8222-222222222222",
	admissionId = "33333333-3333-4333-8333-333333333333";
const base = "a".repeat(40),
	files = { "README.md": "hello" };
const repository = {
	version: 1,
	provider: "cloudflare_artifacts",
	status: "ready",
	mode: "create",
	repositoryId: "repo",
	repositoryName: "fixture",
	remote: "https://artifacts.example/fixture.git",
	defaultBranch: "main",
	sourceRepositoryName: null,
	sourceRef: null,
	baseRevision: null,
	workItemId: id,
	workItemVersion: 1,
	admissionSpecRevision: "spec",
	admissionId,
	attemptId,
	observedAt: "2026-11-01T00:00:00.000Z",
	reason: null,
};
const work = {
	id,
	orgId: "org",
	disposition: "accepted",
	completedAt: null,
	cancelledAt: null,
} as WorkItem;
let attempt: WorkAttempt;
const selected = [
	{ path: "README.md", blobRevision: "b".repeat(40), bytes: 5 },
];
function context() {
	return {
		db: {},
		organizationId: "org",
		authType: "user",
		userRole: "owner",
		user: { sub: "human" },
		env: {
			APP_DRAFT_ROOM: {
				idFromName: (name: string) => name,
				get: () => ({ fetch: mocks.fetch }),
			},
		},
	} as unknown as BaseContext;
}
function initArgs() {
	return {
		context: context(),
		input: { id, attemptId, paths: ["README.md"], expectedBaseRevision: base },
	} as Parameters<typeof initializeRepositoryCandidate>[0];
}
async function initializeStored() {
	attempt.metadata.repositoryCandidate = await repositoryCandidateDescriptor({
		work,
		attempt,
		baseRevision: base,
		selected,
	});
}

beforeEach(async () => {
	vi.clearAllMocks();
	attempt = {
		id: attemptId,
		orgId: "org",
		workItemId: id,
		admissionId,
		runtimeState: "running",
		expiresAt: "2099-01-01T00:00:00.000Z",
		metadata: { repository },
	} as WorkAttempt;
	mocks.access.mockResolvedValue(work);
	mocks.author.mockResolvedValue("human");
	mocks.attempt.mockImplementation(async () => attempt);
	mocks.admission.mockResolvedValue(undefined);
	mocks.external.mockResolvedValue({
		executor: {
			type: "external_agent",
			id: "principal",
			sessionId: "verified-session",
		},
		externalSessionKey: "session-fence",
	});
	mocks.hydrate.mockResolvedValue({ files, selected });
	mocks.record.mockImplementation(async (_db, params) => {
		attempt.metadata.repositoryCandidate = params.descriptor;
		return attempt;
	});
	mocks.fetch.mockImplementation(async (request: Request) => {
		const body = (await request.clone().json()) as {
			operation: string;
			expectedPosition?: { generation: number; revision: number };
			expectedContentDigest?: string;
		};
		return Response.json({
			snapshot: {
				position: { generation: 0, revision: 0 },
				canonical: { revision: 0, revisionId: base },
				files,
			},
			contentDigest: await repositoryCandidateContentDigest(files),
			sealed: body.operation === "seal",
			seal:
				body.operation === "seal"
					? {
							position: body.expectedPosition,
							contentDigest: body.expectedContentDigest,
						}
					: null,
		});
	});
});

describe("Work repository candidate authority", () => {
	it("hydrates trusted files, records once and forwards server-derived native actor", async () => {
		const result = await initializeRepositoryCandidate(initArgs());
		expect(result.writtenToRepository).toBe(false);
		expect(mocks.attempt).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				executor: {
					type: "external_agent",
					id: "principal",
					sessionId: "verified-session",
				},
				sessionId: "verified-session",
				externalSessionKey: "session-fence",
			}),
		);
		const body = await (mocks.fetch.mock.calls[0]![0] as Request).json();
		expect(body).toMatchObject({
			operation: "initialize",
			files,
			actor: {
				key: "verified-session",
				kind: "external_agent",
				verified: true,
			},
		});
	});
	it("denies unbound browser initialize/submit/seal despite owner role", async () => {
		mocks.external.mockResolvedValue(null);
		await initializeStored();
		for (const call of [
			() => initializeRepositoryCandidate(initArgs()),
			() =>
				submitRepositoryCandidate({
					context: context(),
					input: {
						id,
						attemptId,
						submission: {
							generation: 0,
							revision: 0,
							clientId: "client",
							seq: 1,
							change: [],
						},
					},
				} as Parameters<typeof submitRepositoryCandidate>[0]),
			() =>
				sealRepositoryCandidate({
					context: context(),
					input: {
						id,
						attemptId,
						expectedPosition: { generation: 0, revision: 0 },
						expectedContentDigest: "c".repeat(64),
					},
				} as Parameters<typeof sealRepositoryCandidate>[0]),
		])
			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("retains fresh owner/admin and secrets authority for reads", async () => {
		await initializeStored();
		mocks.author.mockRejectedValueOnce(new Error("demoted"));
		await expect(
			readRepositoryCandidate({
				context: context(),
				input: { id, attemptId },
			} as Parameters<typeof readRepositoryCandidate>[0]),
		).rejects.toThrow("demoted");
		const ctx = context();
		ctx.userRole = "member";
		await expect(
			readRepositoryCandidate({
				context: ctx,
				input: { id, attemptId },
			} as Parameters<typeof readRepositoryCandidate>[0]),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("refuses absent discovery, expired lease and changed admission", async () => {
		await expect(
			readRepositoryCandidate({
				context: context(),
				input: { id, attemptId },
			} as Parameters<typeof readRepositoryCandidate>[0]),
		).rejects.toThrow("has not initialized");
		await initializeStored();
		attempt.expiresAt = "2000-01-01T00:00:00.000Z";
		await expect(
			readRepositoryCandidate({
				context: context(),
				input: { id, attemptId },
			} as Parameters<typeof readRepositoryCandidate>[0]),
		).rejects.toThrow("active admitted");
		mocks.admission.mockRejectedValueOnce(new Error("admission changed"));
		await expect(initializeRepositoryCandidate(initArgs())).rejects.toThrow(
			"admission changed",
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("retries initialization without replacing the frozen selection", async () => {
		await initializeStored();
		await initializeRepositoryCandidate(initArgs());
		expect(mocks.record).not.toHaveBeenCalled();
		await expect(
			initializeRepositoryCandidate({
				...initArgs(),
				input: { ...initArgs().input, paths: ["other.txt"] },
			}),
		).rejects.toThrow("different frozen");
	});
	it("checks stale head before sealing and exports exact position+digest", async () => {
		await initializeStored();
		const input = {
			id,
			attemptId,
			expectedPosition: { generation: 0, revision: 0 },
			expectedContentDigest: await repositoryCandidateContentDigest(files),
		};
		mocks.hydrate.mockRejectedValueOnce(new Error("head changed"));
		await expect(
			sealRepositoryCandidate({ context: context(), input } as Parameters<
				typeof sealRepositoryCandidate
			>[0]),
		).rejects.toThrow("head changed");
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(
			(
				await sealRepositoryCandidate({
					context: context(),
					input,
				} as Parameters<typeof sealRepositoryCandidate>[0])
			).state.seal,
		).toEqual({
			position: input.expectedPosition,
			contentDigest: input.expectedContentDigest,
		});
	});
	it("rejects a room snapshot with mismatched content digest", async () => {
		await initializeStored();
		mocks.fetch.mockResolvedValueOnce(
			Response.json({
				snapshot: {
					position: { generation: 0, revision: 0 },
					canonical: { revision: 0, revisionId: base },
					files,
				},
				contentDigest: "f".repeat(64),
				sealed: false,
				seal: null,
			}),
		);
		await expect(
			readRepositoryCandidate({
				context: context(),
				input: { id, attemptId },
			} as Parameters<typeof readRepositoryCandidate>[0]),
		).rejects.toThrow("digest");
	});
});

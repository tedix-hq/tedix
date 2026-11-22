import type { WorkItem } from "@tedix/db/schema/work-items";
import { expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { verifiedImplementationCloseout } from "./implementation-closeout";

const mocks = vi.hoisted(() => ({
	actor: vi.fn(),
	attempts: vi.fn(),
	pushes: vi.fn(),
	project: vi.fn(),
	attemptProblem: vi.fn(),
	id: vi.fn(),
}));
vi.mock("../work-items-principal", () => ({
	verifiedActiveWorkActor: mocks.actor,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: mocks.attempts,
}));
vi.mock("@tedix/db/queries/repository-observer", () => ({
	findWorkImplementationPushes: mocks.pushes,
}));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectByIdForOrganization: mocks.project,
}));
vi.mock("./policy-helpers", () => ({
	ownAttemptCompletionProblem: mocks.attemptProblem,
}));
vi.mock("./recovered-commit-custody", () => ({
	hasRecoveredCommitCustody: () => true,
}));
vi.mock("../../../services/repository-observer", () => ({
	observerId: mocks.id,
}));

it("corrects only the delivering agent's observed implementation and protects sensitive Work", async () => {
	const work = {
		id: "10000000-0000-4000-8000-000000000001",
		orgId: "org",
		disposition: "accepted",
		workKind: "design",
		riskLevel: "medium",
		title: "Enable delegated documentation releases",
		acceptanceContract: {
			doneLooksLike: "Publish a checked build from the registered source.",
		},
	} as WorkItem;
	const context = { db: {} } as BaseContext;
	const externalSessionKey = "codex:verified-session";
	const actor = {
		id: "agent",
		type: "external_agent",
		sessionId: "session",
		externalSessionKey,
	};
	const sha = "a".repeat(40);
	const projectId = "10000000-0000-4000-8000-000000000002";
	const repository = "example/project";
	const event = {
		projectId,
		repository,
		branch: "main",
		sha,
		surface: "all",
		kind: "push",
		workItemId: work.id,
		evidenceUrl: "https://github.com/example/project/actions/runs/1",
		summary: `Agent-Session: ${externalSessionKey}`,
	};
	mocks.actor.mockResolvedValue(actor);
	mocks.attempts.mockResolvedValue({
		data: [
			{
				id: "attempt",
				executorType: "external_agent",
				executorId: actor.id,
				executorSessionId: actor.sessionId,
				externalSessionKey,
				runtimeState: "finished",
				outcome: "succeeded",
				startedAt: "2026-01-01T00:00:00Z",
				finishedAt: "2026-01-01T00:02:00Z",
				metadata: { settlement: { mode: "commit", commitShas: [sha] } },
			},
		],
	});
	mocks.project.mockResolvedValue({
		status: "active",
		metadata: {
			repositoryObserver: {
				repository,
				branch: "main",
				ownerTediId: projectId,
				escalationUserId: "owner",
				instructions: "Observe this repository after each main push.",
			},
		},
	});
	mocks.id.mockResolvedValue("observed");
	mocks.pushes.mockResolvedValue([
		{ id: "forged", projectId, metadata: { event } },
	]);
	await expect(
		verifiedImplementationCloseout(context, work),
	).resolves.toBeNull();

	mocks.pushes.mockResolvedValue([
		{ id: "observed", projectId, metadata: { event } },
	]);
	mocks.actor.mockResolvedValueOnce({ ...actor, sessionId: "other" });
	await expect(
		verifiedImplementationCloseout(context, work),
	).resolves.toBeNull();
	await expect(
		verifiedImplementationCloseout(context, {
			...work,
			acceptanceContract: {
				version: 1,
				doneLooksLike: "Send a refund to the customer.",
			},
		}),
	).resolves.toBeNull();
	await expect(
		verifiedImplementationCloseout(context, {
			...work,
			title: "Publish a social post",
		}),
	).resolves.toBeNull();

	await expect(verifiedImplementationCloseout(context, work)).resolves.toEqual({
		actor,
		attemptId: "attempt",
		observationId: "observed",
		commit: sha,
	});
	expect(mocks.attemptProblem).toHaveBeenLastCalledWith(
		context,
		{ ...work, workKind: "coding" },
		expect.objectContaining({ id: "attempt" }),
	);
});

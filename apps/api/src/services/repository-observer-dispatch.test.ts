import { beforeEach, expect, it, vi } from "vite-plus/test";
import { RepositoryEventSchema } from "@tedix/api-contract/schemas/repository-observer";
import type { BaseContext } from "../rpc/orpc";
const deps = vi.hoisted(() => ({
	project: vi.fn(),
	lessons: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
	enqueue: vi.fn(),
}));
vi.mock("@orpc/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@orpc/server")>()),
	createRouterClient: () => ({ enqueueMessage: deps.enqueue }),
}));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectByIdForOrganization: deps.project,
}));
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listApprovedAgentLessons: deps.lessons,
}));
vi.mock("@tedix/db/queries/repository-observer", () => ({
	createRepositoryObservation: deps.create,
	getRepositoryObservation: deps.get,
}));
vi.mock("@tedix/db/queries/skill-schedules", () => ({
	getSkillSchedule: vi.fn().mockResolvedValue({ enabled: false }),
}));
vi.mock("./situational-recall", () => ({
	triggersOf: () => ({ keywords: ["ship_red"] }),
}));
import {
	observeRepositoryEvent,
	ownedObservation,
} from "./repository-observer";
const context = { db: {}, tediId: "owner-tedi" } as unknown as BaseContext;
const event = RepositoryEventSchema.parse({
	projectId: "11111111-1111-4111-8111-111111111111",
	repository: "example/product",
	branch: "main",
	sha: "a".repeat(40),
	kind: "ship_red",
	occurredAt: "2026-10-17T10:00:00Z",
	summary: "A failure",
	evidenceUrl: "https://github.com/example/ops/actions/runs/123",
});
beforeEach(() => {
	vi.clearAllMocks();
	deps.project.mockResolvedValue({
		id: event.projectId,
		objectiveId: "objective",
		status: "active",
		metadata: {
			repositoryObserver: {
				repository: "example/product",
				ownerTediId: "22222222-2222-4222-8222-222222222222",
				escalationUserId: "human",
				instructions: "Read exact current failure evidence before reporting.",
			},
		},
	});
	deps.lessons.mockResolvedValue([
		{
			id: "lesson",
			content: "Inspect the provider failure",
			updatedAt: "revision",
			metadata: {},
		},
	]);
	deps.get.mockResolvedValue(null);
	deps.create.mockImplementation(async (_db, input) => ({
		...input,
		metadata: input.metadata,
	}));
	deps.enqueue.mockResolvedValue({ status: "queued" });
});
it("anchors the deadline to the actual incident and reuses the same dispatch identity", async () => {
	await observeRepositoryEvent(context, "org-example", event);
	await observeRepositoryEvent(context, "org-example", event);
	expect(deps.create.mock.calls[0]?.[1]?.deadline).toBe(
		"2026-10-17T10:30:00.000Z",
	);
	expect(deps.create.mock.calls[0]?.[1]?.metadata.lessons[0]?.id).toBe(
		"lesson",
	);
	expect(deps.enqueue.mock.calls[0]?.[0]?.idempotencyKey).toBe(
		deps.enqueue.mock.calls[1]?.[0]?.idempotencyKey,
	);
});
it("rejects an event from another repository before reading lessons", async () => {
	await expect(
		observeRepositoryEvent(context, "org-example", {
			...event,
			repository: "attacker/fork",
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(deps.lessons).not.toHaveBeenCalled();
});
it("does not let an external caller report as the configured tedi", async () => {
	deps.get.mockResolvedValue({ id: "observation", projectId: event.projectId });
	await expect(
		ownedObservation(context, "org-example", "observation"),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("pausing the factory stops future event dispatch", async () => {
	const project = await deps.project();
	deps.project.mockResolvedValue({
		...project,
		metadata: { ...project.metadata, factory: { skillId: "factory-skill" } },
	});
	await expect(
		observeRepositoryEvent(context, "org-example", event),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(deps.enqueue).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from "vite-plus/test";
import { RepositoryEventSchema } from "@tedix/api-contract/schemas/repository-observer";
import type { BaseContext } from "../rpc/orpc";
const deps = vi.hoisted(() => ({
	project: vi.fn(),
	lessons: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
	enqueue: vi.fn(),
	createAlert: vi.fn(),
	refreshAlerts: vi.fn(),
	settleCi: vi.fn(),
}));
vi.mock("@orpc/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@orpc/server")>()),
	createRouterClient: () => ({ enqueueMessage: deps.enqueue }),
}));
vi.mock("@tedix/db/queries/work-items/interactions", () => ({
	createWorkInteraction: deps.createAlert,
	createRepositoryCiAlert: deps.createAlert,
	refreshRepositoryCiAlerts: deps.refreshAlerts,
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
	settleRecoveredRepositoryCiObservations: deps.settleCi,
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
	escalateObserver,
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
	deps.refreshAlerts.mockResolvedValue([]);
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

it("refreshes one open CI alert across failing commits and closes it on green", async () => {
	const config = (await deps.project()).metadata.repositoryObserver;
	const red = {
		...event,
		kind: "ci_red" as const,
		surface: "full-suite-hourly",
	};
	const row = (event: typeof red) => ({
		id: event.sha,
		title: `Red CI ${event.surface} ${event.sha.slice(0, 9)}`,
		metadata: { event },
	});
	await observeRepositoryEvent(context, "org-example", red);
	await escalateObserver(
		context,
		"org-example",
		row(red),
		config,
		"Tests failed",
	);
	expect(deps.createAlert).toHaveBeenCalledTimes(1);
	deps.refreshAlerts.mockResolvedValue([{ id: "alert" }]);
	const next = { ...red, sha: "b".repeat(40) };
	await observeRepositoryEvent(context, "org-example", next);
	await escalateObserver(
		context,
		"org-example",
		row(next),
		config,
		"Tests still fail",
	);
	expect(deps.createAlert).toHaveBeenCalledTimes(1);
	expect(deps.refreshAlerts).toHaveBeenLastCalledWith(
		context.db,
		expect.objectContaining({ sha: next.sha, green: false }),
	);
	deps.enqueue.mockClear();
	const result = await observeRepositoryEvent(context, "org-example", {
		...next,
		kind: "ci_green",
	});
	expect(result.status).toBe("recovered");
	expect(deps.settleCi).toHaveBeenCalledWith(
		context.db,
		expect.objectContaining({ surface: next.surface, orgId: "org-example" }),
	);
	expect(deps.settleCi.mock.invocationCallOrder[0]).toBeLessThan(
		deps.refreshAlerts.mock.invocationCallOrder.at(-1)!,
	);
	expect(deps.refreshAlerts).toHaveBeenLastCalledWith(
		context.db,
		expect.objectContaining({ sha: next.sha, green: true }),
	);
	expect(deps.enqueue).not.toHaveBeenCalled();
});

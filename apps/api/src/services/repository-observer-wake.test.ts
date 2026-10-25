import { beforeEach, expect, it, vi } from "vite-plus/test";

const deps = vi.hoisted(() => ({
	enqueue: vi.fn(),
	create: vi.fn(),
	claim: vi.fn(),
	defer: vi.fn(),
	release: vi.fn(),
	deferred: vi.fn(),
}));
vi.mock("@orpc/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@orpc/server")>()),
	createRouterClient: () => ({ enqueueMessage: deps.enqueue }),
}));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectByIdForOrganization: async () => ({
		id: "project-example",
		status: "active",
		objectiveId: null,
		metadata: {
			repositoryObserver: {
				repository: "example/repo",
				branch: "main",
				ownerTediId: "00000000-0000-4000-8000-000000000001",
				escalationUserId: "user-example",
				instructions:
					"Read the current repository and report verified evidence.",
			},
		},
	}),
}));
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listApprovedAgentLessons: async () => [],
}));
vi.mock("@tedix/db/queries/repository-observer", () => ({
	getRepositoryObservation: async () => null,
	createRepositoryObservation: deps.create,
	claimRepositoryObserverWake: deps.claim,
	deferRepositoryObserverWake: deps.defer,
	releaseRepositoryObserverWake: deps.release,
	deferredRepositoryPushObservations: deps.deferred,
}));
import {
	observeRepositoryEvent,
	wakeDeferredRepositoryObservations,
} from "./repository-observer";

const context = { db: {} } as Parameters<typeof observeRepositoryEvent>[0];
const push = {
	projectId: "00000000-0000-4000-8000-0000000000aa",
	repository: "example/repo",
	branch: "main",
	sha: "b".repeat(40),
	kind: "push" as const,
	surface: "all",
	paths: [],
	commands: "",
	summary: "agent push",
	evidenceUrl: "https://example.com/commit",
};

beforeEach(() => {
	vi.clearAllMocks();
	deps.create.mockImplementation(async (_db, input) => ({
		id: input.id,
		metadata: input.metadata,
	}));
	deps.enqueue.mockResolvedValue({ status: "queued" });
});

it("defers a push watch when the owner has no free wake slot", async () => {
	deps.claim.mockResolvedValue(false);
	const result = await observeRepositoryEvent(context, "org-example", push);
	expect(result.status).toBe("deferred");
	expect(deps.claim).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ limit: 2, projectId: "project-example" }),
	);
	expect(deps.defer).toHaveBeenCalledTimes(1);
	expect(deps.enqueue).not.toHaveBeenCalled();
});

it("wakes a push watch that took a slot, and never defers a red Ship", async () => {
	deps.claim.mockResolvedValue(true);
	expect(
		(await observeRepositoryEvent(context, "org-example", push)).status,
	).toBe("queued");
	expect(deps.enqueue).toHaveBeenCalledTimes(1);

	await observeRepositoryEvent(context, "org-example", {
		...push,
		kind: "ship_red",
		surface: "api",
	});
	expect(deps.claim).toHaveBeenLastCalledWith(
		{},
		expect.objectContaining({ limit: null }),
	);
	expect(deps.defer).not.toHaveBeenCalled();
});

it("wakes deferred pushes into free slots and releases a slot whose wake failed", async () => {
	const row = (id: string) => ({
		id,
		orgId: "org-example",
		projectId: "project-example",
		metadata: { event: push, lessons: [] },
	});
	deps.deferred.mockResolvedValue([row("newest"), row("older"), row("oldest")]);
	deps.claim
		.mockResolvedValueOnce(true)
		.mockResolvedValueOnce(false)
		.mockResolvedValue(true);
	expect(
		await wakeDeferredRepositoryObservations(context, Date.now() + 10_000),
	).toBe(1);
	// The project ran out of slots after the newest push; older rows wait.
	expect(deps.claim).toHaveBeenCalledTimes(2);
	expect(deps.enqueue).toHaveBeenCalledTimes(1);

	deps.claim.mockReset().mockResolvedValue(true);
	deps.enqueue.mockReset().mockRejectedValue(new Error("runtime down"));
	await expect(
		wakeDeferredRepositoryObservations(context, Date.now() + 10_000),
	).rejects.toThrow("runtime down");
	expect(deps.release).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ id: "newest" }),
	);
});

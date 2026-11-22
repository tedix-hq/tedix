import { beforeEach, expect, it, vi } from "vite-plus/test";

const deps = vi.hoisted(() => ({
	enqueue: vi.fn(),
	create: vi.fn(),
	claim: vi.fn(),
	release: vi.fn(),
	lessons: vi.fn(async () => []),
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
	listApprovedAgentLessons: deps.lessons,
}));
vi.mock("@tedix/db/queries/repository-observer", () => ({
	getRepositoryObservation: async () => null,
	createRepositoryObservation: deps.create,
	claimRepositoryObserverWake: deps.claim,
	releaseRepositoryObserverWake: deps.release,
}));
import { observeRepositoryEvent } from "./repository-observer";

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

it("records a push without a tedi turn, and wakes the owner for a red Ship", async () => {
	expect(
		(await observeRepositoryEvent(context, "org-example", push)).status,
	).toBe("recorded");
	expect(deps.create).toHaveBeenCalledTimes(1);
	expect(deps.lessons).not.toHaveBeenCalled();
	expect(deps.enqueue).not.toHaveBeenCalled();

	expect(
		(
			await observeRepositoryEvent(context, "org-example", {
				...push,
				kind: "ship_red",
				surface: "api",
			})
		).status,
	).toBe("queued");
	expect(deps.claim).toHaveBeenCalledTimes(1);
	expect(deps.enqueue).toHaveBeenCalledTimes(1);
});

it("forgets the wake of a red Ship whose turn never started, so a retry wakes again", async () => {
	deps.enqueue.mockRejectedValue(new Error("runtime down"));
	await expect(
		observeRepositoryEvent(context, "org-example", {
			...push,
			kind: "ship_red",
			surface: "api",
		}),
	).rejects.toThrow("runtime down");
	expect(deps.release).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ orgId: "org-example" }),
	);
});

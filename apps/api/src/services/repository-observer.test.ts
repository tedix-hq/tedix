import { describe, expect, it, vi } from "vite-plus/test";
import {
	observerId,
	repairPathsAllowed,
	observeRepositoryEvent,
} from "./repository-observer";
describe("repository observer safety", () => {
	it("keeps idempotency tenant-bound and stable across deliveries", async () => {
		expect(await observerId("org-a:repo:sha:surface")).toBe(
			await observerId("org-a:repo:sha:surface"),
		);
		expect(await observerId("org-a:repo:sha:surface")).not.toBe(
			await observerId("org-b:repo:sha:surface"),
		);
	});
	it("uses the shared matcher and excludes secrets, traversal and production configuration", () => {
		expect(repairPathsAllowed(["docs/public/a.md"], ["docs/**/*.md"])).toBe(
			true,
		);
		for (const path of [
			"../docs/a.md",
			"/docs/a.md",
			"docs/../secrets/token",
			".env",
			".env.local",
			".dev.vars",
			"secrets/token",
			"configuration/production-overlay.json",
			"apps/api/wrangler.jsonc",
			"apps/os/cloudflare.config.ts",
			"apps/api/src/a.ts",
		])
			expect(repairPathsAllowed([path], ["docs/**/*.md"])).toBe(false);
		for (const path of [
			".env",
			"secrets/token",
			"configuration/production-overlay.json",
			"apps/api/wrangler.jsonc",
			".github/workflows/deploy.yml",
			"packages/db/drizzle/change/migration.sql",
			"config/private.pem",
		])
			expect(repairPathsAllowed([path], ["**"])).toBe(false);
	});
});

const recoveryDeps = vi.hoisted(() => ({
	get: vi.fn(),
	settle: vi.fn(),
	enqueue: vi.fn(),
}));
vi.mock("@orpc/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@orpc/server")>()),
	createRouterClient: () => ({ enqueueMessage: recoveryDeps.enqueue }),
}));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectByIdForOrganization: async () => ({
		id: "project-example",
		status: "active",
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
vi.mock("@tedix/db/queries/repository-observer", () => ({
	getRepositoryObservation: recoveryDeps.get,
	settleRecoveredRepositoryObservation: recoveryDeps.settle,
}));
it("settles an existing recovered incident while preserving the recovery wake and status", async () => {
	recoveryDeps.get.mockResolvedValue({ id: "incident" });
	recoveryDeps.enqueue.mockResolvedValue({ status: "queued" });
	const result = await observeRepositoryEvent(
		{ db: {} } as Parameters<typeof observeRepositoryEvent>[0],
		"org-example",
		{
			projectId: "project-example",
			repository: "example/repo",
			branch: "main",
			sha: "a".repeat(40),
			kind: "ship_green",
			surface: "api",
			paths: [],
			commands: "",
			summary: "Recovered",
			evidenceUrl: "https://example.com/run",
		},
	);
	expect(result.status).toBe("recovery_queued");
	expect(recoveryDeps.enqueue).toHaveBeenCalledTimes(1);
	expect(recoveryDeps.settle).toHaveBeenCalledWith(
		{},
		"org-example",
		result.observationId,
		expect.any(String),
	);
});

it("keeps no-incident recovery free of settlement and wakes", async () => {
	recoveryDeps.get.mockResolvedValue(null);
	recoveryDeps.settle.mockClear();
	recoveryDeps.enqueue.mockClear();
	const result = await observeRepositoryEvent(
		{ db: {} } as Parameters<typeof observeRepositoryEvent>[0],
		"org-example",
		{
			projectId: "project-example",
			repository: "example/repo",
			branch: "main",
			sha: "a".repeat(40),
			kind: "ship_green",
			surface: "api",
			paths: [],
			commands: "",
			summary: "Recovered",
			evidenceUrl: "https://example.com/run",
		},
	);
	expect(result.status).toBe("no_incident");
	expect(recoveryDeps.settle).not.toHaveBeenCalled();
	expect(recoveryDeps.enqueue).not.toHaveBeenCalled();
});

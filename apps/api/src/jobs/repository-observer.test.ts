import { expect, it, vi } from "vite-plus/test";
const deps = vi.hoisted(() => ({
	config: vi.fn(),
	escalate: vi.fn(),
	settle: vi.fn().mockResolvedValue([]),
}));
vi.mock("../rpc/orpc", () => ({ createContext: () => ({ db: {} }) }));
vi.mock("@tedix/db/queries/repository-observer", () => ({
	settleAgedRepositoryPushObservations: deps.settle,
	overdueRepositoryObservations: async () => [
		{ id: "first", orgId: "org-a", projectId: "project-a", metadata: {} },
		{
			id: "second",
			orgId: "org-b",
			projectId: "project-b",
			metadata: { latestReport: { diagnosis: "Known provider outage" } },
		},
	],
}));
vi.mock("../services/repository-observer", () => ({
	observerConfig: deps.config,
	escalateObserver: deps.escalate,
}));
import { maintainRepositoryObservers } from "./repository-observer";
it("continues other tenants after a broken observer and records a failed maintenance result", async () => {
	deps.config
		.mockRejectedValueOnce(new Error("Owner unavailable"))
		.mockResolvedValueOnce({ config: {} });
	deps.escalate.mockResolvedValue(undefined);
	await expect(
		maintainRepositoryObservers({} as CloudflareEnv),
	).rejects.toThrow("1 repository observer escalations failed");
	expect(deps.escalate.mock.calls[0]?.[1]).toBe("org-b");
	expect(deps.escalate.mock.calls[0]?.[4]).toContain("Known provider outage");
});

it("sweeps aged pushes on each tick without changing overdue escalation", async () => {
	deps.config.mockResolvedValue({ config: {} });
	deps.settle.mockResolvedValueOnce([{ id: "old-push" }]);
	expect(await maintainRepositoryObservers({} as CloudflareEnv)).toEqual({
		overdue: 2,
		settled: 1,
	});
	expect(deps.settle).toHaveBeenCalledWith({}, expect.any(String));
});

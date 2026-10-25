import { afterEach, expect, it, vi } from "vite-plus/test";
const deps = vi.hoisted(() => ({
	finish: vi.fn().mockResolvedValue(undefined),
	config: vi.fn(),
	escalate: vi.fn(),
	settle: vi.fn().mockResolvedValue([]),
	wake: vi.fn().mockResolvedValue(0),
}));
vi.mock("../rpc/orpc", () => ({ createContext: () => ({ db: {} }) }));
vi.mock("@tedix/db/queries/repository-observer", () => ({
	settleAgedRepositoryPushObservations: deps.settle,
	finishRepositoryObserverEscalation: deps.finish,
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
	wakeDeferredRepositoryObservations: deps.wake,
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
		woken: 0,
	});
	expect(deps.settle).toHaveBeenCalledWith({}, expect.any(String));
});

it("wakes deferred pushes after red incidents and survives a wake failure", async () => {
	deps.config.mockResolvedValue({ config: {} });
	deps.escalate.mockResolvedValue(undefined);
	deps.wake.mockResolvedValueOnce(2);
	expect(await maintainRepositoryObservers({} as CloudflareEnv)).toMatchObject({
		woken: 2,
	});
	expect(deps.escalate.mock.invocationCallOrder.at(-1)).toBeLessThan(
		deps.wake.mock.invocationCallOrder[0]!,
	);
	deps.wake.mockRejectedValueOnce(new Error("runtime down"));
	expect(await maintainRepositoryObservers({} as CloudflareEnv)).toMatchObject({
		woken: 0,
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});
it("bounds a hung escalation, records a timeout and sweeps pushes first", async () => {
	vi.useFakeTimers();
	deps.config.mockResolvedValue({ config: {} });
	deps.escalate
		.mockImplementationOnce(() => new Promise(() => {}))
		.mockResolvedValue(undefined);
	const run = expect(
		maintainRepositoryObservers({} as CloudflareEnv),
	).rejects.toThrow("1 repository observer escalations failed");
	await vi.advanceTimersByTimeAsync(5_001);
	await run;
	expect(deps.finish).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ id: "first" }),
		expect.any(String),
		"observer_timeout",
	);
	expect(deps.finish).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ id: "second" }),
		expect.any(String),
		"delivered",
	);
	expect(deps.settle.mock.invocationCallOrder[0]).toBeLessThan(
		deps.escalate.mock.invocationCallOrder[0]!,
	);
});

it("stops taking work at the run deadline while reserving time to record failure", async () => {
	vi.useFakeTimers();
	deps.config.mockImplementationOnce(async () => {
		vi.setSystemTime(Date.now() + 19_000);
		return { config: {} };
	});
	deps.escalate.mockImplementationOnce(() => new Promise(() => {}));
	const run = expect(
		maintainRepositoryObservers({} as CloudflareEnv),
	).rejects.toThrow("1 repository observer escalations failed");
	await vi.advanceTimersByTimeAsync(1_001);
	await run;
	expect(deps.config).toHaveBeenCalledTimes(1);
	expect(deps.finish).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ id: "first" }),
		expect.any(String),
		"observer_timeout",
	);
});

import { afterEach, expect, it, vi } from "vite-plus/test";
import {
	dispatchGraphProjectionDrains,
	redriveGraphGdsMaintenance,
	runAlwaysOnKeepalive,
	sweepOrphanRunsTick,
} from "./platform-tick";

const fixtures = vi.hoisted(() => ({
	getAlwaysOnTedis: vi.fn(),
	sweepOrphanRuns: vi.fn(),
	listGraphProjectionOrganizations: vi.fn(),
	listGraphProjectionCertificationOrganizations: vi.fn(),
	getGraphProjectionCursor: vi.fn(),
	measureGraphProjectionBacklog: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/tedis", () => ({
	getAlwaysOnTedis: fixtures.getAlwaysOnTedis,
}));
vi.mock("../rpc/routers/cognitive-runtime/recovery-artifacts", () => ({
	sweepOrphanRuns: fixtures.sweepOrphanRuns,
}));
vi.mock("@tedix/db/queries/graph-projection", () => ({
	listGraphProjectionOrganizations: fixtures.listGraphProjectionOrganizations,
	listGraphProjectionCertificationOrganizations:
		fixtures.listGraphProjectionCertificationOrganizations,
	getGraphProjectionCursor: fixtures.getGraphProjectionCursor,
	measureGraphProjectionBacklog: fixtures.measureGraphProjectionBacklog,
}));
vi.mock("../rpc/routers/kernel/run-store", () => ({
	propagateSweptChildFailureToHomeRun: vi.fn(),
}));

afterEach(() => {
	vi.restoreAllMocks();
	fixtures.getAlwaysOnTedis.mockReset();
	fixtures.sweepOrphanRuns.mockReset();
});

it("logs wake status and exception topology without the response or thrown text", async () => {
	fixtures.getAlwaysOnTedis.mockResolvedValue([{ slug: "cto" }]);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	const waitUntil: Promise<unknown>[] = [];
	let wakeCount = 0;
	const env = {
		DB: {},
		TEDI_SERVICE: {
			fetch: vi.fn(async () => {
				wakeCount += 1;
				if (wakeCount === 1) return new Response(null, { status: 503 });
				if (wakeCount === 2) {
					return new Response("token=secret-in-response", { status: 502 });
				}
				throw new TypeError("token=secret-in-exception");
			}),
		},
	} as unknown as CloudflareEnv;
	const context = {
		waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
	} as unknown as ExecutionContext;

	await runAlwaysOnKeepalive(env, context);
	await Promise.all(waitUntil);
	expect(warn).toHaveBeenCalledWith(
		"[Scheduled] alwaysOn-keepalive: wake cto → 502",
	);
	expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-in-response");

	await runAlwaysOnKeepalive(env, context);
	await Promise.all(waitUntil);
	expect(warn).toHaveBeenCalledWith(
		"[Scheduled] alwaysOn-keepalive: wake cto failed",
		{ type: "TypeError" },
	);
	expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-in-exception");
});

it("retains orphan sweep counts without logging returned error strings", async () => {
	fixtures.sweepOrphanRuns.mockResolvedValue({
		swept: 0,
		skipped: 1,
		errors: ["SQL token=secret-from-sweep"],
		propagatedRunIds: [],
		sweptRunIds: [],
	});
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

	const result = await sweepOrphanRunsTick({ DB: {} } as CloudflareEnv);

	expect(result).toEqual({ swept: 0, skipped: 1, errors: 1 });
	expect(JSON.stringify(log.mock.calls)).toContain("errors=1");
	expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toContain(
		"secret-from-sweep",
	);
});

const graphEnv = (workflow: { createBatch: ReturnType<typeof vi.fn> }) =>
	({
		DB: {},
		GRAPH_DB_URI: "neo4j+s://graph.example.test",
		GRAPH_DB_USER: "neo4j",
		GRAPH_DB_PASSWORD: "example-password",
		GRAPH_PROJECTION_DRAIN_WORKFLOW: workflow,
	}) as unknown as CloudflareEnv;

it("reads nothing and starts nothing without graph database config", async () => {
	const env = new Proxy(
		{},
		{
			get(_target, property) {
				if (String(property).startsWith("GRAPH_DB_")) return undefined;
				if (property === "then") return undefined;
				throw new Error(`unexpected env.${String(property)}`);
			},
		},
	) as CloudflareEnv;
	const controller = { scheduledTime: Date.UTC(2026, 9, 21, 22, 4) };
	await expect(
		dispatchGraphProjectionDrains(env, controller as ScheduledController),
	).resolves.toEqual({ configured: 0 });
	await expect(
		redriveGraphGdsMaintenance(env, controller as ScheduledController),
	).resolves.toEqual({ configured: 0 });
	expect(fixtures.listGraphProjectionOrganizations).not.toHaveBeenCalled();
});

it("dispatches capped drains with a failure cooldown when config is present", async () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	fixtures.listGraphProjectionOrganizations.mockResolvedValue([
		"org-a",
		"org-b",
	]);
	fixtures.listGraphProjectionCertificationOrganizations.mockResolvedValue([]);
	fixtures.getGraphProjectionCursor.mockResolvedValue(7);
	fixtures.measureGraphProjectionBacklog.mockResolvedValue({
		organizations: 2,
		pending: 1234,
		capped: 0,
	});
	const workflow = {
		createBatch: vi.fn(async (batch: unknown[]) => batch),
	};
	const scheduledTime = Date.UTC(2026, 9, 21, 22, 30);

	const metrics = await dispatchGraphProjectionDrains(graphEnv(workflow), {
		scheduledTime,
	} as ScheduledController);

	expect(fixtures.listGraphProjectionOrganizations).toHaveBeenCalledWith(
		expect.anything(),
		100,
		{ failedSince: new Date(scheduledTime - 10 * 60 * 1000).toISOString() },
	);
	expect(workflow.createBatch).toHaveBeenCalledWith([
		expect.objectContaining({
			params: { organizationId: "org-a", maxBatches: 5 },
		}),
		expect.objectContaining({
			params: { organizationId: "org-b", maxBatches: 5 },
		}),
	]);
	expect(metrics).toMatchObject({
		configured: 1,
		started: 2,
		backlogPending: 1234,
		backlogCapped: 0,
	});
});

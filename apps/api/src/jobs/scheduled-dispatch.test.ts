/**
 * Disabled-mode cron proof: with `TEDIX_FLEET_AUTHORITY_MODE=disabled`, every
 * cron pattern the authority classification calls fleet-commercial must
 * dispatch to NOTHING — no job module side effects, and no env binding access
 * beyond reading the mode itself. The dispatcher's `fleetEnabled &&` gates sit
 * before each `await import()`, so a poisoned env proxy proves both at once:
 * if a commercial branch ran, its job would touch a binding and throw.
 *
 * FLEET_COMMERCIAL_CRONS below is the classification: add a new
 * fleet-commercial cron here, and a commercial cron whose branch forgets the
 * `fleetEnabled &&` gate fails before it can reach commercial storage in a
 * self-hosted installation.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { scheduled } from "./scheduled-dispatch";

/** apps/api crons whose every branch is fleet-commercial authority. */
const FLEET_COMMERCIAL_CRONS = [
	"*/15 * * * *", // provider usage ingestion and commercial billing ledgers
	"0 * * * *", // installation health paging plus provider cost anomalies
	"0 */6 * * *", // global provider scan, catalog drift, cross-tenant health
	"0 2 * * *", // trial expiration and global catalog synchronization
	"0 3 * * *", // retention that also repairs the global catalog
	"0 4 * * *", // memory reflection dispatched only on fleet installations
	"0 6 * * *", // global catalog tool certification
];

const catchup = vi.hoisted(() => ({
	providerEvents: vi.fn().mockResolvedValue({ dispatched: 0 }),
	ingest: vi.fn(),
	billing: vi.fn(),
	paths: [] as string[],
	outcomes: [] as Array<{ id: string; status: "success" | "failure" }>,
}));
vi.mock("./provider-events", () => ({
	maintainProviderEvents: catchup.providerEvents,
}));
vi.mock("./gateway-cost-ingestion", () => ({
	CATCHUP_PAGES_PER_RUN: 10,
	ingestGatewayLogCosts: catchup.ingest,
}));
vi.mock("./billing-cron", () => ({
	runBillingAndGatewayCostTick: catchup.billing,
}));
vi.mock("./platform-tick", () => ({
	dispatchGraphProjectionDrains: vi.fn(),
	redriveGraphGdsMaintenance: vi.fn(),
	dispatchDueSkillSchedulesTick: vi.fn(),
	sweepOrphanRunsTick: vi.fn(),
	runAlwaysOnKeepalive: vi.fn(),
}));
vi.mock("./work-attempt-lease-sweeper", () => ({
	runWorkAttemptLeaseSweeperTick: vi.fn(),
}));
vi.mock("./work-approval-redrive", () => ({
	dispatchWorkApprovalRedrives: vi.fn(),
}));
vi.mock("./platform-cron-receipts", () => ({
	runPlatformCronPath: async (
		_env: unknown,
		_event: unknown,
		id: string,
		run: () => Promise<unknown>,
	) => {
		catchup.paths.push(id);
		try {
			await run();
			catchup.outcomes.push({ id, status: "success" });
		} catch (error) {
			catchup.outcomes.push({ id, status: "failure" });
			throw error;
		}
	},
}));

const ALLOWED_ENV_READS = new Set([
	"TEDIX_FLEET_AUTHORITY_MODE",
	// Symbol coercion guards used by runtimes and matchers; never bindings.
	"then",
	Symbol.toPrimitive,
	Symbol.toStringTag,
]);

function poisonedDisabledEnv(accessed: Array<string | symbol>): CloudflareEnv {
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (property === "TEDIX_FLEET_AUTHORITY_MODE") return "disabled";
				if (ALLOWED_ENV_READS.has(property as string)) return undefined;
				accessed.push(property);
				throw new Error(`disabled-mode cron accessed env.${String(property)}`);
			},
		},
	) as CloudflareEnv;
}

describe("scheduled dispatch under disabled fleet authority", () => {
	for (const cron of FLEET_COMMERCIAL_CRONS) {
		it(`dispatches nothing for "${cron}"`, async () => {
			const accessed: Array<string | symbol> = [];
			// Cover every hour-gated branch (hourly digests key on UTC hour).
			for (const hour of [0, 2, 8, 9]) {
				const scheduledTime = Date.UTC(2026, 0, 1, hour, 0, 0);
				await scheduled(
					{ cron, scheduledTime, noRetry: () => {} },
					poisonedDisabledEnv(accessed),
					{
						waitUntil: () => {},
						passThroughOnException: () => {},
						props: {},
					} as unknown as ExecutionContext,
				);
			}
			expect(accessed).toEqual([]);
		});
	}
});

it("runs bounded gateway-only catch-up on the existing two-minute trigger", async () => {
	catchup.paths.length = 0;
	catchup.outcomes.length = 0;
	catchup.ingest.mockReset().mockResolvedValue([
		{
			gatewayId: "tedix-llm-production",
			ingested: 3,
			skipped: 0,
			failure: null,
		},
		{ gatewayId: "default", ingested: 2, skipped: 0, failure: null },
	]);
	catchup.billing.mockReset();
	await scheduled(
		{
			cron: "*/2 * * * *",
			scheduledTime: Date.UTC(2026, 8, 24, 0, 0),
			noRetry: () => {},
		},
		{
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			DB: {},
		} as unknown as CloudflareEnv,
		{
			waitUntil: () => {},
			passThroughOnException: () => {},
			props: {},
		} as unknown as ExecutionContext,
	);
	expect(catchup.paths).toContain("gateway-cost-catchup");
	expect(catchup.ingest).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		{ maxPagesPerGateway: 10 },
	);
	expect(catchup.billing).not.toHaveBeenCalled();
	expect(catchup.outcomes).toContainEqual({
		id: "gateway-cost-catchup",
		status: "success",
	});
});

it("fails the catch-up receipt on a gateway error but continues sibling cron paths", async () => {
	catchup.paths.length = 0;
	catchup.outcomes.length = 0;
	catchup.ingest.mockReset().mockResolvedValue([
		{
			gatewayId: "tedix-llm-production",
			ingested: 0,
			skipped: 0,
			failure: "fetch failed",
		},
		{ gatewayId: "default", ingested: 2, skipped: 0, failure: null },
	]);
	const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await scheduled(
			{
				cron: "*/2 * * * *",
				scheduledTime: Date.UTC(2026, 8, 24, 0, 2),
				noRetry: () => {},
			},
			{
				TEDIX_FLEET_AUTHORITY_MODE: "co-located",
				DB: {},
				TEDI_SERVICE: {},
			} as unknown as CloudflareEnv,
			{
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: {},
			} as unknown as ExecutionContext,
		);
	} finally {
		errorLog.mockRestore();
	}
	expect(catchup.outcomes).toContainEqual({
		id: "gateway-cost-catchup",
		status: "failure",
	});
	expect(catchup.outcomes).toContainEqual({
		id: "work-approval-redrive",
		status: "success",
	});
});

it("logs a content-free exception when a cron path throws and continues siblings", async () => {
	const secret = "Bearer secret-from-provider";
	catchup.paths.length = 0;
	catchup.outcomes.length = 0;
	catchup.ingest.mockReset().mockRejectedValueOnce(
		new Error(secret, {
			cause: new TypeError(`invalid ${secret}`),
		}),
	);
	const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await scheduled(
			{
				cron: "*/2 * * * *",
				scheduledTime: Date.UTC(2026, 8, 24, 0, 6),
				noRetry: () => {},
			},
			{
				TEDIX_FLEET_AUTHORITY_MODE: "co-located",
				DB: {},
				TEDI_SERVICE: {},
			} as unknown as CloudflareEnv,
			{
				waitUntil: () => {},
				passThroughOnException: () => {},
				props: {},
			} as unknown as ExecutionContext,
		);
		expect(catchup.outcomes).toContainEqual({
			id: "gateway-cost-catchup",
			status: "failure",
		});
		expect(catchup.outcomes).toContainEqual({
			id: "work-approval-redrive",
			status: "success",
		});
		const record = errorLog.mock.calls
			.map(([line]) => JSON.parse(String(line)))
			.find((entry) => entry.event === "platform.cron.path_failed");
		expect(record).toEqual({
			event: "platform.cron.path_failed",
			scheduleId: "gateway-cost-catchup",
			exception: { type: "Error", cause: { type: "TypeError" } },
		});
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
	} finally {
		errorLog.mockRestore();
	}
});

it("treats CAS contention as a successful catch-up receipt", async () => {
	catchup.outcomes.length = 0;
	catchup.ingest.mockReset().mockResolvedValue([
		{
			gatewayId: "tedix-llm-production",
			ingested: 0,
			skipped: 1,
			failure: null,
			contended: true,
		},
		{ gatewayId: "default", ingested: 0, skipped: 0, failure: null },
	]);
	await scheduled(
		{
			cron: "*/2 * * * *",
			scheduledTime: Date.UTC(2026, 8, 24, 0, 4),
			noRetry: () => {},
		},
		{
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			DB: {},
		} as unknown as CloudflareEnv,
		{
			waitUntil: () => {},
			passThroughOnException: () => {},
			props: {},
		} as unknown as ExecutionContext,
	);
	expect(catchup.outcomes).toContainEqual({
		id: "gateway-cost-catchup",
		status: "success",
	});
});

it("maintains provider notifications without fleet authority and isolates failures", async () => {
	catchup.paths.length = 0;
	catchup.outcomes.length = 0;
	catchup.providerEvents
		.mockReset()
		.mockRejectedValueOnce(new Error("provider failure"));
	await scheduled(
		{
			cron: "*/2 * * * *",
			scheduledTime: Date.UTC(2026, 0, 1),
			noRetry: () => {},
		},
		{ TEDIX_FLEET_AUTHORITY_MODE: "disabled" } as CloudflareEnv,
		{
			waitUntil: () => {},
			passThroughOnException: () => {},
			props: {},
		} as unknown as ExecutionContext,
	);
	expect(catchup.providerEvents).toHaveBeenCalledOnce();
	expect(catchup.outcomes).toContainEqual({
		id: "provider-event-maintenance",
		status: "failure",
	});
	expect(catchup.paths).toContain("work-attempt-lease-sweep");
});

/**
 * Disabled-mode cron proof: with `TEDIX_FLEET_AUTHORITY_MODE=disabled`, every
 * cron pattern the authority classification calls fleet-commercial must
 * dispatch to NOTHING — no job module side effects, and no env binding access
 * beyond reading the mode itself. The dispatcher's `fleetEnabled &&` gates sit
 * before each `await import()`, so a poisoned env proxy proves both at once:
 * if a commercial branch ran, its job would touch a binding and throw.
 *
 * The pattern list is read from scripts/oss/authority-classification.json, so
 * adding a new fleet-commercial cron automatically extends this sweep, and a
 * commercial cron whose branch forgets the `fleetEnabled &&` gate fails here
 * before it can reach commercial storage in a self-hosted installation.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import classification from "../../../../scripts/oss/authority-classification.json";
import { scheduled } from "./scheduled-dispatch";

const catchup = vi.hoisted(() => ({
	ingest: vi.fn(),
	billing: vi.fn(),
	paths: [] as string[],
	outcomes: [] as Array<{ id: string; status: "success" | "failure" }>,
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

function fleetCommercialCrons(): string[] {
	return classification.entries
		.filter(
			(entry) => entry.kind === "cron" && entry.category === "fleet-commercial",
		)
		.map((entry) => entry.identifier)
		.sort();
}

describe("scheduled dispatch under disabled fleet authority", () => {
	// The sweep below is generated from the classification file, which this
	// file's header calls a feature: a new fleet-commercial cron extends it
	// automatically. So the guard's whole job is non-vacuity — a classifier that
	// stopped emitting this category would make every generated case disappear
	// silently instead of failing. A fixed count would go stale whenever a
	// trigger is added or removed.
	it("classifies commercial cron patterns to sweep", () => {
		expect(fleetCommercialCrons().length).toBeGreaterThan(0);
	});

	for (const cron of fleetCommercialCrons()) {
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

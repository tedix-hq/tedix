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
import {
	MAINTENANCE_CRONS,
	MAINTENANCE_TRIGGER,
} from "./staggered-maintenance";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/cron-schedule";

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
	sessionEvents: vi.fn().mockResolvedValue({ queued: 0 }),
	summaries: vi.fn().mockResolvedValue({ summaryBackfillSaved: 0 }),
	providerEvents: vi.fn().mockResolvedValue({ dispatched: 0 }),
	commitment: vi.fn().mockResolvedValue({ observed: 0, dispatched: 0 }),
	ingest: vi.fn(),
	billing: vi.fn(),
	stall: vi.fn().mockResolvedValue(0),
	thinning: vi.fn().mockResolvedValue({ status: "off" }),
	paths: [] as string[],
	receipts: [] as Array<{ id: string; scheduledTime: number }>,
	outcomes: [] as Array<{ id: string; status: "success" | "failure" }>,
}));
vi.mock("./decision-outcome-labeller", () => ({
	runCardSummaryBackfill: catchup.summaries,
	runDecisionOutcomeLabeller: vi
		.fn()
		.mockResolvedValue({ immediate: 0, delayed: 0 }),
}));
vi.mock("./agent-session-event-drain", () => ({
	dispatchPendingAgentSessionEvents: catchup.sessionEvents,
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
	dispatchDueAppTriggersTick: vi.fn(),
	sweepOrphanRunsTick: vi.fn(),
	runAlwaysOnKeepalive: vi.fn(),
}));
vi.mock("./delegated-run-deadline-sweep", () => ({
	sweepDelegatedRunDeadlines: vi.fn().mockResolvedValue({}),
}));
vi.mock("./dispatcher-health-alarm", () => ({
	runDispatcherHealthAlarm: vi.fn().mockResolvedValue({}),
}));
vi.mock("./approval-expiry", () => ({
	expireOverdueApprovals: vi.fn().mockResolvedValue({ expired: 0 }),
}));
vi.mock("./work-attempt-lease-sweeper", () => ({
	runWorkAttemptLeaseSweeperTick: vi.fn(),
	runWorkMaintenanceTick: vi.fn().mockResolvedValue({}),
}));
vi.mock("./work-due", () => ({
	dispatchWorkDue: vi.fn().mockImplementation(async (_env, _time, track) => {
		for (const kind of [
			"approval-expiry",
			"work-approval-redrive",
			"interaction-review-dispatch",
			"delegated-run-deadline-sweep",
			"agent-run-supervision",
			"orphan-run-sweep",
			"work-attempt-lease-sweep",
		])
			await track(kind, async () => ({ due: 0 }));
		return { due: 0 };
	}),
}));
vi.mock("../rpc/routers/kernel/owner-tool-approval-settlement", () => ({
	runQueuedOwnerToolApprovals: vi.fn().mockResolvedValue(0),
}));
vi.mock("../rpc/context", () => ({ createContext: vi.fn() }));
vi.mock("./orphan-workflow-cleanup", () => ({
	cleanupOrphanWorkflows: vi.fn().mockResolvedValue({}),
}));
vi.mock("./retention-cleanup", () => ({
	runRetentionCleanupCron: vi.fn().mockResolvedValue({}),
}));
vi.mock("./d1-retention", () => ({
	runD1RetentionTick: vi.fn().mockResolvedValue({}),
}));
vi.mock("../services/os-output-asset-gc", () => ({
	sweepDeletedOrganizationOutputAssets: vi.fn().mockResolvedValue(0),
}));
vi.mock("./kernel-request-reconcile", () => ({
	reconcileDueKernelRequests: vi.fn(),
}));
vi.mock("./interaction-follow-through", () => ({
	dispatchInteractionReviews: vi.fn(),
}));
vi.mock("./work-approval-redrive", () => ({
	dispatchWorkApprovalRedrives: vi.fn(),
}));
vi.mock("./commitment-wakes", () => ({
	dispatchCommitmentWakes: catchup.commitment,
}));
vi.mock("./stall-recovery", () => ({ dispatchStallRecovery: catchup.stall }));
vi.mock("./work-routing", () => ({
	dispatchWorkRouting: vi.fn().mockResolvedValue({ delegated: 0, reserved: 0 }),
}));
vi.mock("./repository-observer", () => ({
	maintainRepositoryObservers: vi.fn().mockResolvedValue({ overdue: 0 }),
}));
vi.mock("./support-maintenance", () => ({
	maintainSupport: vi.fn().mockResolvedValue({ mirrors: 0 }),
}));
vi.mock("../services/os-output-revision-thinning", () => ({
	runOutputRevisionThinningTick: catchup.thinning,
}));
vi.mock("./platform-cron-receipts", () => ({
	withPlatformCronReceipts: async (
		_env: unknown,
		run: () => Promise<unknown>,
	) => run(),
	runPlatformCronPath: async (
		_env: unknown,
		event: ScheduledController,
		id: string,
		run: () => Promise<unknown>,
	) => {
		catchup.paths.push(id);
		catchup.receipts.push({ id, scheduledTime: event.scheduledTime });
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
	it("keeps every staggered fleet job behind the authority gate", async () => {
		const accessed: Array<string | symbol> = [];
		for (const [id, cron] of Object.entries(MAINTENANCE_CRONS)) {
			if (id === "content-sync" || id === "factory-weight-update") continue;
			await scheduled(
				{
					cron: MAINTENANCE_TRIGGER,
					scheduledTime: Date.parse(
						nextSkillScheduleFireAt(cron, Date.UTC(2026, 0, 1) - 1),
					),
					noRetry: () => {},
				},
				poisonedDisabledEnv(accessed),
				{} as ExecutionContext,
			);
		}
		expect(accessed).toEqual([]);
	});

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

it("dispatches the former 03:00 jobs and D1 retention only in their new slots", async () => {
	const env = {
		TEDIX_FLEET_AUTHORITY_MODE: "co-located",
		DB: {},
	} as unknown as CloudflareEnv;
	for (const offset of [0, 11_000, 11_292, 25_200, 59_999]) {
		for (const [minute, expected] of [
			[11, "d1-retention"],
			[13, "output-asset-gc"],
			[21, "card-summary-backfill"],
			[23, "retention-cleanup"],
		] as const) {
			catchup.paths.length = 0;
			catchup.receipts.length = 0;
			catchup.outcomes.length = 0;
			const scheduledTime = Date.UTC(2026, 10, 25, 3, minute) + offset;
			await scheduled(
				{
					cron: MAINTENANCE_TRIGGER,
					scheduledTime,
					noRetry: () => {},
				},
				env,
				{} as ExecutionContext,
			);
			const expectedPaths = expected ? [expected] : [];
			expect(catchup.paths).toEqual(expectedPaths);
			expect(catchup.receipts).toEqual(
				expectedPaths.map((id) => ({ id, scheduledTime })),
			);
			expect(catchup.outcomes).toEqual(
				expectedPaths.map((id) => ({ id, status: "success" })),
			);
		}
	}
	catchup.paths.length = 0;
	await scheduled(
		{
			cron: "0 3 * * *",
			scheduledTime: Date.UTC(2026, 10, 25, 3),
			noRetry: () => {},
		},
		env,
		{} as ExecutionContext,
	);
	expect(catchup.paths).toEqual([]);
});

it("runs bounded gateway-only catch-up on the existing two-minute trigger", async () => {
	catchup.paths.length = 0;
	catchup.outcomes.length = 0;
	catchup.summaries.mockClear();
	catchup.ingest.mockReset().mockResolvedValue([
		{
			gatewayId: "test-llm-gateway",
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
	expect(catchup.summaries).not.toHaveBeenCalled();
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
	expect(catchup.thinning).toHaveBeenCalledWith(
		expect.objectContaining({ now: new Date(Date.UTC(2026, 8, 24, 0, 0)) }),
	);
});

it("fails the catch-up receipt on a gateway error but continues sibling cron paths", async () => {
	catchup.paths.length = 0;
	catchup.outcomes.length = 0;
	catchup.ingest.mockReset().mockResolvedValue([
		{
			gatewayId: "test-llm-gateway",
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
			causeChain: [{}],
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
			gatewayId: "test-llm-gateway",
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
	catchup.sessionEvents.mockClear();
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
	expect(catchup.paths).toContain("agent-session-event-drain");
	expect(catchup.sessionEvents).toHaveBeenCalledOnce();
	expect(catchup.outcomes).toContainEqual({
		id: "provider-event-maintenance",
		status: "failure",
	});
	expect(catchup.paths).toContain("work-attempt-lease-sweep");
	expect(catchup.paths).toContain("kernel-request-reconcile");
	expect(catchup.paths).toContain("interaction-review-dispatch");
});

it("dispatches stall recovery once every six minutes across the hour boundary", async () => {
	catchup.stall.mockClear();
	const env = {
		TEDIX_FLEET_AUTHORITY_MODE: "disabled",
		DB: {},
		TEDI_SERVICE: {},
	} as unknown as CloudflareEnv;
	const start = Date.UTC(2026, 10, 15, 0, 54);
	const dispatchedAt: number[] = [];
	for (let minute = 0; minute <= 60; minute += 2) {
		const background: Promise<unknown>[] = [];
		const scheduledTime = start + minute * 60_000;
		const callsBefore = catchup.stall.mock.calls.length;
		await scheduled(
			{ cron: "*/2 * * * *", scheduledTime, noRetry: () => {} },
			env,
			{
				waitUntil: (work: Promise<unknown>) => background.push(work),
				passThroughOnException: () => {},
				props: {},
			} as unknown as ExecutionContext,
		);
		await Promise.all(background);
		expect(catchup.stall.mock.calls.length - callsBefore).toBe(
			minute % 6 === 0 ? 1 : 0,
		);
		if (catchup.stall.mock.calls.length > callsBefore)
			dispatchedAt.push(scheduledTime);
	}
	expect(dispatchedAt).toEqual(
		Array.from({ length: 11 }, (_, index) => start + index * 360_000),
	);
	expect(catchup.stall.mock.calls.map((call) => call[2])).toEqual(dispatchedAt);
});

it("keeps commitment replay and later paths live while stall recovery is pending or fails", async () => {
	catchup.paths.length = 0;
	catchup.outcomes.length = 0;
	catchup.ingest.mockResolvedValue([]);
	let rejectRecovery!: (error: Error) => void;
	catchup.stall.mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				rejectRecovery = reject;
			}),
	);
	const background: Promise<unknown>[] = [];
	const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const invocation = scheduled(
			{
				cron: "*/2 * * * *",
				scheduledTime: Date.UTC(2026, 9, 19),
				noRetry: () => {},
			},
			{
				TEDIX_FLEET_AUTHORITY_MODE: "disabled",
				DB: {},
				TEDI_SERVICE: {},
			} as unknown as CloudflareEnv,
			{
				waitUntil: (work: Promise<unknown>) => {
					background.push(work);
				},
				passThroughOnException: () => {},
				props: {},
			} as unknown as ExecutionContext,
		);
		await vi.waitFor(() =>
			expect(catchup.outcomes).toContainEqual({
				id: "commitment-wakes",
				status: "success",
			}),
		);
		expect(catchup.outcomes).toContainEqual({
			id: "repository-observer",
			status: "success",
		});
		expect(catchup.outcomes).not.toContainEqual({
			id: "stall-recovery",
			status: "success",
		});
		rejectRecovery(new Error("recovery unavailable"));
		await invocation;
		await Promise.all(background);
		expect(catchup.outcomes).toContainEqual({
			id: "stall-recovery",
			status: "failure",
		});
	} finally {
		errorLog.mockRestore();
	}
});

it("keeps repository and support maintenance running after a commitment failure", async () => {
	catchup.outcomes.length = 0;
	catchup.commitment.mockRejectedValueOnce(
		new Error("D1_ERROR Network connection lost: secret-sql"),
	);
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await scheduled(
			{
				cron: "*/2 * * * *",
				scheduledTime: Date.UTC(2026, 9, 22, 7, 4),
				noRetry: () => {},
			} as ScheduledController,
			{
				TEDIX_FLEET_AUTHORITY_MODE: "disabled",
				TEDI_SERVICE: {},
				DB: {},
			} as unknown as CloudflareEnv,
			{ waitUntil: () => {} } as unknown as ExecutionContext,
		);
		expect(catchup.outcomes).toContainEqual({
			id: "commitment-wakes",
			status: "failure",
		});
		expect(catchup.outcomes).toContainEqual({
			id: "repository-observer",
			status: "success",
		});
		expect(catchup.outcomes).toContainEqual({
			id: "support-maintenance",
			status: "success",
		});
		const failure = errors.mock.calls
			.map(([entry]) => JSON.parse(String(entry)))
			.find((entry) => entry.scheduleId === "commitment-wakes");
		expect(failure.messageClass).toEqual([
			"D1_ERROR",
			"Network connection lost",
		]);
		expect(JSON.stringify(errors.mock.calls)).not.toContain("secret-sql");
	} finally {
		errors.mockRestore();
	}
});

it("dispatches low-urgency jobs only in their maintenance slots", async () => {
	const ids = [
		"decision-outcome-labeller",
		"card-summary-backfill",
		"graph-gds-redrive",
	];
	const fired: Record<string, number[]> = Object.fromEntries(
		ids.map((id) => [id, []]),
	);
	for (let minute = 0; minute < 120; minute++) {
		catchup.paths.length = 0;
		await scheduled(
			{
				cron: minute % 2 ? MAINTENANCE_TRIGGER : "*/2 * * * *",
				scheduledTime: Date.UTC(2026, 10, 25) + minute * 60_000,
				noRetry: () => {},
			},
			{ TEDIX_FLEET_AUTHORITY_MODE: "disabled" } as CloudflareEnv,
			{ waitUntil: () => {} } as unknown as ExecutionContext,
		);
		for (const id of ids)
			if (catchup.paths.includes(id)) fired[id].push(minute);
	}
	expect(fired).toEqual({
		"decision-outcome-labeller": [1, 31, 61, 91],
		"card-summary-backfill": [21, 51, 81, 111],
		"graph-gds-redrive": [55, 115],
	});
});

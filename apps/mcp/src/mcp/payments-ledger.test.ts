/// <reference types="node" />
import { createDbClient } from "@tedix/db/client";
import {
	getMcpPaymentEventByIdForOrg,
	listMcpPaymentReservations,
} from "@tedix/db/queries/mcp-payments";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	recordPaymentEvent,
	reservePaymentRequirement,
} from "./payments-ledger";
import {
	DEFAULT_PAYMENT_TTL_SECONDS,
	type TedixToolPaymentPolicy,
} from "./payments-policy";
import { buildPaymentRequirements } from "./payments-requirements";
import type { AppTool, ServerContext } from "./server-context";

const NOW = "2026-10-22T12:00:00.000Z";
const ORG = "org-ledger";
const OTHER_ORG = "org-other";
const tool = { id: "tool-row", toolId: "read_report" } as AppTool;
const policy: TedixToolPaymentPolicy = {
	enabled: true,
	amount: "0.40",
	network: "solana-devnet",
	recipient: "fictional-recipient",
};
const sqlite = createMigratedSqlite();
const d1 = createD1Facade(sqlite, { maxBoundParams: 100 });
const db = createDbClient(d1);

function agent(
	organizationId = ORG,
	overrides: Partial<ServerContext> = {},
): ServerContext {
	return {
		env: { DB: d1 },
		appId: "app-ledger",
		appSlug: "ledger-demo",
		app: { organizationId },
		traceId: "trace-ledger",
		callerIdentity: { userId: "user-ledger", authType: "oauth" },
		...overrides,
	} as unknown as ServerContext;
}

function event(
	overrides: Partial<Parameters<typeof recordPaymentEvent>[0]> = {},
) {
	return recordPaymentEvent({
		agent: agent(),
		tool,
		policy,
		args: { report: "fictional" },
		requirementId: "req-ledger",
		eventId: "event-ledger",
		eventType: "payment_settled",
		status: "settled",
		settled: true,
		...overrides,
	});
}

async function reserve(
	overrides: Partial<Parameters<typeof reservePaymentRequirement>[0]> = {},
) {
	const params = {
		agent: agent(),
		tool,
		policy,
		requirementId: "req-ledger",
		paymentRequestId: "request-ledger",
		...overrides,
	};
	const requirements =
		overrides.requirements ?? (await buildPaymentRequirements(params));
	await reservePaymentRequirement({ ...params, requirements });
}

function rows(
	table:
		| "mcp_payment_events"
		| "mcp_payment_reservations"
		| "audit_events"
		| "tedi_rationale_records",
) {
	return sqlite.prepare(`SELECT * FROM ${table}`).all();
}

beforeAll(() => {
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('org-ledger', 'Ledger Demo', 'ledger-demo'), ('org-other', 'Other Demo', 'other-demo');
		INSERT INTO apps (id, organization_id, name, slug) VALUES
			('app-ledger', 'org-ledger', 'Ledger Demo', 'ledger-demo');
		INSERT INTO tedis (id, organization_id, name, slug) VALUES
			('tedi-ledger', 'org-ledger', 'Ledger Assistant', 'ledger-assistant');
	`);
});

beforeEach(() => {
	sqlite.exec(`
		DELETE FROM mcp_payment_reservations;
		DELETE FROM mcp_payment_events;
		DELETE FROM audit_events;
		DELETE FROM tedi_rationale_records;
	`);
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("reservePaymentRequirement", () => {
	it.each([
		{ ttlSeconds: 45, expected: 45 },
		{ ttlSeconds: undefined, expected: DEFAULT_PAYMENT_TTL_SECONDS },
	])(
		"reserves with TTL $expected seconds",
		async ({ ttlSeconds, expected }) => {
			await reserve({ policy: { ...policy, ttlSeconds } });
			expect(rows("mcp_payment_reservations")).toEqual([
				expect.objectContaining({
					id: "mcp-payment-reservation:req-ledger",
					requirement_id: "req-ledger",
					organization_id: ORG,
					status: "reserved",
					amount: "0.40",
					mode: "mock",
					asset: "USDC",
					currency: "USDC",
					account_id: null,
					policy_id: null,
					resource: "mcp://ledger-demo/tools/read_report#req-ledger",
					expires_at: new Date(Date.parse(NOW) + expected * 1000)
						.toISOString()
						.slice(0, 19)
						.replace("T", " "),
					metadata: JSON.stringify({
						paymentRequestId: "request-ledger",
						appId: "app-ledger",
						toolRowId: "tool-row",
					}),
				}),
			]);
			expect(rows("audit_events")).toEqual([]);
		},
	);

	it("refreshes the same requirement without duplicating its reservation", async () => {
		await reserve();
		vi.setSystemTime(Date.parse(NOW) + 60_000);
		await reserve({ paymentRequestId: "request-refreshed" });
		expect(rows("mcp_payment_reservations")).toHaveLength(1);
		expect(rows("mcp_payment_reservations")[0]).toMatchObject({
			id: "mcp-payment-reservation:req-ledger",
			expires_at: "2026-10-22 12:06:00",
			metadata: JSON.stringify({
				paymentRequestId: "request-refreshed",
				appId: "app-ledger",
				toolRowId: "tool-row",
			}),
		});
	});

	it.each(["database", "organization"] as const)(
		"does not reserve without a %s",
		async (missing) => {
			const context = agent(
				ORG,
				missing === "database"
					? { env: {} as ServerContext["env"] }
					: { app: undefined },
			);
			await reserve({ agent: context });
			expect(rows("mcp_payment_reservations")).toEqual([]);
			expect(rows("audit_events")).toEqual([]);
		},
	);

	it("uses the caller organization when the app has none", async () => {
		const context = agent(ORG, {
			app: undefined,
			callerIdentity: { ...agent().callerIdentity!, organizationId: ORG },
		});
		await reserve({ agent: context });
		expect(rows("mcp_payment_reservations")[0]).toMatchObject({
			organization_id: ORG,
		});
	});

	it("contains a reservation write failure without writing a row", async () => {
		sqlite.exec(
			"CREATE TRIGGER fail_reservation BEFORE INSERT ON mcp_payment_reservations BEGIN SELECT RAISE(ABORT, 'reservation unavailable'); END",
		);
		try {
			await expect(reserve()).resolves.toBeUndefined();
			expect(rows("mcp_payment_reservations")).toEqual([]);
		} finally {
			sqlite.exec("DROP TRIGGER fail_reservation");
		}
	});
});

describe("recordPaymentEvent", () => {
	it.each([
		{
			eventType: "payment_required",
			status: "required",
			reservationStatus: "reserved",
			settled: false,
		},
		{
			eventType: "payment_settled",
			status: "settled",
			reservationStatus: "settled",
			settled: true,
		},
		{
			eventType: "payment_rejected",
			status: "rejected",
			reservationStatus: "rejected",
			settled: false,
		},
	] as const)(
		"records $status and updates its reservation",
		async ({ eventType, status, reservationStatus, settled }) => {
			await reserve();
			expect(
				await event({
					eventType,
					status,
					settled,
					budgetDecision: { reason: "test-decision" },
				}),
			).toEqual({
				eventId: "event-ledger",
				guardRejected: false,
				guardError: false,
				recorded: true,
			});
			const stored = await getMcpPaymentEventByIdForOrg(db, {
				id: "event-ledger",
				organizationId: ORG,
			});
			expect(stored).toMatchObject({
				eventType,
				status,
				settled,
				organizationId: ORG,
				requirementId: "req-ledger",
				protocol: "x402",
				mode: "mock",
				amount: "0.40",
				currency: "USDC",
				asset: "USDC",
				toolId: tool.toolId,
				userId: "user-ledger",
				traceId: "trace-ledger",
				budgetDecision: { reason: "test-decision" },
				rationaleRecordId: null,
			});
			expect(stored?.toolArgsHash).toMatch(/^[a-f0-9]{64}$/);
			expect(rows("mcp_payment_reservations")[0]).toMatchObject({
				status: reservationStatus,
				settled_event_id: settled ? "event-ledger" : null,
			});
			expect(rows("audit_events")).toEqual([
				expect.objectContaining({
					id: stored?.auditEventId,
					organization_id: ORG,
					actor_id: "user-ledger",
					actor_type: "user",
					action: `mcp.payment.${status}`,
					resource_type: "mcp_payment_event",
					resource_id: "event-ledger",
				}),
			]);
		},
	);

	it("appends required and settled events for one requirement", async () => {
		await reserve();
		await event({
			eventId: "event-required",
			eventType: "payment_required",
			status: "required",
			settled: false,
		});
		await event();
		expect(rows("mcp_payment_events")).toHaveLength(2);
		expect(rows("mcp_payment_reservations")).toHaveLength(1);
		expect(rows("mcp_payment_reservations")[0]).toMatchObject({
			status: "settled",
			settled_event_id: "event-ledger",
		});
	});

	it("does not duplicate an event id on redelivery", async () => {
		await event();
		expect(await event()).toEqual({
			eventId: "event-ledger",
			guardRejected: false,
			guardError: false,
			recorded: false,
		});
		expect(rows("mcp_payment_events")).toHaveLength(1);
		// Audit precedes the event insert, including duplicate attempts.
		expect(rows("audit_events")).toHaveLength(2);
	});

	it("guards settlement atomically and leaves rejected reservations pending", async () => {
		const budgetGuard = { maxAmount: "0.50", since: "2000-01-01 00:00:00" };
		await reserve();
		expect(
			await event({
				eventId: "first",
				requirementId: "first-req",
				budgetGuard,
			}),
		).toMatchObject({
			recorded: true,
			guardRejected: false,
			guardError: false,
		});
		expect(await event({ budgetGuard })).toEqual({
			eventId: "event-ledger",
			guardRejected: true,
			guardError: false,
			recorded: false,
		});
		expect(rows("mcp_payment_events").map((row) => row.id)).toEqual(["first"]);
		expect(rows("mcp_payment_reservations")[0]).toMatchObject({
			status: "reserved",
			settled_event_id: null,
		});
		expect(rows("audit_events")).toHaveLength(2);
	});

	it.each([
		{
			budgetGuard: { maxAmount: "1.00", since: "2000-01-01 00:00:00" },
			requireDurable: false,
			guardError: true,
		},
		{ budgetGuard: undefined, requireDurable: true, guardError: true },
		{ budgetGuard: undefined, requireDurable: false, guardError: false },
	])(
		"reports an event write failure with guardError=$guardError",
		async ({ budgetGuard, requireDurable, guardError }) => {
			await reserve();
			sqlite.exec(
				"CREATE TRIGGER fail_event BEFORE INSERT ON mcp_payment_events BEGIN SELECT RAISE(ABORT, 'event unavailable'); END",
			);
			try {
				expect(await event({ budgetGuard, requireDurable })).toEqual({
					eventId: "event-ledger",
					guardRejected: false,
					guardError,
					recorded: false,
				});
				expect(rows("mcp_payment_events")).toEqual([]);
				expect(rows("mcp_payment_reservations")[0]).toMatchObject({
					status: "reserved",
				});
				expect(rows("audit_events")).toHaveLength(1);
			} finally {
				sqlite.exec("DROP TRIGGER fail_event");
			}
		},
	);

	it("isolates event reads, reservation reads and settlement updates by organization", async () => {
		await reserve();
		await event({ agent: agent(OTHER_ORG) });
		expect(
			await getMcpPaymentEventByIdForOrg(db, {
				id: "event-ledger",
				organizationId: ORG,
			}),
		).toBeNull();
		expect(
			await getMcpPaymentEventByIdForOrg(db, {
				id: "event-ledger",
				organizationId: OTHER_ORG,
			}),
		).toMatchObject({ organizationId: OTHER_ORG });
		expect(
			await listMcpPaymentReservations(db, {
				organizationId: OTHER_ORG,
				limit: 10,
			}),
		).toEqual([]);
		expect(
			await listMcpPaymentReservations(db, { organizationId: ORG, limit: 10 }),
		).toEqual([
			expect.objectContaining({ status: "reserved", settledEventId: null }),
		]);
	});

	it("returns unrecorded without a database", async () => {
		const context = agent(ORG, { env: {} as ServerContext["env"] });
		expect(await event({ agent: context })).toEqual({
			eventId: "event-ledger",
			guardRejected: false,
			guardError: false,
			recorded: false,
		});
		expect(rows("mcp_payment_events")).toEqual([]);
		expect(rows("audit_events")).toEqual([]);
	});

	it("records an unscoped event without auditing or settling a reservation", async () => {
		await reserve();
		const context = agent(ORG, { app: undefined });
		expect(await event({ agent: context })).toMatchObject({ recorded: true });
		expect(rows("mcp_payment_events")[0]).toMatchObject({
			organization_id: null,
			audit_event_id: null,
		});
		expect(rows("audit_events")).toEqual([]);
		expect(rows("mcp_payment_reservations")[0]).toMatchObject({
			status: "reserved",
		});
	});

	it("links a tedi audit and completed rationale to the receipt", async () => {
		const context = agent(ORG, {
			callerIdentity: { ...agent().callerIdentity!, tediId: "tedi-ledger" },
		});
		await event({
			agent: context,
			paymentResponse: { receiptId: "receipt-ledger" },
		});
		const stored = rows("mcp_payment_events")[0];
		expect(stored).toBeDefined();
		expect(rows("audit_events")[0]).toMatchObject({
			id: stored?.audit_event_id,
			actor_type: "tedi",
			actor_id: "tedi-ledger",
		});
		expect(rows("tedi_rationale_records")).toEqual([
			expect.objectContaining({
				id: stored?.rationale_record_id,
				tedi_id: "tedi-ledger",
				org_id: ORG,
				action: "mcp.payment.settled",
				outcome_status: "success",
				tool_call_refs: JSON.stringify([
					"mcp_payment_event:event-ledger:read_report",
				]),
			}),
		]);
	});
});

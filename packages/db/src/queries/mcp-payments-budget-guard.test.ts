import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import type { NewMcpPaymentEvent } from "../schema/mcp-payments";
import { insertSettledMcpPaymentEventWithinBudget } from "./mcp-payments";

const ORG = "org-budget";
const DDL = `
CREATE TABLE mcp_payment_events (
	id TEXT PRIMARY KEY NOT NULL,
	requirement_id TEXT NOT NULL,
	event_type TEXT NOT NULL,
	status TEXT NOT NULL,
	protocol TEXT NOT NULL DEFAULT 'x402',
	mode TEXT NOT NULL DEFAULT 'mock',
	network TEXT NOT NULL,
	asset TEXT,
	currency TEXT,
	amount TEXT NOT NULL,
	recipient TEXT NOT NULL,
	resource TEXT,
	app_id TEXT,
	app_slug TEXT NOT NULL,
	organization_id TEXT,
	tool_row_id TEXT,
	tool_id TEXT NOT NULL,
	tedi_id TEXT,
	user_id TEXT,
	client_id TEXT,
	auth_type TEXT,
	trace_id TEXT,
	tool_args_hash TEXT,
	settled INTEGER NOT NULL DEFAULT 0,
	requirements TEXT,
	payment_proof TEXT,
	payment_response TEXT,
	budget_policy TEXT,
	budget_decision TEXT,
	decision_rationale TEXT,
	audit_event_id TEXT,
	rationale_record_id TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
`;

function makeDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

let seq = 0;
function settledEvent(
	overrides: Partial<NewMcpPaymentEvent> = {},
): NewMcpPaymentEvent {
	seq += 1;
	return {
		id: `evt-${seq}`,
		requirementId: `req-${seq}`,
		eventType: "payment_settled",
		status: "settled",
		protocol: "x402",
		mode: "mock",
		network: "solana-devnet",
		asset: "USDC",
		currency: "USDC",
		amount: "0.40",
		recipient: "recipient-1",
		appSlug: "paymesh-demo",
		organizationId: ORG,
		toolId: "premium_research_brief",
		settled: true,
		...overrides,
	} as NewMcpPaymentEvent;
}

const GUARD = {
	maxAmount: "1.00",
	since: "2026-08-01 00:00:00",
};

describe("insertSettledMcpPaymentEventWithinBudget", () => {
	it("settles while the window spend stays within the ceiling", async () => {
		const { db, sqlite } = makeDb();
		expect(
			await insertSettledMcpPaymentEventWithinBudget(db, settledEvent(), GUARD),
		).toBe(true);
		expect(
			await insertSettledMcpPaymentEventWithinBudget(db, settledEvent(), GUARD),
		).toBe(true);
		const count = sqlite
			.prepare("SELECT COUNT(*) AS n FROM mcp_payment_events")
			.get() as { n: number };
		expect(count.n).toBe(2);
	});

	it("rejects the settlement that would cross the ceiling", async () => {
		const { db, sqlite } = makeDb();
		// 0.40 + 0.40 = 0.80 settles; the third (1.20 projected) must not.
		await insertSettledMcpPaymentEventWithinBudget(db, settledEvent(), GUARD);
		await insertSettledMcpPaymentEventWithinBudget(db, settledEvent(), GUARD);
		expect(
			await insertSettledMcpPaymentEventWithinBudget(db, settledEvent(), GUARD),
		).toBe(false);
		const count = sqlite
			.prepare("SELECT COUNT(*) AS n FROM mcp_payment_events")
			.get() as { n: number };
		expect(count.n).toBe(2);
	});

	it("ignores spend outside the budget window", async () => {
		const { db, sqlite } = makeDb();
		sqlite
			.prepare(
				`INSERT INTO mcp_payment_events
					(id, requirement_id, event_type, status, network, currency, amount,
					 recipient, app_slug, organization_id, tool_id, settled, created_at)
				 VALUES ('old', 'req-old', 'payment_settled', 'settled',
					 'solana-devnet', 'USDC', '99', 'recipient-1', 'paymesh-demo',
					 '${ORG}', 'premium_research_brief', 1, '2026-07-01 00:00:00')`,
			)
			.run();
		expect(
			await insertSettledMcpPaymentEventWithinBudget(db, settledEvent(), GUARD),
		).toBe(true);
	});

	it("scopes the window to the guarded tool when toolId is set", async () => {
		const { db } = makeDb();
		await insertSettledMcpPaymentEventWithinBudget(
			db,
			settledEvent({ toolId: "other_tool", amount: "0.90" }),
			GUARD,
		);
		expect(
			await insertSettledMcpPaymentEventWithinBudget(
				db,
				settledEvent({ amount: "0.90" }),
				{ ...GUARD, toolId: "premium_research_brief" },
			),
		).toBe(true);
	});

	it("only counts settled spend toward the ceiling", async () => {
		const { db } = makeDb();
		await insertSettledMcpPaymentEventWithinBudget(
			db,
			settledEvent({ amount: "0.90" }),
			GUARD,
		);
		// A rejected event in the window must not consume budget.
		expect(
			await insertSettledMcpPaymentEventWithinBudget(
				db,
				settledEvent({
					amount: "0.05",
					eventType: "payment_rejected",
					status: "rejected",
					settled: false,
				} as Partial<NewMcpPaymentEvent>),
				GUARD,
			),
		).toBe(true);
		expect(
			await insertSettledMcpPaymentEventWithinBudget(
				db,
				settledEvent({ amount: "0.05" }),
				GUARD,
			),
		).toBe(true);
	});

	it("requires an organizationId", async () => {
		const { db } = makeDb();
		await expect(
			insertSettledMcpPaymentEventWithinBudget(
				db,
				settledEvent({ organizationId: null }),
				GUARD,
			),
		).rejects.toThrow(/organizationId/);
	});
});

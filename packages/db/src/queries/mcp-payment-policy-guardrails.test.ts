import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	getEffectiveMcpPaymentPolicy,
	upsertMcpPaymentPolicy,
} from "./mcp-payments";

const ORG = "org-payment-guardrails";

function makeDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE mcp_payment_policies (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			app_slug TEXT,
			tool_id TEXT,
			currency TEXT NOT NULL DEFAULT 'USDC',
			network TEXT NOT NULL DEFAULT 'solana-devnet',
			enabled INTEGER NOT NULL DEFAULT 1,
			max_amount TEXT NOT NULL,
			max_transaction_amount TEXT,
			allowed_recipients TEXT,
			allowed_tools TEXT,
			window_seconds INTEGER NOT NULL DEFAULT 86400,
			mode TEXT NOT NULL DEFAULT 'enforce',
			created_by TEXT,
			updated_by TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("managed MCP payment guardrails", () => {
	it("persists, resolves, and clears the cap and allow lists", async () => {
		const { db, sqlite } = makeDb();
		const base = {
			id: "policy-1",
			organizationId: ORG,
			tediId: null,
			appSlug: null,
			toolId: null,
			currency: "USDC",
			network: "solana-devnet",
			enabled: true,
			maxAmount: "10",
			windowSeconds: 3600,
			mode: "enforce" as const,
		};
		await upsertMcpPaymentPolicy(db, {
			...base,
			maxTransactionAmount: "0.02",
			allowedRecipients: ["recipient-a"],
			allowedTools: ["paymesh-demo:premium_research_brief"],
		});
		const target = {
			organizationId: ORG,
			tediId: null,
			appSlug: "paymesh-demo",
			toolId: "premium_research_brief",
			currency: "USDC",
			network: "solana-devnet",
		};
		await expect(
			getEffectiveMcpPaymentPolicy(db, target),
		).resolves.toMatchObject({
			maxTransactionAmount: "0.02",
			allowedRecipients: ["recipient-a"],
			allowedTools: ["paymesh-demo:premium_research_brief"],
		});
		await upsertMcpPaymentPolicy(db, { ...base, maxAmount: "20" });
		await expect(
			getEffectiveMcpPaymentPolicy(db, target),
		).resolves.toMatchObject({
			maxAmount: "20",
			maxTransactionAmount: "0.02",
			allowedRecipients: ["recipient-a"],
			allowedTools: ["paymesh-demo:premium_research_brief"],
		});
		await upsertMcpPaymentPolicy(db, {
			...base,
			maxTransactionAmount: null,
			allowedRecipients: null,
			allowedTools: null,
		});
		await expect(
			getEffectiveMcpPaymentPolicy(db, target),
		).resolves.toMatchObject({
			maxTransactionAmount: null,
			allowedRecipients: null,
			allowedTools: null,
		});
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM mcp_payment_policies").get(),
		).toMatchObject({ n: 1 });
		sqlite.close();
	});
});

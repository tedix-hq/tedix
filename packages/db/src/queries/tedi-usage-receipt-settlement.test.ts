import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { type NewTediCallCost, tediCallCosts } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	insertCallCosts,
	settleGatewayReportedReceiptCosts,
} from "./tedi-usage";

const SOURCE = "provider-response:web-search";

function fixture(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tediCallCosts));
	return createDbClient(createD1Facade(sqlite)) as DbClient;
}

function receipt(
	gatewayLogId: string,
	overrides: Partial<NewTediCallCost> = {},
): NewTediCallCost {
	return {
		id: `id-${gatewayLogId}`,
		orgId: "org-example",
		tediId: "tedi-example",
		gatewayLogId,
		gatewayId: "gateway-example",
		snapshotAt: "2026-10-21T10:00:00.000Z",
		model: "web-search",
		provider: "ai-gateway",
		sessionType: "tedi",
		source: SOURCE,
		costBasis: "unknown",
		estimatedCostUsd: null,
		sessionCount: 1,
		dataQuality: "quarantined_no_pricing",
		...overrides,
	};
}

it("prices only unpriced receipts of the source on the same gateway", async () => {
	const db = fixture();
	await insertCallCosts(db, [
		receipt("log-1"),
		receipt("log-2", { gatewayId: "other-gateway" }),
		receipt("log-3", { source: "ai-gateway-log" }),
		receipt("log-4", {
			costBasis: "gateway_reported",
			estimatedCostUsd: 0.5,
			dataQuality: "ok",
		}),
	]);
	await settleGatewayReportedReceiptCosts(db, {
		gatewayId: "gateway-example",
		source: SOURCE,
		receipts: ["log-1", "log-2", "log-3", "log-4"].map((gatewayLogId) => ({
			gatewayLogId,
			costUsd: 0.004,
			success: true,
		})),
	});
	const rows = await db.select().from(tediCallCosts);
	const byLog = new Map(rows.map((row) => [row.gatewayLogId, row]));
	expect(byLog.get("log-1")).toMatchObject({
		estimatedCostUsd: 0.004,
		rawReportedCostUsd: 0.004,
		costBasis: "gateway_reported",
		dataQuality: "ok",
		costReason: null,
	});
	expect(byLog.get("log-2")?.costBasis).toBe("unknown");
	expect(byLog.get("log-3")?.costBasis).toBe("unknown");
	expect(byLog.get("log-4")?.estimatedCostUsd).toBe(0.5);
	await settleGatewayReportedReceiptCosts(db, {
		gatewayId: "gateway-example",
		source: SOURCE,
		receipts: [],
	});
});

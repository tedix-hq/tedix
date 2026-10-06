import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { mcpPaymentEvents } from "@tedix/db/schema/mcp-payments";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	mcpPaymentsContractRouter,
	requestBudgetOverrideForTedi,
} from "./mcp-payments";

const ORG = "00000000-0000-4000-8000-000000000001";
const TEDI = "00000000-0000-4000-8000-000000000002";
const EVENT = "00000000-0000-4000-8000-000000000003";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(mcpPaymentEvents, tediApprovalRequests, auditEvents));
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade);
	let workflowStarts = 0;
	const context = {
		db,
		env: {
			DB: facade,
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			APPROVAL_WORKFLOW: {
				create: async () => {
					workflowStarts += 1;
				},
			},
		},
		organizationId: ORG,
		tediScopes: ["mcp:messaging.write"],
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Id": TEDI,
		}),
	} as unknown as BaseContext;
	return { db, context, getWorkflowStarts: () => workflowStarts };
}

describe("payment budget override request", () => {
	it("binds one pending human review to the tedi's actual budget rejection", async () => {
		const { db, context, getWorkflowStarts } = fixture();
		await db.insert(mcpPaymentEvents).values({
			id: EVENT,
			requirementId: "tedix-x402-test",
			eventType: "payment_rejected",
			status: "rejected",
			network: "eip155:84532",
			currency: "USDC",
			amount: "0.05",
			recipient: "0xrecipient",
			appSlug: "paymesh-demo",
			organizationId: ORG,
			toolId: "premium_research_brief",
			tediId: TEDI,
			budgetDecision: {
				allowed: false,
				reason: "budget_exceeded",
				maxAmount: "0.10",
				projected: "0.15",
			},
		});
		const input = { rejectedEventId: EVENT, reason: "This source is needed." };
		const first = await requestBudgetOverrideForTedi(context, ORG, TEDI, input);
		const retry = await requestBudgetOverrideForTedi(context, ORG, TEDI, input);
		expect(first.created).toBe(true);
		expect(retry.created).toBe(false);
		expect(retry.approvalRequestId).toBe(first.approvalRequestId);
		expect(getWorkflowStarts()).toBe(1);
		const [request] = await db.select().from(tediApprovalRequests);
		expect(request?.status).toBe("pending");
		expect(request?.payload).toMatchObject({
			rejectedEventId: EVENT,
			appSlug: "paymesh-demo",
			toolId: "premium_research_brief",
			projectedAmount: "0.15",
		});
		const audit = await db.select().from(auditEvents);
		expect(audit).toHaveLength(1);
		await expect(
			requestBudgetOverrideForTedi(context, ORG, crypto.randomUUID(), input),
		).rejects.toThrow("Budget rejection not found");
		await expect(
			requestBudgetOverrideForTedi(context, crypto.randomUUID(), TEDI, input),
		).rejects.toThrow("Budget rejection not found");
	});

	it("rejects unrelated payment failures", async () => {
		const { db, context } = fixture();
		await db.insert(mcpPaymentEvents).values({
			id: EVENT,
			requirementId: "tedix-x402-test",
			eventType: "payment_rejected",
			status: "rejected",
			network: "eip155:84532",
			amount: "0.05",
			recipient: "0xrecipient",
			appSlug: "paymesh-demo",
			organizationId: ORG,
			toolId: "premium_research_brief",
			tediId: TEDI,
			budgetDecision: { allowed: false, reason: "budget_store_unavailable" },
		});
		await expect(
			requestBudgetOverrideForTedi(context, ORG, TEDI, {
				rejectedEventId: EVENT,
				reason: "Please approve",
			}),
		).rejects.toThrow("Budget rejection not found");
	});

	it("accepts the trusted MCP service-binding identity and rejects a bare binding", async () => {
		const { db, context } = fixture();
		await db.insert(mcpPaymentEvents).values({
			id: EVENT,
			requirementId: "tedix-x402-test",
			eventType: "payment_rejected",
			status: "rejected",
			network: "eip155:84532",
			amount: "0.05",
			recipient: "0xrecipient",
			appSlug: "paymesh-demo",
			organizationId: ORG,
			toolId: "premium_research_brief",
			tediId: TEDI,
			budgetDecision: { allowed: false, reason: "budget_exceeded" },
		});
		const input = { rejectedEventId: EVENT, reason: "Needed for this task" };
		const client = createRouterClient(mcpPaymentsContractRouter, { context });
		expect(await client.requestBudgetOverride(input)).toMatchObject({
			status: "pending",
			created: true,
		});
		const bareContext = {
			...context,
			tediId: undefined,
			headers: new Headers({ "X-Service-Binding": "true" }),
		} as BaseContext;
		const bareClient = createRouterClient(mcpPaymentsContractRouter, {
			context: bareContext,
		});
		await expect(bareClient.requestBudgetOverride(input)).rejects.toThrow(
			"A tedi identity is required",
		);
	});
});

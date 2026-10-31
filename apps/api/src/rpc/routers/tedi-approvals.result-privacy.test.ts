import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import {
	tediApprovalExecutionReceipts,
	tediApprovalSimulations,
	tediApprovalDependencyEvents,
} from "@tedix/db/schema/approval-simulations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { userContext, apiKeyContext } from "../test-context";
import { tediApprovalsContractRouter } from "./tedi-approvals";
const ID = "00000000-0000-4000-8000-000000000001";
const MARKER = "private-result-marker";
let db: ReturnType<typeof createDbClient>;
beforeEach(async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			tediApprovalRequests,
			tediApprovalExecutionReceipts,
			tediApprovalSimulations,
			tediApprovalDependencyEvents,
		),
	);
	db = createDbClient(createD1Facade(sqlite));
	await db.insert(tediApprovalRequests).values({
		id: ID,
		tediId: "routing-tedi",
		orgId: "org-1",
		actionType: "mcp.tool_call",
		description: "Example credential issue",
		status: "approved",
		payload: {
			kind: "mcp_tool_call",
			initiatedByUserId: "requester",
			appSlug: "example",
			toolId: "example_issue_credential",
			target: { transport: "rpc" },
			args: {},
			fingerprint: "example-fingerprint",
			executionResult: { token: MARKER },
			execution: {
				status: "executed",
				startedAt: "2026-01-01T00:00:00Z",
				summary: MARKER,
				error: MARKER,
			},
		},
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2026-01-02T00:00:00Z",
	});
	await db.insert(tediApprovalExecutionReceipts).values({
		id: "receipt-example",
		organizationId: "org-1",
		approvalRequestId: ID,
		simulationId: null,
		idempotencyKey: "example-once",
		canonicalInputHash: "sha256:input",
		recordHash: "sha256:receipt",
		baselineFenceOutcome: "not_checked",
		outcome: "succeeded",
		observedResult: { result: { token: MARKER }, summary: MARKER },
		observedError: null,
		providerReceiptRefs: [],
		executedAt: "2026-01-01T00:00:01Z",
		createdAt: "2026-01-01T00:00:01Z",
	});
});
function client(sub: string, organizationId = "org-1") {
	return createRouterClient(tediApprovalsContractRouter, {
		context: userContext({
			db,
			organizationId,
			sub,
			permissions: ["tedis:read", "os:approve"],
		}),
	});
}
describe("approval result read boundaries", () => {
	it("keeps get/list/provenance metadata useful without results for another same-org reviewer", async () => {
		const c = client("other-admin");
		const one = await c.getById({ id: ID });
		const list = await c.list({});
		const provenance = await c.getProvenance({ approvalRequestId: ID });
		for (const output of [one, list, provenance])
			expect(JSON.stringify(output)).not.toContain(MARKER);
		expect(one.status).toBe("approved");
		expect(list.data[0]?.id).toBe(ID);
		expect(provenance.executionReceipts.records[0]).toMatchObject({
			recordHash: "sha256:receipt",
			outcome: "succeeded",
			observedResult: { redacted: true },
		});
	});
	it("retains original results for the canonical requester", async () => {
		const c = client("requester");
		expect(JSON.stringify(await c.getById({ id: ID }))).toContain(MARKER);
		expect(JSON.stringify(await c.list({}))).toContain(MARKER);
		expect(
			JSON.stringify(await c.getProvenance({ approvalRequestId: ID })),
		).toContain(MARKER);
	});
	it("does not turn an admin machine scope into requester identity", async () => {
		const c = createRouterClient(tediApprovalsContractRouter, {
			context: apiKeyContext({
				db,
				scopes: ["mcp:memory.read", "mcp:memory.admin"],
			}),
		});
		expect(JSON.stringify(await c.getById({ id: ID }))).not.toContain(MARKER);
		expect(
			JSON.stringify(await c.getProvenance({ approvalRequestId: ID })),
		).not.toContain(MARKER);
	});
	it("preserves the existing cross-org denial", async () => {
		await expect(
			client("requester", "org-2").getById({ id: ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

it("uses the same canonical manifest hash for requester and redacted reviewer views", async () => {
	const own = await client("requester").getReviewManifest({
		approvalRequestIds: [ID],
	});
	const other = await client("other-admin").getReviewManifest({
		approvalRequestIds: [ID],
	});
	expect(JSON.stringify(own.actions)).toContain(MARKER);
	expect(JSON.stringify(other.actions)).not.toContain(MARKER);
	expect(other.manifestHash).toBe(own.manifestHash);
	expect(other.actions[0]?.canonicalInputHash).toBe(
		own.actions[0]?.canonicalInputHash,
	);
});

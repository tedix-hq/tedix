import { DatabaseSync } from "node:sqlite";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { createRouterClient } from "@orpc/server";
import { resolveContractEndpoint } from "@tedix/api-contract/utils/contract-routers";
import { zodToStructuredOutputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import { createDbClient } from "@tedix/db/client";
import { getApprovalRequestById } from "@tedix/db/queries/approvals";
import {
	getKernelRuntimeRun,
	listKernelRuntimeRuns,
	listPendingDelegationRuns,
} from "@tedix/db/queries/kernel-runtime-runs";
import { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { userContext } from "../test-context";
import { normalizeHomeRunRecord } from "./kernel/run-store-normalization";
import { tediApprovalsContractRouter } from "./tedi-approvals";
import { requestOutput } from "./work-interactions";

const ORG = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-11-18T00:00:00.000Z";
const generatedApproval = {
	executionStatus: "executed",
	executionDismissedAt: NOW,
	consumedAt: NOW,
};
const generatedRun = { workItemId: ID, targetTediId: "example-tedi" };
const generatedInteraction = { source: "example" };
let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;

beforeEach(async () => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(tediApprovalRequests, kernelRuntimeRuns, workInteractions),
	);
	db = createDbClient(createD1Facade(sqlite));
	await db.insert(tediApprovalRequests).values({
		id: ID,
		orgId: ORG,
		tediId: "example-tedi",
		actionType: "custom",
		description: "Example approval",
		status: "approved",
		payload: {
			execution: { status: "executed", dismissedAt: NOW },
			consumedAt: NOW,
		},
		createdAt: NOW,
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	await db.insert(kernelRuntimeRuns).values({
		id: ID,
		organizationId: ORG,
		conversationId: "example-conversation",
		status: "requires_approval",
		metadata: {
			workItemId: ID,
			homeDelegation: { workOrder: { targetTediId: "example-tedi" } },
		},
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db.insert(workInteractions).values({
		id: ID,
		orgId: ORG,
		kind: "question",
		subject: "Example question",
		prompt: "Which example should we use?",
		creatorType: "user",
		creatorId: "example-user",
		targetType: "user",
		targetId: "example-user",
		createdAt: NOW,
		metadata: { source: "example" },
	});
});

afterEach(() => sqlite.close());

// Use the same closed JSON projection and validator engine as the MCP gateway.
// Parsing with Zod first would silently strip the properties that caused this bug.
function validateOutput(endpoint: string, output: unknown, leaked: unknown) {
	const schema = zodToStructuredOutputJsonSchema(
		resolveContractEndpoint(endpoint)?.outputSchema,
	);
	expect(schema).not.toBeNull();
	const validate = new CfWorkerJsonSchemaValidator({
		draft: "2020-12",
	}).getValidator(schema!);
	// The gateway receives JSON over the API binding, without optional undefined values.
	expect(validate(JSON.parse(JSON.stringify(output)))).toMatchObject({
		valid: true,
	});
	expect(validate(JSON.parse(JSON.stringify(leaked)))).toMatchObject({
		valid: false,
	});
}

it.each(["getById", "list"])(
	"tediApprovals/%s excludes generated columns",
	async (proc) => {
		expect(
			sqlite
				.prepare(
					"SELECT execution_status, execution_dismissed_at, consumed_at FROM tedi_approval_requests",
				)
				.get(),
		).toEqual({
			execution_status: "executed",
			execution_dismissed_at: NOW,
			consumed_at: NOW,
		});
		const row = await getApprovalRequestById(db, ID, ORG);
		for (const key of Object.keys(generatedApproval))
			expect(row).not.toHaveProperty(key);
		const client = createRouterClient(tediApprovalsContractRouter, {
			context: userContext({
				db,
				organizationId: ORG,
				permissions: ["tedis:read", "os:approve"],
			}),
		});
		if (proc === "getById") {
			const output = await client.getById({ id: ID });
			validateOutput("tediApprovals/getById", output, {
				...output,
				...generatedApproval,
			});
		} else {
			const output = await client.list({});
			expect(output.data).toHaveLength(1);
			validateOutput("tediApprovals/list", output, {
				...output,
				data: [{ ...output.data[0], ...generatedApproval }],
			});
		}
	},
);

it.each(["readRun", "readRunSet", "listPendingHomeDelegations"])(
	"kernelRuntime/%s excludes generated columns",
	async (proc) => {
		expect(
			sqlite
				.prepare("SELECT work_item_id, target_tedi_id FROM kernel_runtime_runs")
				.get(),
		).toEqual({ work_item_id: ID, target_tedi_id: "example-tedi" });
		const rows =
			proc === "readRun"
				? [await getKernelRuntimeRun(db, { id: ID, organizationId: ORG })]
				: proc === "listPendingHomeDelegations"
					? await listPendingDelegationRuns(db, {
							organizationId: ORG,
							limit: 10,
						})
					: await listKernelRuntimeRuns(db, { organizationId: ORG, limit: 10 });
		expect(rows).toHaveLength(1);
		const runs = rows.map((row) => {
			expect(row).toBeDefined();
			for (const key of Object.keys(generatedRun))
				expect(row).not.toHaveProperty(key);
			const run = normalizeHomeRunRecord(row!);
			expect(normalizeHomeRunRecord({ ...row!, ...generatedRun })).toEqual(run);
			return run;
		});
		if (proc === "readRun") {
			validateOutput(
				`kernelRuntime/${proc}`,
				{ run: runs[0] },
				{ run: { ...runs[0], ...generatedRun } },
			);
		} else {
			const runSet = {
				organizationId: ORG,
				conversationId: "example-conversation",
				activeRunIds: [ID],
				runs,
			};
			validateOutput(
				`kernelRuntime/${proc}`,
				{ runSet },
				{ runSet: { ...runSet, runs: [{ ...runs[0], ...generatedRun }] } },
			);
		}
	},
);

it.each(["get", "listInbox", "listOutbox", "listAudit"])(
	"workInteractions/%s excludes generated columns",
	async (proc) => {
		expect(
			sqlite.prepare("SELECT source FROM work_interactions").get(),
		).toEqual(generatedInteraction);
		const row = await getWorkInteraction(db, { orgId: ORG, interactionId: ID });
		expect(row).not.toBeNull();
		expect(row).not.toHaveProperty("source");
		const request = requestOutput(row!);
		expect(requestOutput({ ...row!, ...generatedInteraction })).toEqual(
			request,
		);
		const entry = {
			request,
			effectiveState: "open",
			canRespond: true,
			canCancel: true,
		};
		if (proc === "get") {
			const output = {
				...entry,
				responses: { data: [], nextCursor: null, hasMore: false },
			};
			validateOutput(`workInteractions/${proc}`, output, {
				...output,
				request: { ...request, ...generatedInteraction },
			});
		} else {
			const output = {
				data: [{ ...entry, workItem: null, responseCount: 0 }],
				nextCursor: null,
				hasMore: false,
				observedAt: NOW,
			};
			validateOutput(`workInteractions/${proc}`, output, {
				...output,
				data: [
					{
						...output.data[0],
						request: { ...request, ...generatedInteraction },
					},
				],
			});
		}
	},
);

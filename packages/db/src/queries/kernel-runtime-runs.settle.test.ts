import { admitKernelAutoWrite } from "./approvals";
import { tediApprovalRequests } from "../schema/approvals";
import { tediApprovalExecutionReceipts } from "../schema/approval-simulations";
import { auditEvents } from "../schema/audit-events";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listKernelRuntimeEvents } from "./kernel-runtime-events";
import {
	getKernelRuntimeRun,
	settleKernelRuntimeTurn,
} from "./kernel-runtime-runs";

const SETTLED_AT = "2026-10-09T10:00:05.000Z";

async function setup(status: "running" | "canceled" = "running") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(kernelRuntimeRuns, kernelRuntimeEvents));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(kernelRuntimeRuns).values({
		id: "run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status,
		createdAt: "2026-10-09T10:00:00.000Z",
		updatedAt: "2026-10-09T10:00:00.000Z",
	});
	return db;
}

function turnParams() {
	return {
		run: {
			id: "run-1",
			organizationId: "org-1",
			fromStatus: "running" as const,
			patch: { status: "completed" as const, updatedAt: SETTLED_AT },
		},
		events: [
			{
				id: "evt-message",
				organizationId: "org-1",
				kind: "message.completed" as const,
				conversationId: "home:main",
				runId: "run-1",
				payload: { role: "assistant", content: "Done." },
				createdAt: SETTLED_AT,
			},
			{
				id: "evt-terminal",
				organizationId: "org-1",
				kind: "run.completed" as const,
				conversationId: "home:main",
				runId: "run-1",
				payload: { status: "completed" },
				createdAt: "2026-10-09T10:00:05.001Z",
			},
		],
	};
}

describe("settleKernelRuntimeTurn", () => {
	it("lands the run patch and both transcript events in one batch", async () => {
		const db = await setup();
		const result = await settleKernelRuntimeTurn(db, turnParams());
		expect(result.runTransitioned).toBe(true);
		expect(result.events.map((event) => event.inserted)).toEqual([true, true]);
		expect(result.events.map((event) => event.row.kind)).toEqual([
			"message.completed",
			"run.completed",
		]);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"completed",
		);
		const rows = await listKernelRuntimeEvents(db, {
			runId: "run-1",
			order: "asc",
		});
		expect(rows.map((row) => row.id)).toEqual(["evt-message", "evt-terminal"]);
	});

	it("rolls back a blocked run closure when either terminal event cannot be written", async () => {
		for (const kind of ["message.completed", "run.failed"]) {
			const sqlite = new DatabaseSync(":memory:");
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(schemaDdl(kernelRuntimeRuns, kernelRuntimeEvents));
			sqlite.exec(
				`CREATE TRIGGER reject_event BEFORE INSERT ON kernel_runtime_events WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'event unavailable'); END`,
			);
			const db = createDbClient(createD1Facade(sqlite));
			await db.insert(kernelRuntimeRuns).values({
				id: "run-1",
				organizationId: "org-1",
				conversationId: "home:main",
				status: "requires_approval",
				updatedAt: SETTLED_AT,
			});
			const input = turnParams();
			await expect(
				settleKernelRuntimeTurn(db, {
					run: {
						...input.run,
						fromStatus: "requires_approval",
						expectedUpdatedAt: SETTLED_AT,
						patch: { status: "failed", updatedAt: SETTLED_AT },
					},
					events: input.events.map((event, index) => ({
						...event,
						kind: index === 0 ? "message.completed" : "run.failed",
					})),
				}),
			).rejects.toThrow();
			expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
				"requires_approval",
			);
			expect(await listKernelRuntimeEvents(db, { runId: "run-1" })).toEqual([]);
			sqlite.close();
		}
	});

	it("keeps the transcript when an operator cancel already won the run row", async () => {
		const db = await setup("canceled");
		const result = await settleKernelRuntimeTurn(db, turnParams());
		expect(result.runTransitioned).toBe(false);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"canceled",
		);
		expect((await listKernelRuntimeEvents(db, { runId: "run-1" })).length).toBe(
			2,
		);
	});

	it("resolves a replayed event to its existing row without double-inserting", async () => {
		const db = await setup();
		await settleKernelRuntimeTurn(db, turnParams());
		const replay = await settleKernelRuntimeTurn(db, turnParams());
		expect(replay.runTransitioned).toBe(false);
		expect(replay.events.map((event) => event.inserted)).toEqual([
			false,
			false,
		]);
		expect(replay.events[0]?.row.id).toBe("evt-message");
		expect((await listKernelRuntimeEvents(db, { runId: "run-1" })).length).toBe(
			2,
		);
	});
});

describe("direct policy write durability", () => {
	async function setupAuto() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(
			schemaDdl(
				kernelRuntimeRuns,
				kernelRuntimeEvents,
				tediApprovalRequests,
				auditEvents,
				tediApprovalExecutionReceipts,
			),
		);
		const db = createDbClient(createD1Facade(sqlite));
		await db.insert(kernelRuntimeRuns).values({
			id: "run-1",
			organizationId: "org-1",
			conversationId: "home:main",
			status: "running",
			createdAt: SETTLED_AT,
			updatedAt: SETTLED_AT,
		});
		const approval = {
			id: "approval-1",
			tediId: "tedi-1",
			orgId: "org-1",
			actionType: "home.tool_write",
			description: "Create a document",
			payload: {},
			createdAt: SETTLED_AT,
			expiresAt: "2026-10-10T10:00:05.000Z",
		};
		const audit = {
			organizationId: "org-1",
			actorId: "policy",
			actorType: "service" as const,
			resourceType: "approval_request",
			resourceId: approval.id,
		};
		const admission = {
			approval,
			requestedAudit: { ...audit, action: "approval.requested" },
			approvedAudit: { ...audit, action: "approval.approved" },
			runId: "run-1",
			metadata: { kernelWriteExecutedAt: SETTLED_AT },
			resolvedAt: SETTLED_AT,
			resolution: "Policy trusted",
		};
		const receipt = {
			id: "receipt-1",
			organizationId: "org-1",
			approvalRequestId: "approval-1",
			idempotencyKey: "home-tool-write:approval-1",
			recordHash: "sha256:receipt",
			canonicalInputHash: "sha256:input",
			baselineFenceOutcome: "not_checked" as const,
			outcome: "succeeded" as const,
			observedResult: { outputId: "output-1" },
			providerReceiptRefs: [],
			executedAt: SETTLED_AT,
			createdAt: SETTLED_AT,
		};
		return { sqlite, db, admission, receipt };
	}
	it("admits once without parking, then atomically records the run, transcript and execution receipt", async () => {
		const { db, admission, receipt } = await setupAuto();
		expect(await admitKernelAutoWrite(db, admission)).toBe(true);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"running",
		);
		expect(await db.select().from(auditEvents)).toHaveLength(2);
		expect((await db.select().from(tediApprovalRequests))[0]).toMatchObject({
			status: "approved",
			resolvedBy: "policy",
		});
		await expect(admitKernelAutoWrite(db, admission)).rejects.toThrow();
		expect(await db.select().from(auditEvents)).toHaveLength(2);
		await settleKernelRuntimeTurn(db, {
			...turnParams(),
			approvalReceipt: receipt,
		});
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"completed",
		);
		expect(await db.select().from(tediApprovalExecutionReceipts)).toHaveLength(
			1,
		);
	});
	it("an audit failure rolls back approval and execution marker", async () => {
		const { sqlite, db, admission } = await setupAuto();
		sqlite.exec(
			"CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'approval.approved' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
		);
		await expect(admitKernelAutoWrite(db, admission)).rejects.toThrow();
		expect(await db.select().from(tediApprovalRequests)).toHaveLength(0);
		expect(await db.select().from(auditEvents)).toHaveLength(0);
		expect(
			(await getKernelRuntimeRun(db, { id: "run-1" }))?.metadata ?? {},
		).not.toHaveProperty("kernelWriteExecutedAt");
	});
	it.each(["canceled", "completed"] as const)(
		"does not admit a %s run",
		async (status) => {
			const { db, admission } = await setupAuto();
			await db.update(kernelRuntimeRuns).set({ status });
			expect(await admitKernelAutoWrite(db, admission)).toBe(false);
			expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
				status,
			);
		},
	);
	it("cannot admit a run owned by another organization", async () => {
		const { db, admission } = await setupAuto();
		expect(
			await admitKernelAutoWrite(db, {
				...admission,
				approval: { ...admission.approval, orgId: "org-2" },
			}),
		).toBe(false);
		expect(
			(await getKernelRuntimeRun(db, { id: "run-1" }))?.metadata ?? {},
		).not.toHaveProperty("kernelWriteExecutedAt");
	});
	it("never admits an expired approval", async () => {
		const { db, admission } = await setupAuto();
		await expect(
			admitKernelAutoWrite(db, {
				...admission,
				resolvedAt: admission.approval.expiresAt,
			}),
		).rejects.toThrow("expired");
		expect(await db.select().from(tediApprovalRequests)).toHaveLength(0);
	});
	it("a receipt for another organization's approval rolls back settlement", async () => {
		const { db, admission, receipt } = await setupAuto();
		await admitKernelAutoWrite(db, admission);
		await expect(
			settleKernelRuntimeTurn(db, {
				...turnParams(),
				approvalReceipt: { ...receipt, organizationId: "org-2" },
			}),
		).rejects.toThrow();
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"running",
		);
		expect(await listKernelRuntimeEvents(db, { runId: "run-1" })).toHaveLength(
			0,
		);
	});
	it("a receipt failure rolls back the terminal run and both transcript rows", async () => {
		const { sqlite, db, admission, receipt } = await setupAuto();
		await admitKernelAutoWrite(db, admission);
		sqlite.exec(
			"CREATE TRIGGER fail_receipt BEFORE INSERT ON tedi_approval_execution_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END",
		);
		await expect(
			settleKernelRuntimeTurn(db, {
				...turnParams(),
				approvalReceipt: receipt,
			}),
		).rejects.toThrow();
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"running",
		);
		expect(await listKernelRuntimeEvents(db, { runId: "run-1" })).toHaveLength(
			0,
		);
	});
});

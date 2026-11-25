import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { createDbQueryClient } from "../../query-client";
import { batchNonEmpty } from "../../utils/batch";
import { osGadgetExecutions } from "../../schema/os-workspaces";
import { osWorkspaceEvents } from "../../schema/os-collaborators";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { pgTableDdl } from "../../test/pg-schema-ddl";
import {
	osGadgetExecutions as pgOsGadgetExecutions,
	osWorkspaceEvents as pgOsWorkspaceEvents,
} from "../../schema-pg/core";
import {
	claimApprovedOsGadgetExecution,
	createOsGadgetExecution,
	cutOverOsGadgetExecutionOutput,
	failClaimedOsGadgetExecution,
	getOsGadgetExecution,
	getOsGadgetExecutionByRunId,
	listOsGadgetExecutions,
	listOsGadgetExecutionBodiesToOffload,
	offloadOsGadgetExecutionBody,
	recordOsGadgetDispatch,
	settleAwaitingApprovalOsGadgetExecution,
	settleOsGadgetExecutionFromRun,
	settleOsAppCallExecution,
} from "./executions";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

async function fixture(store: "d1" | "postgres") {
	if (store === "postgres") {
		const { db, engine, close } = await createPGliteFacade();
		closers.push(close);
		await engine.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY);
			INSERT INTO organizations VALUES ('org-1'),('org-2');
			CREATE TABLE os_workspaces(id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, status TEXT NOT NULL, visibility TEXT NOT NULL)`);
		for (const table of [pgOsGadgetExecutions, pgOsWorkspaceEvents])
			for (const ddl of pgTableDdl(table)) await engine.exec(ddl);
		return {
			db,
			exec: async (statement: string) => {
				await engine.exec(statement);
			},
		};
	}
	const sqlite = new DatabaseSync(":memory:");
	closers.push(() => sqlite.close());
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		CREATE TABLE os_gadget_executions (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			workspace_id TEXT NOT NULL,
			gadget_id TEXT NOT NULL,
			revision_id TEXT,
			revision INTEGER,
			status TEXT NOT NULL,
			granted_capabilities TEXT NOT NULL,
			policy_decision TEXT NOT NULL,
			input TEXT,
			output TEXT,
			workspace_output_sha256 TEXT,
			body_r2_key TEXT, body_bytes INTEGER, trace_metadata TEXT,
			error TEXT,
			costs TEXT,
			evidence_refs TEXT,
			run_id TEXT,
			workflow_instance_id TEXT,
			tedi_id TEXT,
			work_item_id TEXT,
			trace_bundle_id TEXT,
			billing_reservation_id TEXT,
			approval_request_id TEXT,
			runtime_environment TEXT,
			agent_session_id TEXT,
			resource_access_envelope TEXT,
			execution_epoch INTEGER NOT NULL DEFAULT 0,
			created_by_kind TEXT NOT NULL,
			created_by_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			completed_at TEXT
		);
		CREATE TABLE os_workspaces (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			status TEXT NOT NULL,
			visibility TEXT NOT NULL
		);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	sqlite.exec(
		"CREATE TABLE os_workspace_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
	);
	return {
		exec: async (statement: string) => {
			sqlite.exec(statement);
		},
		db: createDbQueryClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
	};
}

function executionParams(
	id: string,
	overrides: Partial<Parameters<typeof createOsGadgetExecution>[1]> = {},
) {
	return {
		id,
		organizationId: "org-1",
		workspaceId: "ws-1",
		gadgetId: "gd-1",
		revisionId: "rev-1",
		revision: 1,
		status: "running" as const,
		grantedCapabilities: '["email:read"]',
		policyDecision: '{"allowed":true,"reasons":[]}',
		input: '{"query":"inbox"}',
		createdByKind: "external_agent" as const,
		createdById: "agent-1",
		createdAt: "2026-08-13T16:00:00.000Z",
		...overrides,
	};
}

for (const store of ["d1", "postgres"] as const) {
	describe(`os gadget executions: ${store}`, () => {
		it("filters traces by call before limiting and keeps tenant and gadget scope", async () => {
			const { db } = await fixture(store);
			for (const [id, overrides] of [
				["trace", {}],
				["foreign", { organizationId: "org-2" }],
				["sibling", { gadgetId: "gd-2" }],
				["other-call", { output: '{"callId":"other"}' }],
				["app-result", { createdById: "agent-1" }],
			] as const) {
				await createOsGadgetExecution(
					db,
					executionParams(id, {
						output: '{"callId":"call-1","events":[]}',
						createdByKind: "service",
						createdById: "workspace-app-host",
						...overrides,
					}),
				);
			}
			const rows = await listOsGadgetExecutions(
				db,
				{ organizationId: "org-1", gadgetId: "gd-1" },
				{ callId: "call-1", limit: 1 },
			);
			expect(rows.map((row) => row.id)).toEqual(["trace"]);
			expect(
				(
					await listOsGadgetExecutions(
						db,
						{ organizationId: "org-1", gadgetId: "gd-1" },
						{ includeTraces: false },
					)
				).map((row) => row.id),
			).toEqual(["app-result"]);
			await createOsGadgetExecution(
				db,
				executionParams("earlier", {
					createdById: "workspace-app-host",
					output: '{"callId":"call-2","events":[{"sequence":1}]}',
				}),
			);
			await createOsGadgetExecution(
				db,
				executionParams("later", {
					createdById: "workspace-app-host",
					output: '{"callId":"call-2","events":[{"sequence":2}]}',
				}),
			);
			for (const [id, events] of [
				["live", [{ live: true, sequence: 999 }]],
				["missing-sequence", []],
			] as const)
				await createOsGadgetExecution(
					db,
					executionParams(id, {
						createdById: "workspace-app-host",
						createdAt: "2026-08-13T16:02:00.000Z",
						output: JSON.stringify({ callId: "call-2", events }),
					}),
				);
			expect(
				(
					await listOsGadgetExecutions(
						db,
						{ organizationId: "org-1", gadgetId: "gd-1" },
						{ callId: "call-2", limit: 1 },
					)
				).map((row) => row.id),
			).toEqual(["later"]);
		});
		it("settles direct app calls once without crossing tenants or skill runs", async () => {
			const { db } = await fixture(store);
			await createOsGadgetExecution(db, executionParams("app"));
			await createOsGadgetExecution(
				db,
				executionParams("skill", { runId: "run-1" }),
			);
			expect(
				await settleOsAppCallExecution(db, {
					organizationId: "org-2",
					executionId: "app",
					status: "completed",
				}),
			).toBeUndefined();
			expect(
				await settleOsAppCallExecution(db, {
					organizationId: "org-1",
					executionId: "skill",
					status: "completed",
				}),
			).toBeUndefined();
			expect(
				await settleOsAppCallExecution(db, {
					organizationId: "org-1",
					executionId: "app",
					status: "completed",
					output: '{"saved":true}',
				}),
			).toMatchObject({
				status: "completed",
				output: '{"saved":true}',
				completedAt: expect.any(String),
			});
			expect(
				await settleOsAppCallExecution(db, {
					organizationId: "org-1",
					executionId: "app",
					status: "failed",
					error: "late",
				}),
			).toBeUndefined();
		});

		it("resolves immutable derived-access context by tenant-scoped run id", async () => {
			const { db } = await fixture(store);
			const envelope = JSON.stringify({ version: 1, sources: [] });
			await createOsGadgetExecution(
				db,
				executionParams("ex-access", {
					runId: "run-access",
					resourceAccessEnvelope: envelope,
				}),
			);
			expect(
				await getOsGadgetExecutionByRunId(db, {
					organizationId: "org-1",
					runId: "run-access",
				}),
			).toMatchObject({ id: "ex-access", resourceAccessEnvelope: envelope });
			expect(
				await getOsGadgetExecutionByRunId(db, {
					organizationId: "org-2",
					runId: "run-access",
				}),
			).toBeUndefined();
			await createOsGadgetExecution(
				db,
				executionParams("ex-access-duplicate", {
					runId: "run-access",
					resourceAccessEnvelope: envelope,
				}),
			);
			expect(
				await getOsGadgetExecutionByRunId(db, {
					organizationId: "org-1",
					tediId: "tedi-1",
					runId: "run-access",
				}),
			).toBeUndefined();
		});
		it("records receipts and lists them per gadget, newest first, org-scoped", async () => {
			const { db } = await fixture(store);
			await createOsGadgetExecution(db, executionParams("ex-1"));
			await createOsGadgetExecution(
				db,
				executionParams("ex-2", {
					status: "denied",
					policyDecision: '{"allowed":false,"reasons":["gadget archived"]}',
					createdAt: "2026-08-13T16:01:00.000Z",
				}),
			);
			const rows = await listOsGadgetExecutions(db, {
				organizationId: "org-1",
				gadgetId: "gd-1",
			});
			expect(rows.map((row) => row.id)).toEqual(["ex-2", "ex-1"]);
			expect(
				await listOsGadgetExecutions(
					db,
					{ organizationId: "org-1", gadgetId: "gd-1" },
					{ status: "denied" },
				),
			).toHaveLength(1);
			expect(
				await listOsGadgetExecutions(db, {
					organizationId: "org-2",
					gadgetId: "gd-1",
				}),
			).toHaveLength(0);
			expect(
				await getOsGadgetExecution(db, {
					organizationId: "org-2",
					executionId: "ex-1",
				}),
			).toBeUndefined();
		});

		it("records governed dispatch lineage on create", async () => {
			const { db } = await fixture(store);
			const created = await createOsGadgetExecution(
				db,
				executionParams("ex-run", {
					status: "queued",
					runId: "run-1",
					workflowInstanceId: "wf-1",
					tediId: "tedi-1",
					workItemId: "wi-1",
					billingReservationId: "resv-1",
					runtimeEnvironment: "test",
					agentSessionId: "claude:session-1",
					executionEpoch: 0,
				}),
			);
			expect(created).toMatchObject({
				runId: "run-1",
				workflowInstanceId: "wf-1",
				tediId: "tedi-1",
				workItemId: "wi-1",
				billingReservationId: "resv-1",
				executionEpoch: 0,
			});
		});

		it("claims a parked receipt before dispatch and records runtime lineage exactly once", async () => {
			const { db } = await fixture(store);
			await createOsGadgetExecution(
				db,
				executionParams("ex-parked", {
					status: "awaiting_approval",
					tediId: "tedi-1",
					approvalRequestId: "appr-1",
				}),
			);
			const claimed = await claimApprovedOsGadgetExecution(db, {
				organizationId: "org-1",
				executionId: "ex-parked",
				runId: "ex-parked",
				billingReservationId: "resv-9",
				policyDecision: '{"allowed":true,"reasons":[]}',
				resourceAccessEnvelope: '{"version":1,"sources":[]}',
			});
			expect(claimed).toMatchObject({
				status: "queued",
				runId: "ex-parked",
				workflowInstanceId: null,
				billingReservationId: "resv-9",
				approvalRequestId: "appr-1",
			});
			// The awaiting_approval CAS admits exactly one claim.
			expect(
				await claimApprovedOsGadgetExecution(db, {
					organizationId: "org-1",
					executionId: "ex-parked",
					runId: "ex-parked",
					billingReservationId: null,
					policyDecision: '{"allowed":true,"reasons":[]}',
					resourceAccessEnvelope: '{"version":1,"sources":[]}',
				}),
			).toBeUndefined();

			const recorded = await recordOsGadgetDispatch(db, {
				organizationId: "org-1",
				executionId: "ex-parked",
				runId: "ex-parked",
				status: "running",
				workflowInstanceId: "wf-9",
				executionEpoch: 1,
			});
			expect(recorded).toMatchObject({
				status: "running",
				workflowInstanceId: "wf-9",
				executionEpoch: 1,
			});
			expect(
				await recordOsGadgetDispatch(db, {
					organizationId: "org-1",
					executionId: "ex-parked",
					runId: "ex-parked",
					status: "failed",
					workflowInstanceId: "wf-late",
					executionEpoch: 0,
				}),
			).toBeUndefined();
		});

		it("terminalizes rejected approvals and failed claims immutably", async () => {
			const { db } = await fixture(store);
			await createOsGadgetExecution(
				db,
				executionParams("ex-rejected", {
					status: "awaiting_approval",
					approvalRequestId: "appr-rejected",
				}),
			);
			const rejected = await settleAwaitingApprovalOsGadgetExecution(db, {
				organizationId: "org-1",
				executionId: "ex-rejected",
				status: "denied",
				error: "approval_rejected",
				policyDecision: '{"allowed":false,"reasons":["approval_rejected"]}',
			});
			expect(rejected).toMatchObject({
				status: "denied",
				error: "approval_rejected",
				completedAt: expect.any(String),
			});
			expect(
				await settleAwaitingApprovalOsGadgetExecution(db, {
					organizationId: "org-1",
					executionId: "ex-rejected",
					status: "canceled",
					error: "late expiry",
					policyDecision: '{"allowed":false,"reasons":["late expiry"]}',
				}),
			).toBeUndefined();

			await createOsGadgetExecution(
				db,
				executionParams("ex-failed", {
					status: "awaiting_approval",
					approvalRequestId: "appr-failed",
				}),
			);
			await claimApprovedOsGadgetExecution(db, {
				organizationId: "org-1",
				executionId: "ex-failed",
				runId: "ex-failed",
				billingReservationId: "resv-failed",
				policyDecision: '{"allowed":true,"reasons":[]}',
				resourceAccessEnvelope: '{"version":1,"sources":[]}',
			});
			const failed = await failClaimedOsGadgetExecution(db, {
				organizationId: "org-1",
				executionId: "ex-failed",
				runId: "ex-failed",
				error: "runtime unavailable",
			});
			expect(failed).toMatchObject({
				status: "failed",
				error: "runtime unavailable",
				completedAt: expect.any(String),
			});
			expect(
				await failClaimedOsGadgetExecution(db, {
					organizationId: "org-1",
					executionId: "ex-failed",
					runId: "ex-failed",
					error: "duplicate",
				}),
			).toBeUndefined();
		});

		it("settles run-linked receipts from run evidence, once, with lifecycle sync", async () => {
			const { db } = await fixture(store);
			await createOsGadgetExecution(
				db,
				executionParams("ex-run", {
					status: "queued",
					runId: "run-1",
					tediId: "tedi-1",
				}),
			);
			// Lifecycle sync does not settle.
			const synced = await settleOsGadgetExecutionFromRun(db, {
				runId: "run-1",
				status: "running",
			});
			expect(synced).toHaveLength(1);
			expect(synced[0]).toMatchObject({ status: "running", completedAt: null });

			const settled = await settleOsGadgetExecutionFromRun(db, {
				runId: "run-1",
				status: "completed",
				output: '{"result":7}',
				costs: '{"usd":0.02}',
				evidenceRefs: '["skill://runs/run-1"]',
				traceBundleId: "trace-1",
				executionEpoch: 1,
			});
			expect(settled).toHaveLength(1);
			expect(settled[0]).toMatchObject({
				status: "completed",
				output: '{"result":7}',
				costs: '{"usd":0.02}',
				evidenceRefs: '["skill://runs/run-1"]',
				traceBundleId: "trace-1",
				executionEpoch: 1,
				completedAt: expect.any(String),
			});
			// Terminal receipts are immutable audit evidence.
			expect(
				await settleOsGadgetExecutionFromRun(db, {
					runId: "run-1",
					status: "failed",
					error: "late duplicate",
				}),
			).toHaveLength(0);
			// A run id that pins no receipt settles nothing.
			expect(
				await settleOsGadgetExecutionFromRun(db, {
					runId: "run-unknown",
					status: "completed",
				}),
			).toHaveLength(0);
		});

		it("settles a large receipt set with one deduplicated hint write", async () => {
			const { db } = await fixture(store);
			await db.batch(
				batchNonEmpty(
					Array.from({ length: 150 }, (_, index) =>
						db.insert(coreTable(db, osGadgetExecutions)).values(
							executionParams(`bulk-${index}`, {
								runId: "bulk-run",
								workspaceId: `workspace-${index % 120}`,
							}),
						),
					),
				),
			);
			const insert = vi.spyOn(db, "insert");
			const settled = await settleOsGadgetExecutionFromRun(db, {
				runId: "bulk-run",
				status: "completed",
			});
			expect(settled).toHaveLength(150);
			expect(insert).toHaveBeenCalledTimes(1);
			insert.mockRestore();
			const hints = await db.select().from(coreTable(db, osWorkspaceEvents));
			expect(hints).toHaveLength(120);
			expect(new Set(hints.map((row) => row.workspaceId)).size).toBe(120);
		});
	});

	it(`publishes before clearing and refuses stale versions: ${store}`, async () => {
		const { db } = await fixture(store);
		const payload = '{"before":true}';
		const completedAt = "2026-08-13T16:01:00.000Z";
		const row = await createOsGadgetExecution(
			db,
			executionParams("settled", {
				status: "completed",
				output: payload,
				completedAt,
			}),
		);
		const scope = { organizationId: row.organizationId, executionId: row.id };
		const archived = { ...row, output: payload, completedAt };
		const digest = "a".repeat(64);
		expect(
			await cutOverOsGadgetExecutionOutput(db, archived, digest, "clear"),
		).toBe(false);
		expect(
			await cutOverOsGadgetExecutionOutput(db, archived, digest, "publish"),
		).toBe(true);
		expect(await getOsGadgetExecution(db, scope)).toMatchObject({
			output: payload,
			workspaceOutputSha256: digest,
		});
		expect(
			await cutOverOsGadgetExecutionOutput(
				db,
				{ ...archived, output: '{"stale":true}' },
				digest,
				"clear",
			),
		).toBe(false);
		expect(
			await cutOverOsGadgetExecutionOutput(
				db,
				archived,
				"b".repeat(64),
				"clear",
			),
		).toBe(false);
		expect(
			await cutOverOsGadgetExecutionOutput(db, archived, digest, "clear"),
		).toBe(true);
		expect(await getOsGadgetExecution(db, scope)).toMatchObject({
			output: null,
			workspaceOutputSha256: digest,
		});
	});

	it(`archives detached output only while the workspace remains detached: ${store}`, async () => {
		const { exec, db } = await fixture(store);
		await exec(
			"INSERT INTO os_workspaces VALUES ('ws-1', 'org-1', 'archived', 'private')",
		);
		const output = '{"private":true}';
		const completedAt = "2026-08-13T16:01:00.000Z";
		const row = await createOsGadgetExecution(
			db,
			executionParams("detached", {
				status: "completed",
				output,
				completedAt,
				runtimeEnvironment: "production",
			}),
		);
		const digest = "a".repeat(64);
		const snapshot = { ...row, output, completedAt };
		await exec("UPDATE os_workspaces SET status = 'active' WHERE id = 'ws-1'");
		expect(
			await cutOverOsGadgetExecutionOutput(
				db,
				snapshot,
				digest,
				"archiveDetached",
			),
		).toBe(false);
		const scope = { organizationId: row.organizationId, executionId: row.id };
		expect(await getOsGadgetExecution(db, scope)).toMatchObject({
			output,
			workspaceOutputSha256: null,
		});
		await exec("DELETE FROM os_workspaces WHERE id = 'ws-1'");
		expect(
			await cutOverOsGadgetExecutionOutput(
				db,
				{ ...snapshot, output: '{"stale":true}' },
				digest,
				"archiveDetached",
			),
		).toBe(false);
		expect(
			await cutOverOsGadgetExecutionOutput(
				db,
				snapshot,
				digest,
				"archiveDetached",
			),
		).toBe(true);
		expect(await getOsGadgetExecution(db, scope)).toMatchObject({
			output: null,
			workspaceOutputSha256: digest,
		});
	});

	it(`offloads unchanged old terminal bodies and preserves trace order: ${store}`, async () => {
		const { db, exec } = await fixture(store);
		const first = await createOsGadgetExecution(
			db,
			executionParams("trace-old", {
				status: "completed",
				completedAt: "2026-08-14",
				createdById: "workspace-app-host",
				output: JSON.stringify({
					callId: "call-1",
					events: [{ live: false, sequence: 2, payload: "large body" }],
				}),
			}),
		);
		const racing = await createOsGadgetExecution(
			db,
			executionParams("changed", {
				status: "completed",
				completedAt: "2026-08-14",
				output: '"before"',
			}),
		);
		await createOsGadgetExecution(db, executionParams("active"));
		await createOsGadgetExecution(
			db,
			executionParams("recent", {
				status: "completed",
				completedAt: "2026-11-23",
			}),
		);
		await createOsGadgetExecution(
			db,
			executionParams("denied-no-completion", { status: "denied" }),
		);
		expect(
			(await listOsGadgetExecutionBodiesToOffload(db, "2026-11-17"))
				.map((row) => row.id)
				.sort(),
		).toEqual(["changed", "denied-no-completion", "trace-old"]);
		await exec(
			`UPDATE os_gadget_executions SET output = '"after"' WHERE id = 'changed'`,
		);
		expect(
			await offloadOsGadgetExecutionBody(db, racing, "key", 10, "2026-11-17"),
		).toBe(false);
		expect(
			await offloadOsGadgetExecutionBody(
				db,
				first,
				"verified-key",
				100,
				"2026-11-17",
			),
		).toBe(true);
		expect(
			await getOsGadgetExecution(db, {
				organizationId: "org-1",
				executionId: first.id,
			}),
		).toMatchObject({
			input: null,
			output: null,
			bodyR2Key: "verified-key",
			bodyBytes: 100,
		});
		const traces = await listOsGadgetExecutions(
			db,
			{ organizationId: "org-1", gadgetId: "gd-1" },
			{ callId: "call-1", limit: 1 },
		);
		expect(traces.map((row) => row.id)).toEqual(["trace-old"]);
		expect(traces[0]!.traceMetadata).not.toContain("large body");
		expect(
			await offloadOsGadgetExecutionBody(
				db,
				first,
				"other-key",
				100,
				"2026-11-17",
			),
		).toBe(false);
	});
}

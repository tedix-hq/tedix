import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "../client";
import { createDbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { apps } from "../schema/apps";
import { appTools, type ToolReviewPendingDefinition } from "../schema/tools";
import { auditEvents } from "../schema/audit-events";
import { decisionEdges } from "../schema/decision-graph";
import {
	tediApprovalRequests,
	type NewTediApprovalRequest,
} from "../schema/approvals";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	type CreateApprovalRequestParams,
	getApprovalRequestsByIds,
	getApprovalRequestById,
	createApprovalRequest,
	createApprovalRequestWithAudit,
	resolveApprovalRequest,
	listApprovalRequests,
	findPendingOwnerToolApproval,
	claimOwnerToolApprovalExecution,
	queueOwnerToolApprovalExecution,
	consumeOwnerToolApproval,
	recordOwnerToolApprovalExecution,
	reclaimOwnerToolApprovalExecution,
	continueOwnerToolApprovalExecution,
	dismissOwnerToolApprovalExecution,
	consumeHomeToolApprovalCall,
	failConsumedStaleOwnerToolRuns,
	requeueStaleContinuableOwnerToolApprovals,
	createProvisionalOutcome,
	getProvisionalOutcomeById,
	listProvisionalOutcomes,
	promoteProvisionalOutcome,
	rollbackProvisionalOutcome,
	ensureProvisionalPromotionApprovalRequest,
	ensurePaymentBudgetOverrideRequest,
	expireStaleApprovals,
	reconcileToolReviewApproval,
	resolveToolCatalogApprovalRequest,
	listDueOwnerToolApprovals,
} from "./approvals";

const now = "2026-11-27T12:00:00.000Z";
const old = "2026-11-27T10:00:00.000Z";
const future = "2099-11-28T12:00:00.000Z";

for (const store of ["d1", "postgres"] as const) {
	describe(`approval queries ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		const request = (
			id: string,
			overrides: Partial<
				NewTediApprovalRequest & CreateApprovalRequestParams
			> = {},
		): NewTediApprovalRequest & CreateApprovalRequestParams => ({
			id,
			orgId: "org",
			tediId: "tedi",
			actionType: "custom",
			description: id,
			createdAt: old,
			expiresAt: future,
			payload: { nested: { count: 2 }, enabled: false },
			...overrides,
		});
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
				sqlite.exec(
					"CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events WHEN NEW.resource_id='audit-rollback' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;",
				);
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				await fixture.engine.exec(
					"CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='audit-rollback' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit();",
				);
			}
			for (const orgId of ["org", "other"]) {
				await db
					.insert(coreTable(db, organizations))
					.values({ id: orgId, name: orgId, slug: orgId });
				await db.insert(coreTable(db, tedis)).values({
					id: orgId === "org" ? "tedi" : "other-tedi",
					organizationId: orgId,
					name: orgId,
					slug: orgId,
					scope: "organization",
				});
			}
			for (let index = 0; index < 121; index++)
				await db
					.insert(coreTable(db, tediApprovalRequests))
					.values(request(`id-${index}`));
			await db
				.insert(coreTable(db, tediApprovalRequests))
				.values(request("foreign", { orgId: "other", tediId: "other-tedi" }));
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("looks up a bounded ID set without leaking tenants or internal columns and decodes JSON", async () => {
			const ids = Array.from({ length: 121 }, (_, index) => `id-${index}`);
			const rows = await getApprovalRequestsByIds(db, {
				orgId: "org",
				ids: [...ids, ids[0]!, "foreign", "missing"],
			});
			expect(rows.map((row) => row.id).sort()).toEqual(ids.sort());
			expect(rows[0]!.payload).toEqual({
				nested: { count: 2 },
				enabled: false,
			});
			for (const key of [
				"sequence",
				"workItemId",
				"executionStatus",
				"executionDismissedAt",
				"consumedAt",
				"delegatedOwnerId",
			])
				expect(rows[0]).not.toHaveProperty(key);
			expect(
				await getApprovalRequestsByIds(db, { orgId: "org", ids: [] }),
			).toEqual([]);
		});

		it("selects due queued and stale running calls from payload, excludes spent/dismissed calls, and preserves null-first ordering", async () => {
			const queued = { status: "queued", startedAt: old, nextAttemptAt: old };
			const call = {
				kind: "mcp_tool_call",
				fingerprint: "call",
				execution: queued,
			};
			const cases = [
				request("due", {
					status: "approved",
					actionType: "mcp.tool_call",
					payload: call,
				}),
				request("stale", {
					status: "approved",
					actionType: "mcp.tool_call",
					payload: {
						...call,
						execution: { status: "running", startedAt: old },
					},
				}),
				request("recent", {
					status: "approved",
					actionType: "mcp.tool_call",
					payload: {
						...call,
						execution: { status: "running", startedAt: now },
					},
				}),
				request("later", {
					status: "approved",
					actionType: "mcp.tool_call",
					payload: { ...call, execution: { ...queued, nextAttemptAt: future } },
				}),
				request("consumed", {
					status: "approved",
					actionType: "mcp.tool_call",
					payload: { ...call, consumedAt: old },
				}),
				request("dismissed", {
					status: "approved",
					actionType: "mcp.tool_call",
					payload: { ...call, execution: { ...queued, dismissedAt: old } },
				}),
				request("pending", { actionType: "mcp.tool_call", payload: call }),
				request("wrong-action", { status: "approved", payload: call }),
				request("wrong-kind", {
					status: "approved",
					actionType: "mcp.tool_call",
					payload: { ...call, kind: "other" },
				}),
			];
			for (const row of cases)
				await db.insert(coreTable(db, tediApprovalRequests)).values(row);
			const rows = await listDueOwnerToolApprovals(db, now);
			expect(rows.map((row) => row.id)).toEqual(["stale", "due"]);
			expect(rows[0]!.payload.execution).toEqual({
				status: "running",
				startedAt: old,
			});
			expect(rows[0]).not.toHaveProperty("sequence");
			expect(
				(await listDueOwnerToolApprovals(db, now, 1)).map((row) => row.id),
			).toEqual(["stale"]);
		});
		it("resolves once with atomic decision edges, preserves edits and rolls back an audit failure", async () => {
			await createApprovalRequest(db, request("resolve"));
			const batch = vi.spyOn(db, "batch");
			expect(
				await resolveApprovalRequest(db, "resolve", {
					status: "approved",
					resolvedBy: "person",
					payload: { edited: true },
				}),
			).toMatchObject({ status: "approved", payload: { edited: true } });
			expect(batch).toHaveBeenCalledTimes(1);
			batch.mockRestore();
			expect(
				await resolveApprovalRequest(db, "resolve", {
					status: "rejected",
					resolvedBy: "other",
				}),
			).toBeUndefined();
			const edges = coreTable(db, decisionEdges);
			expect(
				await db.select().from(edges).where(eq(edges.toId, "resolve")),
			).toHaveLength(2);
			await expect(
				createApprovalRequestWithAudit(db, request("audit-rollback"), {
					organizationId: "org",
					actorId: "person",
					actorType: "user",
					action: "approval.requested",
					resourceType: "approval_request",
					resourceId: "audit-rollback",
				}),
			).rejects.toThrow();
			expect(
				await getApprovalRequestById(db, "audit-rollback"),
			).toBeUndefined();
		});

		it("keeps delegated decisions, audit receipts and decision edges atomic", async () => {
			await createApprovalRequestWithAudit(db, request("delegated"), {
				organizationId: "org",
				actorId: "person",
				actorType: "user",
				action: "approval.requested",
				resourceType: "approval_request",
				resourceId: "delegated",
			});
			const params = {
				status: "approved" as const,
				resolvedBy: "agent",
				delegatedApproval: {
					ownerId: "person",
					actorType: "external_agent" as const,
					actorId: "agent",
					actorName: "Agent",
					reason: "Review completed",
				},
			};
			expect(
				await resolveApprovalRequest(db, "delegated", params),
			).toMatchObject({
				payload: { delegatedApproval: params.delegatedApproval },
			});
			expect(
				await resolveApprovalRequest(db, "delegated", params),
			).toBeUndefined();
			const audit = coreTable(db, auditEvents);
			const rows = await db
				.select()
				.from(audit)
				.where(
					and(
						eq(audit.resourceId, "delegated"),
						eq(audit.action, "approval_request.delegated_decision"),
					),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.metadata).toMatchObject({
				receipt: params.delegatedApproval,
			});
			expect(rows[0]!.timestamp).toBeInstanceOf(Date);
			await createApprovalRequest(db, request("audit-rollback"));
			await expect(
				resolveApprovalRequest(db, "audit-rollback", params),
			).rejects.toThrow();
			expect(await getApprovalRequestById(db, "audit-rollback")).toMatchObject({
				status: "pending",
			});
			const edges = coreTable(db, decisionEdges);
			expect(
				await db
					.select()
					.from(edges)
					.where(
						and(
							eq(edges.toId, "audit-rollback"),
							eq(edges.source, "approval_resolution"),
						),
					),
			).toEqual([]);
		});

		it("fences tool claims, retries, continuations and stale receipts to their owning run", async () => {
			await createApprovalRequest(
				db,
				request("run", {
					actionType: "mcp.tool_call",
					payload: { kind: "mcp_tool_call", fingerprint: "run" },
				}),
			);
			expect(
				await findPendingOwnerToolApproval(db, {
					organizationId: "org",
					fingerprint: "run",
					now,
				}),
			).toEqual({ id: "run" });
			await resolveApprovalRequest(db, "run", {
				status: "approved",
				resolvedBy: "person",
			});
			const input = { id: "run", organizationId: "org", now };
			expect(
				await claimOwnerToolApprovalExecution(db, {
					...input,
					organizationId: "other",
				}),
			).toBe(false);
			expect(await claimOwnerToolApprovalExecution(db, input)).toBe(true);
			expect(await claimOwnerToolApprovalExecution(db, input)).toBe(false);
			expect(
				await consumeOwnerToolApproval(db, { ...input, fingerprint: "wrong" }),
			).toBe(false);
			expect(
				await consumeOwnerToolApproval(db, { ...input, fingerprint: "run" }),
			).toBe(true);
			expect(
				await recordOwnerToolApprovalExecution(db, {
					...input,
					execution: { status: "failed", startedAt: now, retryable: true },
				}),
			).toMatchObject({ retryable: false });
			// A trusted pre-dispatch credential failure is the only way to release this receipt.
			await db
				.update(coreTable(db, tediApprovalRequests))
				.set({
					payload: {
						kind: "mcp_tool_call",
						fingerprint: "run",
						consumedAt: now,
						execution: { status: "running", startedAt: now },
					},
				})
				.where(eq(coreTable(db, tediApprovalRequests).id, "run"));
			expect(
				await recordOwnerToolApprovalExecution(db, {
					...input,
					credentialFailureBeforeDispatch: true,
					execution: { status: "failed", startedAt: now },
				}),
			).toMatchObject({ retryable: true });
			const later = "2026-11-27T12:10:00.000Z";
			expect(
				await reclaimOwnerToolApprovalExecution(db, {
					...input,
					now: later,
					retriedBy: "person",
					staleBefore: now,
					attempt: 2,
				}),
			).toBe(true);
			expect(
				await recordOwnerToolApprovalExecution(db, {
					...input,
					execution: { status: "executed", startedAt: now },
				}),
			).toBeNull();
			expect(
				await consumeOwnerToolApproval(db, {
					...input,
					now: later,
					fingerprint: "run",
				}),
			).toBe(true);
			expect(
				await continueOwnerToolApprovalExecution(db, {
					...input,
					now: later,
					startedAt: later,
					args: { limit: 1 },
					continuation: { cursor: 2 },
					execution: {
						status: "queued",
						startedAt: later,
						nextAttemptAt: later,
					},
				}),
			).toBe(true);
			expect(
				await dismissOwnerToolApprovalExecution(db, {
					...input,
					dismissedBy: "person",
					staleBefore: now,
				}),
			).toBe(true);
			expect(
				await reclaimOwnerToolApprovalExecution(db, {
					...input,
					retriedBy: "person",
					staleBefore: later,
					attempt: 3,
				}),
			).toBe(false);
		});

		it("queues and recovers continuable runs without replaying a consumed ordinary call", async () => {
			const table = coreTable(db, tediApprovalRequests);
			for (const id of ["purge", "ordinary"]) {
				await db.insert(table).values(
					request(id, {
						status: "approved",
						actionType: "mcp.tool_call",
						payload: {
							kind: "mcp_tool_call",
							fingerprint: id,
							target: { transport: "rpc", endpoint: "purge" },
							args: { dryRun: false },
						},
					}),
				);
				expect(
					await queueOwnerToolApprovalExecution(db, {
						id,
						organizationId: "org",
						now: old,
					}),
				).toBe(true);
				await db
					.update(table)
					.set({
						payload: {
							kind: "mcp_tool_call",
							consumedAt: old,
							target: {
								transport: "rpc",
								endpoint: id === "purge" ? "purge" : "other",
							},
							args: { dryRun: false },
							execution: { status: "running", startedAt: old },
						},
					})
					.where(eq(table.id, id));
			}
			expect(
				await requeueStaleContinuableOwnerToolApprovals(db, {
					now,
					staleBefore: now,
					endpoints: ["purge"],
				}),
			).toBe(1);
			expect(await getApprovalRequestById(db, "purge")).toMatchObject({
				payload: { transientRetries: 0, execution: { status: "queued" } },
			});
			expect(
				await failConsumedStaleOwnerToolRuns(db, { now, staleBefore: now }),
			).toBe(1);
			expect(await getApprovalRequestById(db, "ordinary")).toMatchObject({
				payload: {
					consumedAt: old,
					execution: { status: "failed", startedAt: old, retryable: false },
				},
			});
		});

		it("preserves Home fallback receipts and enforces personal approval visibility", async () => {
			await db.insert(coreTable(db, tediApprovalRequests)).values(
				request("home", {
					status: "approved",
					actionType: "home.tool_write",
				}),
			);
			const input = {
				id: "home",
				organizationId: "org",
				now,
				slot: `user_${"a".repeat(64)}`,
			};
			expect(await consumeHomeToolApprovalCall(db, input)).toBe(true);
			expect(
				await consumeHomeToolApprovalCall(db, {
					...input,
					now: future,
					slot: input.slot.replace("user_", "tenant_"),
				}),
			).toBe(false);
			expect(
				await consumeHomeToolApprovalCall(db, {
					...input,
					now: "2026-11-27T13:00:00.000Z",
					slot: input.slot.replace("user_", "tenant_"),
				}),
			).toBe(true);
			expect(
				(await getApprovalRequestById(db, "home"))?.payload.consumedCalls,
			).toMatchObject({ [input.slot]: now });
			await createApprovalRequest(
				db,
				request("private", { payload: { approverUserId: "person" } }),
			);
			expect(
				(
					await listApprovalRequests(db, {
						orgId: "org",
						viewerUserId: "other",
						status: "pending",
						actionType: "custom",
						limit: 200,
					})
				).data.map((row) => row.id),
			).not.toContain("private");
			expect(
				(
					await listApprovalRequests(db, {
						orgId: "org",
						viewerUserId: "person",
						status: "pending",
						actionType: "custom",
						limit: 200,
					})
				).data.map((row) => row.id),
			).toContain("private");
		});

		it("reuses only exact review identities and fences provisional transitions and expiry", async () => {
			const provisional = {
				id: "draft",
				orgId: "org",
				tediId: "tedi",
				kind: "draft" as const,
				title: "Draft",
				payload: { count: 1 },
				createdAt: old,
			};
			await createProvisionalOutcome(db, provisional);
			expect(await getProvisionalOutcomeById(db, "draft")).toMatchObject(
				provisional,
			);
			expect(await listProvisionalOutcomes(db, { orgId: "other" })).toEqual([]);
			const review = {
				id: "promotion",
				provisionalOutcomeId: "draft",
				provisionalOutcomeHash: "hash",
				orgId: "org",
				tediId: "tedi",
				description: "Promote",
				createdAt: old,
				expiresAt: future,
				workflowId: "workflow",
			};
			expect(
				(await ensureProvisionalPromotionApprovalRequest(db, review)).created,
			).toBe(true);
			expect(
				(await ensureProvisionalPromotionApprovalRequest(db, review)).created,
			).toBe(false);
			await expect(
				ensureProvisionalPromotionApprovalRequest(db, {
					...review,
					provisionalOutcomeHash: "other",
				}),
			).rejects.toThrow();
			const transition = {
				id: "draft",
				orgId: "org",
				actorId: "person",
				at: now,
				approvalRequestId: "promotion",
			};
			expect(
				await promoteProvisionalOutcome(db, { ...transition, orgId: "other" }),
			).toBeUndefined();
			expect(await promoteProvisionalOutcome(db, transition)).toMatchObject({
				state: "promoted",
			});
			expect(
				await rollbackProvisionalOutcome(db, {
					...transition,
					reason: "Withdrawn",
				}),
			).toMatchObject({ state: "rolled_back" });
			const payment = request("payment", {
				actionType: "payment_budget_override",
				payload: { kind: "payment_budget_override", rejectedEventId: "event" },
			});
			expect(
				(await ensurePaymentBudgetOverrideRequest(db, payment)).created,
			).toBe(true);
			expect(
				(await ensurePaymentBudgetOverrideRequest(db, payment)).created,
			).toBe(false);
			await db
				.insert(coreTable(db, tediApprovalRequests))
				.values(request("expired", { expiresAt: old }));
			expect(
				await expireStaleApprovals(db, {
					organizationId: "other",
					dueIds: ["expired"],
				}),
			).toBe(0);
			expect(
				await expireStaleApprovals(db, {
					organizationId: "org",
					dueIds: ["expired"],
				}),
			).toBe(1);
		});

		it("re-batches exact catalog snapshots and activates held JSON definitions only when hashes match", async () => {
			const app = coreTable(db, apps);
			const tools = coreTable(db, appTools);
			await db
				.insert(app)
				.values({ id: "app", organizationId: "org", name: "App", slug: "app" });
			const held: ToolReviewPendingDefinition = {
				toolTypeId: "mcp",
				title: "Read",
				description: "Changed",
				inputSchema: {
					type: "object",
					properties: { query: { type: "string" } },
				},
				config: { transport: "mcp" },
				schemaSourceHash: "new",
				writeCapability: "read",
				annotations: { readOnlyHint: true },
				outputSchema: null,
				icons: null,
				executionTaskSupport: null,
				meta: null,
				schemaDialect: "json-schema-2020-12",
				schemaSource: "mcp",
				schemaSourceRef: null,
				schemaSyncedAt: now,
			};
			const tool: typeof appTools.$inferInsert = {
				id: "tool",
				appId: "app",
				toolId: "read_records",
				toolTypeId: "mcp",
				title: "Read",
				description: "Old",
				inputSchema: { type: "object", properties: {} },
				schemaSourceHash: "old",
				reviewState: "pending",
				reviewDiff: {
					source: "upstream_mcp",
					before: null,
					after: {
						description: "Changed",
						inputSchema: held.inputSchema,
						outputSchema: null,
						schemaSourceHash: "new",
					},
				},
				reviewPending: held,
			};
			await db.insert(tools).values(tool);
			const input = {
				organizationId: "org",
				appId: "app",
				appName: "App",
				tediId: "tedi",
				createdAt: old,
				expiresAt: future,
			};
			const [stale] = await reconcileToolReviewApproval(db, input);
			expect(stale?.payload).toMatchObject({
				expectedCount: 1,
				changes: [{ rowId: "tool", schemaSourceHash: "new" }],
			});
			await db
				.update(tools)
				.set({ reviewPending: { ...held, schemaSourceHash: "changed" } })
				.where(eq(tools.id, "tool"));
			expect(
				await resolveToolCatalogApprovalRequest(db, stale!.id, {
					status: "approved",
					resolvedBy: "person",
				}),
			).toBeUndefined();
			await db
				.update(tools)
				.set({ reviewPending: held })
				.where(eq(tools.id, "tool"));
			const [current] = await reconcileToolReviewApproval(db, input);
			expect(await getApprovalRequestById(db, stale!.id)).toMatchObject({
				status: "cancelled",
				payload: { supersededBy: current!.id },
			});
			expect(
				await resolveToolCatalogApprovalRequest(db, current!.id, {
					status: "approved",
					resolvedBy: "person",
				}),
			).toMatchObject({ status: "approved" });
			expect(
				await db
					.select()
					.from(tools)
					.where(and(eq(tools.appId, "app"), eq(tools.id, "tool"))),
			).toMatchObject([
				{
					reviewState: "live",
					description: "Changed",
					config: { transport: "mcp" },
					writeCapability: "read",
					annotations: { readOnlyHint: true },
				},
			]);
		});
	});
}

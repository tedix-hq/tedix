import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { tediApprovalRequests } from "../schema/approvals";
import { auditEvents } from "../schema/audit-events";
import {
	chatDispatchIdempotency,
	kernelRuntimeRuns,
	kernelWakeQueue,
	tediArtifacts,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { organizations } from "../schema/organizations";
import { tediSessionStates } from "../schema/tedi-sessions";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	claimTediArtifact,
	enqueueKernelChildWake,
	findOrphanRuns,
	getLatestTediConversationCompactionEvent,
	getMappedDispatchRunId,
	getTediArtifact,
	insertTediRuntimeEvent,
	isTediConversationDeleted,
	listTediApprovalRequests,
	listTediArtifacts,
	listTediConversationIndexRows,
	listTediConversationTranscriptRows,
	listTediObservabilityRows,
	markTediArtifactPublished,
	patchOldestQueuedDispatchRunId,
	upsertChatDispatchIdempotency,
	upsertTediArtifact,
} from "./cognitive-runtime";

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			tediRuntimeEvents,
			tediArtifacts,
			chatDispatchIdempotency,
			kernelWakeQueue,
			kernelRuntimeRuns,
			tediApprovalRequests,
			tediSessionStates,
			auditEvents,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('org-1', 'One', 'one'),
			('org-2', 'Two', 'two');
		INSERT INTO tedis (id, organization_id, name, slug) VALUES
			('tedi-1', 'org-1', 'One', 'one'),
			('tedi-2', 'org-2', 'Two', 'two');
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("cognitive runtime query boundary", () => {
	it.each([
		{
			name: "legacy completion",
			kind: "message.completed",
			payload: undefined,
			success: true,
		},
		{
			name: "assistant reply",
			kind: "message.completed",
			payload: { role: "assistant", content: "Done" },
			success: true,
		},
		{
			name: "null failure fields",
			kind: "message.completed",
			payload: { status: null, error: null },
			success: true,
		},
		{
			name: "completed status",
			kind: "message.completed",
			payload: { status: "completed" },
			success: true,
		},
		{
			name: "failed reply",
			kind: "message.completed",
			payload: { status: "failed" },
			success: false,
		},
		{
			name: "error reply",
			kind: "message.completed",
			payload: { status: "error" },
			success: false,
		},
		{
			name: "canceled reply",
			kind: "message.completed",
			payload: { status: "canceled" },
			success: false,
		},
		{
			name: "cancelled reply",
			kind: "message.completed",
			payload: { status: "cancelled" },
			success: false,
		},
		{
			name: "uppercase failure",
			kind: "message.completed",
			payload: { status: "FAILED" },
			success: false,
		},
		{
			name: "error text",
			kind: "message.completed",
			payload: { error: "provider failed" },
			success: false,
		},
		{
			name: "empty error text",
			kind: "message.completed",
			payload: { error: "" },
			success: false,
		},
		{
			name: "error object",
			kind: "message.completed",
			payload: { error: { message: "provider failed" } },
			success: false,
		},
		{
			name: "generic artifact",
			kind: "artifact.created",
			payload: undefined,
			success: false,
		},
		{
			name: "completed subprocess",
			kind: "artifact.created",
			payload: {
				artifact: {
					metadata: { eventType: "workstation.process.completed", exitCode: 0 },
				},
			},
			success: false,
		},
		{
			name: "failed subprocess",
			kind: "artifact.created",
			payload: {
				artifact: {
					metadata: { eventType: "workstation.process.failed", exitCode: 1 },
				},
			},
			success: false,
		},
	] satisfies Array<{
		name: string;
		kind: "message.completed" | "artifact.created";
		payload: Parameters<typeof insertTediRuntimeEvent>[1]["payload"];
		success: boolean;
	}>)(
		"uses only successful message evidence for direct and mapped orphan runs: $name",
		async ({ kind, payload, success }) => {
			const { db } = fixture();
			const common = {
				organizationId: "org-1",
				tediId: "tedi-1",
				conversationId: "agent:main:orphan",
				runtimeBackend: "cloudflare-agents" as const,
			};
			for (const runId of ["direct", "dispatch"]) {
				await insertTediRuntimeEvent(db, {
					...common,
					id: `${runId}:started`,
					kind: "run.started",
					runId,
					createdAt: "2026-08-01T00:00:00.000Z",
				});
			}
			await upsertChatDispatchIdempotency(db, {
				idempotencyKey: "dispatch",
				...common,
				createdAt: "2026-08-01T00:00:00.000Z",
			});
			await patchOldestQueuedDispatchRunId(db, {
				tediId: common.tediId,
				conversationId: common.conversationId,
				runId: "mapped",
				cutoff: "2026-07-31T23:59:00.000Z",
				mappedAt: "2026-08-01T00:01:00.000Z",
			});
			for (const runId of ["direct", "mapped"]) {
				await insertTediRuntimeEvent(db, {
					...common,
					id: `${runId}:evidence`,
					kind,
					payload,
					runId,
					createdAt: "2026-08-01T00:01:00.000Z",
				});
			}
			const candidates = await findOrphanRuns(db, {
				now: new Date("2026-08-01T00:20:00.000Z"),
				organizationId: common.organizationId,
			});
			expect(
				candidates.find((row) => row.runId === "direct")?.succeededLost,
			).toBe(success);
			expect(candidates.some((row) => row.runId === "dispatch")).toBe(!success);
		},
	);
	it("requires both tenant and tedi predicates for observability rows", async () => {
		const { db, sqlite } = fixture();
		await insertTediRuntimeEvent(db, {
			id: "observability-target",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "tool.failed",
			payload: { toolName: "target_tool", input: "private" },
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-09-03T00:30:00.000Z",
		});
		await insertTediRuntimeEvent(db, {
			id: "observability-other-tedi",
			organizationId: "org-2",
			tediId: "tedi-2",
			kind: "tool.failed",
			payload: { toolName: "other_tool", input: "other private" },
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-09-03T00:31:00.000Z",
		});
		sqlite.exec(`
			INSERT INTO audit_events (
				id, organization_id, actor_id, actor_type, action,
				resource_type, resource_id, metadata, timestamp
			) VALUES
				('audit-target', 'org-1', 'tedi-1', 'tedi', 'mcp.tool.execute',
				 'tool', 'target_tool', '{"private":"target"}', 1788395400),
				('audit-wrong-org', 'org-2', 'tedi-1', 'tedi', 'mcp.tool.execute',
				 'tool', 'other_tool', '{"private":"other"}', 1788395460),
				('audit-wrong-actor', 'org-1', 'user-1', 'user', 'mcp.tool.execute',
				 'tool', 'user_tool', NULL, 1788395520);
		`);

		const target = await listTediObservabilityRows(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			from: "2026-09-03T00:00:00.000Z",
			to: "2026-09-03T01:00:00.000Z",
			limit: 10,
		});
		expect(target.runtimeEvents.map((row) => row.id)).toEqual([
			"observability-target",
		]);
		expect(target.auditEvents.map((row) => row.id)).toEqual(["audit-target"]);

		const mismatchedTenant = await listTediObservabilityRows(db, {
			organizationId: "org-2",
			tediId: "tedi-1",
			from: "2026-09-03T00:00:00.000Z",
			to: "2026-09-03T01:00:00.000Z",
			limit: 10,
		});
		expect(mismatchedTenant.runtimeEvents).toEqual([]);
		expect(mismatchedTenant.auditEvents).toEqual([]);
	});

	it("keeps classified artifact claims immutable across retries and legacy upserts", async () => {
		const { db } = fixture();
		const claim = {
			id: "artifact-derived",
			organizationId: "org-1",
			tediId: "tedi-1",
			conversationId: "conversation-1",
			runId: "run-1",
			messageId: "message-1",
			kind: "file" as const,
			name: "report.txt",
			mimeType: "text/plain",
			uri: "r2://immutable/report.txt",
			sizeBytes: 5,
			metadata: { contentSha256: "a".repeat(64) },
			accessClassification: "source_derived" as const,
			contentDigest: "a".repeat(64),
			producerExecutionId: "execution-1",
			accessEnvelope: '{"version":1,"sources":[]}',
			createdAt: "2026-09-22T00:00:00.000Z",
		};
		expect((await claimTediArtifact(db, claim)).created).toBe(true);
		expect((await claimTediArtifact(db, claim)).created).toBe(false);
		const withoutTimestamp = {
			...claim,
			id: "artifact-derived-omitted-created-at",
			createdAt: undefined,
		};
		expect((await claimTediArtifact(db, withoutTimestamp)).created).toBe(true);
		expect((await claimTediArtifact(db, withoutTimestamp)).created).toBe(false);
		expect(
			(await claimTediArtifact(db, { ...claim, createdAt: undefined })).created,
		).toBe(false);
		await expect(
			claimTediArtifact(db, {
				...claim,
				createdAt: "2026-09-22T00:00:01.000Z",
			}),
		).rejects.toThrow("owned by another tedi");
		await expect(
			claimTediArtifact(db, { ...claim, name: "changed.txt" }),
		).rejects.toThrow("owned by another tedi");
		await expect(
			upsertTediArtifact(db, {
				...claim,
				accessClassification: undefined,
				name: "downgraded.txt",
			}),
		).rejects.toThrow("owned by another tedi");
		expect(
			await getTediArtifact(db, {
				organizationId: "org-1",
				artifactId: claim.id,
			}),
		).toMatchObject({
			name: "report.txt",
			accessClassification: "source_derived",
		});
	});

	it("accepts runtime-private artifact claims and retains their class on exact replay", async () => {
		const { db } = fixture();
		const claim = {
			id: "artifact-runtime-private",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "file" as const,
			name: "private.txt",
			uri: "r2://immutable/private.txt",
			accessClassification: "runtime_private" as const,
			contentDigest: "d".repeat(64),
			publicationState: "ready" as const,
			createdAt: "2026-09-23T00:00:00.000Z",
		};
		expect((await claimTediArtifact(db, claim)).created).toBe(true);
		expect((await claimTediArtifact(db, claim)).created).toBe(false);
		expect(
			await getTediArtifact(db, {
				organizationId: claim.organizationId,
				artifactId: claim.id,
			}),
		).toMatchObject({ accessClassification: "runtime_private" });
	});

	it("publishes only the exact pending artifact claim", async () => {
		const { db } = fixture();
		const claim = {
			id: "artifact-unpublished",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "file" as const,
			name: "report.txt",
			uri: "r2://immutable/report.txt",
			accessClassification: "source_derived" as const,
			contentDigest: "a".repeat(64),
			publicationState: "pending" as const,
			createdAt: "2026-09-22T00:00:00.000Z",
		};
		await claimTediArtifact(db, claim);
		await expect(
			markTediArtifactPublished(db, {
				id: claim.id,
				organizationId: claim.organizationId,
				tediId: claim.tediId,
				contentDigest: "b".repeat(64),
			}),
		).resolves.toBeNull();
		await expect(
			markTediArtifactPublished(db, {
				id: claim.id,
				organizationId: claim.organizationId,
				tediId: claim.tediId,
				contentDigest: claim.contentDigest,
			}),
		).resolves.toMatchObject({ publicationState: "ready" });
		await expect(
			getTediArtifact(db, {
				organizationId: claim.organizationId,
				artifactId: claim.id,
			}),
		).resolves.toMatchObject({ publicationState: "ready" });
	});

	it("keeps correlated run-state lookups on the run-and-kind covering index", () => {
		const { sqlite } = fixture();
		const columns = sqlite
			.prepare("PRAGMA index_info('idx_tedi_runtime_events_run_kind_created')")
			.all()
			.map((row) => row.name);

		expect(columns).toEqual(["tedi_id", "run_id", "kind", "created_at"]);

		const plan = sqlite
			.prepare(`
				EXPLAIN QUERY PLAN
				SELECT id
				FROM tedi_runtime_events started
				WHERE started.kind = 'run.started'
					AND NOT EXISTS (
						SELECT 1 FROM tedi_runtime_events terminal
						WHERE terminal.tedi_id = started.tedi_id
							AND terminal.run_id = started.run_id
							AND terminal.kind IN (
								'run.completed', 'run.failed', 'run.canceled'
							)
					)
			`)
			.all()
			.map((row) => row.detail);

		expect(plan).toContain(
			"SEARCH terminal USING COVERING INDEX idx_tedi_runtime_events_run_kind_created (tedi_id=? AND run_id=? AND kind=?)",
		);
	});

	it("keeps transcript and conversation reads scoped and honors soft deletion", async () => {
		const { db, sqlite } = fixture();
		await insertTediRuntimeEvent(db, {
			id: "event-user",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "message.received",
			conversationId: "agent:main:one",
			runId: "run-1",
			payload: { content: "hello" },
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		await insertTediRuntimeEvent(db, {
			id: "event-assistant",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "message.completed",
			conversationId: "agent:main:one",
			runId: "run-1",
			payload: { content: "hi" },
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-08-01T00:01:00.000Z",
		});
		await insertTediRuntimeEvent(db, {
			id: "event-other-org",
			organizationId: "org-2",
			tediId: "tedi-2",
			kind: "message.received",
			conversationId: "agent:main:one",
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-08-01T00:02:00.000Z",
		});

		await expect(
			listTediConversationTranscriptRows(db, {
				tediId: "tedi-1",
				conversationId: "agent:main:one",
				limit: 10,
			}),
		).resolves.toMatchObject([{ id: "event-assistant" }, { id: "event-user" }]);
		await expect(
			listTediConversationIndexRows(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				limit: 10,
			}),
		).resolves.toHaveLength(2);

		sqlite.exec(`
			INSERT INTO tedi_session_states (
				id, organization_id, tedi_id, user_id, session_key, deleted_at,
				created_at, updated_at
			) VALUES (
				'state-1', 'org-1', 'tedi-1', 'user-1',
				'agent:main:one', '2026-08-01T00:03:00.000Z',
				'2026-08-01T00:00:00.000Z', '2026-08-01T00:03:00.000Z'
			);
		`);
		await expect(
			isTediConversationDeleted(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				conversationId: "agent:main:one",
			}),
		).resolves.toBe(true);
		await expect(
			listTediConversationIndexRows(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				limit: 10,
			}),
		).resolves.toEqual([]);
	});

	it("returns only the latest compaction event for the requested tedi conversation", async () => {
		const { db } = fixture();
		const compactionEvent = (
			id: string,
			input: {
				tediId: string;
				organizationId: string;
				conversationId: string;
				createdAt: string;
				summary: string;
			},
		) =>
			insertTediRuntimeEvent(db, {
				id,
				organizationId: input.organizationId,
				tediId: input.tediId,
				kind: "context.compacted",
				conversationId: input.conversationId,
				payload: {
					summary: input.summary,
					firstKeptEntryId: `${id}:kept`,
					tokensBefore: 1_000,
				},
				runtimeBackend: "cloudflare-agents",
				createdAt: input.createdAt,
			});

		await compactionEvent("target-old", {
			tediId: "tedi-1",
			organizationId: "org-1",
			conversationId: "agent:main:one",
			createdAt: "2026-08-01T00:01:00.000Z",
			summary: "old",
		});
		await compactionEvent("target-new", {
			tediId: "tedi-1",
			organizationId: "org-1",
			conversationId: "agent:main:one",
			createdAt: "2026-08-01T00:04:00.000Z",
			summary: "new",
		});
		await compactionEvent("other-conversation", {
			tediId: "tedi-1",
			organizationId: "org-1",
			conversationId: "agent:main:other",
			createdAt: "2026-08-01T00:05:00.000Z",
			summary: "wrong conversation",
		});
		await compactionEvent("other-tedi", {
			tediId: "tedi-2",
			organizationId: "org-2",
			conversationId: "agent:main:one",
			createdAt: "2026-08-01T00:06:00.000Z",
			summary: "wrong tedi",
		});

		await expect(
			getLatestTediConversationCompactionEvent(db, {
				tediId: "tedi-1",
				conversationId: "agent:main:one",
			}),
		).resolves.toEqual({
			payload: {
				summary: "new",
				firstKeptEntryId: "target-new:kept",
				tokensBefore: 1_000,
			},
			createdAt: "2026-08-01T00:04:00.000Z",
		});
	});

	it("preserves idempotency, wake, approval, and artifact semantics on D1", async () => {
		const { db, sqlite } = fixture();
		await upsertChatDispatchIdempotency(db, {
			idempotencyKey: "dispatch-1",
			tediId: "tedi-1",
			organizationId: "org-1",
			conversationId: "agent:main:one",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		await expect(
			patchOldestQueuedDispatchRunId(db, {
				tediId: "tedi-1",
				conversationId: "agent:main:one",
				runId: "run-1",
				cutoff: "2026-07-31T23:59:00.000Z",
				mappedAt: "2026-08-01T00:01:00.000Z",
			}),
		).resolves.toBe(1);
		await expect(
			getMappedDispatchRunId(db, {
				tediId: "tedi-1",
				idempotencyKey: "dispatch-1",
			}),
		).resolves.toBe("run-1");

		await enqueueKernelChildWake(db, {
			id: "wake-1",
			organizationId: "org-1",
			parentConversationId: "home:one",
			childRunId: "run-1",
			childStatus: "completed",
			queuedAt: "2026-08-01T00:02:00.000Z",
		});
		await enqueueKernelChildWake(db, {
			id: "wake-1",
			organizationId: "org-1",
			parentConversationId: "home:one",
			childRunId: "run-1",
			childStatus: "completed",
			queuedAt: "2026-08-01T00:02:00.000Z",
		});
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM kernel_wake_queue").get(),
		).toMatchObject({
			count: 1,
		});

		sqlite.exec(`
			INSERT INTO tedi_approval_requests (
				id, tedi_id, org_id, action_type, description, payload,
				status, created_at, expires_at
			) VALUES
				('approval-1', 'tedi-1', 'org-1', 'deploy', 'Deploy', '{}',
				 'pending', '2026-08-01T00:01:00.000Z', '2026-08-02T00:00:00.000Z'),
				('approval-2', 'tedi-2', 'org-2', 'deploy', 'Other', '{}',
				 'pending', '2026-08-01T00:02:00.000Z', '2026-08-02T00:00:00.000Z');
		`);
		await expect(
			listTediApprovalRequests(db, {
				tediId: "tedi-1",
				organizationId: "org-1",
				status: "pending",
				limit: 10,
			}),
		).resolves.toMatchObject([{ id: "approval-1" }]);

		await upsertTediArtifact(db, {
			id: "artifact-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "file",
			name: "before.txt",
			uri: "r2://before",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		await expect(
			upsertTediArtifact(db, {
				id: "artifact-1",
				organizationId: "org-2",
				tediId: "tedi-2",
				kind: "file",
				name: "attacker.txt",
				uri: "r2://attacker",
				createdAt: "2026-08-01T02:00:00.000Z",
			}),
		).rejects.toThrow("owned by another tedi");
		await expect(
			upsertTediArtifact(db, {
				id: "artifact-1",
				organizationId: "org-1",
				tediId: "peer-tedi",
				kind: "file",
				name: "peer.txt",
				uri: "r2://peer",
				createdAt: "2026-08-01T02:00:00.000Z",
			}),
		).rejects.toThrow("owned by another tedi");
		await upsertTediArtifact(db, {
			id: "artifact-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "file",
			name: "after.txt",
			uri: "r2://after",
			createdAt: "2026-08-01T01:00:00.000Z",
		});
		await expect(
			getTediArtifact(db, { tediId: "tedi-1", artifactId: "artifact-1" }),
		).resolves.toMatchObject({
			organizationId: "org-1",
			tediId: "tedi-1",
			name: "after.txt",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		await expect(
			getTediArtifact(db, {
				organizationId: "org-1",
				artifactId: "artifact-1",
			}),
		).resolves.toMatchObject({
			organizationId: "org-1",
			tediId: "tedi-1",
			name: "after.txt",
		});
		await expect(
			getTediArtifact(db, {
				organizationId: "org-2",
				artifactId: "artifact-1",
			}),
		).resolves.toBeNull();
		await expect(
			listTediArtifacts(db, { tediId: "tedi-2", limit: 10 }),
		).resolves.toEqual([]);
		const race = await Promise.allSettled([
			upsertTediArtifact(db, {
				id: "artifact-race",
				organizationId: "org-1",
				tediId: "tedi-1",
				kind: "file",
				name: "one.txt",
				uri: "r2://one",
				createdAt: "2026-08-01T03:00:00.000Z",
			}),
			upsertTediArtifact(db, {
				id: "artifact-race",
				organizationId: "org-2",
				tediId: "tedi-2",
				kind: "file",
				name: "two.txt",
				uri: "r2://two",
				createdAt: "2026-08-01T03:00:00.000Z",
			}),
		]);
		expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(
			1,
		);
		expect(race.filter((result) => result.status === "rejected")).toHaveLength(
			1,
		);
	});

	it("detects only bounded, unterminated orphan runs through the D1 facade", async () => {
		const { db } = fixture();
		await insertTediRuntimeEvent(db, {
			id: "started-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "run.started",
			conversationId: "agent:main:one",
			runId: "run-orphan",
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		await insertTediRuntimeEvent(db, {
			id: "message-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "message.completed",
			conversationId: "agent:main:one",
			runId: "run-orphan",
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-08-01T00:01:00.000Z",
		});
		await insertTediRuntimeEvent(db, {
			id: "started-2",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "run.started",
			runId: "run-terminal",
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		await insertTediRuntimeEvent(db, {
			id: "terminal-2",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "run.failed",
			runId: "run-terminal",
			runtimeBackend: "cloudflare-agents",
			createdAt: "2026-08-01T00:02:00.000Z",
		});

		await expect(
			findOrphanRuns(db, {
				now: new Date("2026-08-01T00:20:00.000Z"),
				organizationId: "org-1",
				limit: 10,
			}),
		).resolves.toMatchObject([
			{ runId: "run-orphan", succeededLost: true, organizationId: "org-1" },
		]);
	});
});

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	countTediRuntimeEvents,
	insertKernelRuntimeEventIfAbsent,
	KernelRuntimeEventConflictError,
	listKernelRuntimeEvents,
	listTediRuntimeEvents,
	updateKernelRuntimeEventMetadata,
} from "./kernel-runtime-events";
import { insertTediRuntimeEvent } from "./cognitive-runtime";
import {
	findKernelRuntimeRunByChild,
	findKernelRuntimeRunForOutputRevision,
	getKernelRuntimeRun,
	listKernelRuntimeRunMetadata,
	listKernelRuntimeRuns,
	updateKernelRuntimeRun,
} from "./kernel-runtime-runs";

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			kernelRuntimeRuns,
			kernelRuntimeEvents,
			tediRuntimeEvents,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('org-1', 'One', 'one'),
			('org-2', 'Two', 'two');
		INSERT INTO tedis (id, organization_id, name, slug) VALUES
			('tedi-1', 'org-1', 'Tedi One', 'tedi-one');
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function seedRuns(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO kernel_runtime_runs (
			id, organization_id, conversation_id, status, delegated_tedi_id,
			child_run_id, metadata, created_at, updated_at
		) VALUES
			('run-old', 'org-1', 'conversation-1', 'running', 'tedi-1',
			 'child-1', '{"rank":1}', '2026-07-31T10:00:00Z', '2026-07-31T10:00:00Z'),
			('run-new', 'org-1', 'conversation-1', 'queued', NULL,
			 NULL, '{"rank":2}', '2026-07-31T11:00:00Z', '2026-07-31T11:00:00Z'),
			('run-other-org', 'org-2', 'conversation-1', 'failed', NULL,
			 NULL, '{"rank":3}', '2026-07-31T12:00:00Z', '2026-07-31T12:00:00Z');
	`);
}

describe("kernel runtime query boundary", () => {
	it("atomically binds immutable same-organization event causes", async () => {
		const { db } = fixture();
		await insertKernelRuntimeEventIfAbsent(db, {
			id: "cause",
			organizationId: "org-1",
			kind: "message.received",
			conversationId: "conversation-1",
		});
		const child = await insertKernelRuntimeEventIfAbsent(db, {
			id: "child",
			organizationId: "org-1",
			kind: "run.started",
			conversationId: "conversation-1",
			causeEventId: "cause",
		});
		expect(child).toMatchObject({
			inserted: true,
			row: { id: "child", causeEventId: "cause" },
		});
		await expect(
			insertKernelRuntimeEventIfAbsent(db, {
				id: "child",
				organizationId: "org-1",
				kind: "run.started",
				conversationId: "conversation-1",
				causeEventId: "cause",
			}),
		).resolves.toMatchObject({
			inserted: false,
			row: { causeEventId: "cause" },
		});
		await expect(
			insertKernelRuntimeEventIfAbsent(db, {
				id: "child",
				organizationId: "org-1",
				kind: "run.started",
				conversationId: "conversation-1",
			}),
		).resolves.toMatchObject({
			inserted: false,
			row: { causeEventId: "cause" },
		});
		await insertKernelRuntimeEventIfAbsent(db, {
			id: "cause-b",
			organizationId: "org-1",
			kind: "message.received",
			conversationId: "conversation-1",
		});
		await expect(
			insertKernelRuntimeEventIfAbsent(db, {
				id: "child",
				organizationId: "org-1",
				kind: "run.started",
				conversationId: "conversation-1",
				causeEventId: "cause-b",
			}),
		).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
		await expect(
			insertKernelRuntimeEventIfAbsent(db, {
				id: "empty-cause",
				organizationId: "org-1",
				kind: "run.started",
				conversationId: "conversation-1",
				causeEventId: "",
			}),
		).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
		for (const [id, organizationId, causeEventId] of [
			["missing-child", "org-1", "missing"],
			["cross-org-child", "org-2", "cause"],
			["self", "org-1", "self"],
		] as const)
			await expect(
				insertKernelRuntimeEventIfAbsent(db, {
					id,
					organizationId,
					kind: "run.started",
					conversationId: "conversation-1",
					causeEventId,
				}),
			).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
	});

	it("rejects explicit cause changes while omitted replay preserves legacy null", async () => {
		const { db } = fixture();
		await insertKernelRuntimeEventIfAbsent(db, {
			id: "cause",
			organizationId: "org-1",
			kind: "message.received",
			conversationId: "conversation-1",
		});
		await insertKernelRuntimeEventIfAbsent(db, {
			id: "legacy",
			organizationId: "org-1",
			kind: "run.started",
			conversationId: "conversation-1",
		});
		await expect(
			insertKernelRuntimeEventIfAbsent(db, {
				id: "legacy",
				organizationId: "org-1",
				kind: "run.started",
				conversationId: "conversation-1",
				causeEventId: "cause",
			}),
		).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
		await expect(
			insertKernelRuntimeEventIfAbsent(db, {
				id: "legacy",
				organizationId: "org-1",
				kind: "run.started",
				conversationId: "conversation-1",
			}),
		).resolves.toMatchObject({
			inserted: false,
			row: { causeEventId: null },
		});
		await insertKernelRuntimeEventIfAbsent(db, {
			id: "foreign-id",
			organizationId: "org-2",
			kind: "run.started",
			conversationId: "conversation-1",
		});
		await expect(
			insertKernelRuntimeEventIfAbsent(db, {
				id: "foreign-id",
				organizationId: "org-1",
				kind: "run.started",
				conversationId: "conversation-1",
			}),
		).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
	});
	it("projects metadata trace ids into indexed runtime columns", async () => {
		const { db } = fixture();
		const tediInsert = await insertTediRuntimeEvent(db, {
			id: "tedi-trace",
			organizationId: "org-1",
			tediId: "tedi-1",
			kind: "run.started",
			runtimeBackend: "cloudflare-agents",
			runtimeMetadata: { traceId: "trace-tedi" },
		});
		const kernelInsert = await insertKernelRuntimeEventIfAbsent(db, {
			id: "kernel-trace",
			organizationId: "org-1",
			kind: "run.started",
			conversationId: "conversation-1",
			runtimeMetadata: { traceId: "trace-kernel" },
		});

		expect(kernelInsert.row?.traceId).toBe("trace-kernel");
		expect(tediInsert?.traceId).toBe("trace-tedi");

		await updateKernelRuntimeEventMetadata(db, "kernel-trace", {
			traceId: "trace-kernel-updated",
		});
		await expect(
			listKernelRuntimeEvents(db, { id: "kernel-trace" }),
		).resolves.toMatchObject([{ traceId: "trace-kernel-updated" }]);
	});

	it("keeps run reads tenant-scoped, ordered, and patchable through D1", async () => {
		const { db, sqlite } = fixture();
		seedRuns(sqlite);

		await expect(
			getKernelRuntimeRun(db, { id: "run-old", organizationId: "org-2" }),
		).resolves.toBeUndefined();
		await expect(
			listKernelRuntimeRuns(db, {
				organizationId: "org-1",
				conversationId: "conversation-1",
				limit: 10,
			}),
		).resolves.toMatchObject([{ id: "run-new" }, { id: "run-old" }]);
		await expect(
			listKernelRuntimeRunMetadata(db, {
				organizationId: "org-1",
				conversationId: "conversation-1",
				limit: 1,
			}),
		).resolves.toEqual([{ metadata: { rank: 2 } }]);
		await expect(
			findKernelRuntimeRunByChild(db, {
				organizationId: "org-1",
				delegatedTediId: "tedi-1",
				childRunId: "child-1",
			}),
		).resolves.toMatchObject({ id: "run-old" });

		await updateKernelRuntimeRun(db, "run-old", {
			status: "completed",
			preview: "done",
		});
		await expect(
			getKernelRuntimeRun(db, { id: "run-old" }),
		).resolves.toMatchObject({
			status: "completed",
			preview: "done",
		});
	});

	it("preserves parent and child event cursor ordering and receipt counts", async () => {
		const { db, sqlite } = fixture();
		seedRuns(sqlite);
		sqlite.exec(`
			INSERT INTO kernel_runtime_events (
				id, organization_id, kind, conversation_id, run_id, created_at
			) VALUES
				('parent-1', 'org-1', 'message.received', 'conversation-1', 'run-old', '2026-07-31T10:00:00Z'),
				('parent-2', 'org-1', 'run.completed', 'conversation-1', 'run-old', '2026-07-31T10:02:00Z'),
				('parent-other', 'org-2', 'run.completed', 'conversation-1', 'run-other-org', '2026-07-31T10:03:00Z');
			INSERT INTO tedi_runtime_events (
				id, organization_id, tedi_id, kind, run_id, runtime_backend, created_at
			) VALUES
				('child-evt-1', 'org-1', 'tedi-1', 'submission.admitted', 'child-1', 'custom', '2026-07-31T10:00:00Z'),
				('child-evt-2', 'org-1', 'tedi-1', 'run.completed', 'child-1', 'custom', '2026-07-31T10:02:00Z');
		`);

		await expect(
			listKernelRuntimeEvents(db, {
				organizationId: "org-1",
				runId: "run-old",
				order: "asc",
			}),
		).resolves.toMatchObject([{ id: "parent-1" }, { id: "parent-2" }]);
		await expect(
			listKernelRuntimeEvents(db, {
				organizationId: "org-1",
				createdBefore: "2026-07-31T10:01:00Z",
				order: "desc",
			}),
		).resolves.toMatchObject([{ id: "parent-1" }]);
		await expect(
			listTediRuntimeEvents(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				runId: "child-1",
				kinds: ["run.completed"],
				order: "desc",
			}),
		).resolves.toMatchObject([{ id: "child-evt-2" }]);
		await expect(
			countTediRuntimeEvents(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				runId: "child-1",
			}),
		).resolves.toBe(2);
	});
});

describe("Home output authoring lookup", () => {
	const target = {
		organizationId: "org-1",
		outputId: "output-1",
		revisionId: "revision-1",
	};
	const evidence = {
		kernelEvidence: {
			toolName: "os.create_os_output",
			data: {
				output: { id: "output-1" },
				revision: { id: "revision-1", outputId: "output-1" },
			},
		},
	};
	function seed(
		sqlite: DatabaseSync,
		id: string,
		metadata: unknown,
		status = "completed",
	) {
		sqlite
			.prepare(
				"INSERT INTO kernel_runtime_runs(id, organization_id, conversation_id, status, metadata, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
			)
			.run(
				id,
				"org-1",
				"conversation-1",
				status,
				typeof metadata === "string" ? metadata : JSON.stringify(metadata),
				"2026-09-20",
				"2026-09-20",
			);
	}
	it("matches exact historical evidence, scopes tenants and revisions, rejects ambiguity", async () => {
		const { db, sqlite } = fixture();
		seed(sqlite, "run-1", evidence);
		expect(await findKernelRuntimeRunForOutputRevision(db, target)).toEqual({
			id: "run-1",
			conversationId: "conversation-1",
		});
		expect(
			await findKernelRuntimeRunForOutputRevision(db, {
				...target,
				organizationId: "org-2",
			}),
		).toBeNull();
		expect(
			await findKernelRuntimeRunForOutputRevision(db, {
				...target,
				revisionId: "other",
			}),
		).toBeNull();
		seed(sqlite, "run-2", evidence);
		expect(await findKernelRuntimeRunForOutputRevision(db, target)).toBeNull();
		sqlite.close();
	});
	it("retains identity after evidence truncation", async () => {
		const { db, sqlite } = fixture();
		seed(sqlite, "run-1", {
			kernelEvidence: {
				toolName: "os__create_os_output",
				data: { truncated: true },
			},
			kernelOutputReceipt: { outputId: "output-1", revisionId: "revision-1" },
		});
		expect(
			await findKernelRuntimeRunForOutputRevision(db, target),
		).toMatchObject({ id: "run-1" });
		sqlite.close();
	});
	it.each([
		"invalid json",
		{},
		{
			kernelEvidence: { ...evidence.kernelEvidence, toolName: "other.create" },
		},
		{
			kernelEvidence: { ...evidence.kernelEvidence, data: { truncated: true } },
		},
		{
			...evidence,
			kernelOutputReceipt: { outputId: "other", revisionId: "revision-1" },
		},
		{
			kernelEvidence: {
				...evidence.kernelEvidence,
				data: {
					...evidence.kernelEvidence.data,
					revision: { id: "revision-1", outputId: "other" },
				},
			},
		},
	])("rejects malformed or conflicting evidence", async (metadata) => {
		const { db, sqlite } = fixture();
		seed(sqlite, "run-1", metadata);
		expect(await findKernelRuntimeRunForOutputRevision(db, target)).toBeNull();
		sqlite.close();
	});
	it("rejects failed runs", async () => {
		const { db, sqlite } = fixture();
		seed(sqlite, "run-1", evidence, "failed");
		expect(await findKernelRuntimeRunForOutputRevision(db, target)).toBeNull();
		sqlite.close();
	});
});

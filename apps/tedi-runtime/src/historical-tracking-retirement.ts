import { createHash } from "node:crypto";
import { z } from "zod";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const Request = z.strictObject({
	operationId: z.string().min(1),
	expectedGeneration: z.number().int().positive(),
	snapshotId: digest,
	sourceHash: digest,
});
export type TrackingRetirementRequest = z.infer<typeof Request>;
const Receipt = z.strictObject({
	version: z.literal(1),
	request: Request,
	objectId: z.string().min(1),
	archiveHash: digest,
	originalSourceHash: digest,
	deletedSetHash: digest,
	postRetirementSourceHash: digest,
	workflowCount: z.number().int().nonnegative(),
	fiberCount: z.number().int().nonnegative(),
	runCount: z.number().int().nonnegative(),
});
export type TrackingRetirementReceipt = z.infer<typeof Receipt>;
const RECEIPT = "historical_tracking_retirement";
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deny = (): never => {
	throw new Error("historical_tracking_retirement_unavailable");
};

/** Storage-only retirement, never a release, completion, provider or financial qualification. */
export class HistoricalTrackingRetirement {
	private readonly archive: HistoricalLiabilityCustody;
	constructor(
		private readonly storage: Pick<
			DurableObjectStorage,
			"sql" | "kv" | "transactionSync"
		>,
		private readonly objectId: string,
	) {
		this.archive = new HistoricalLiabilityCustody(storage, objectId);
	}
	private recoveries(): void {
		const names = new Set(
			this.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
				.toArray()
				.map((row) => row.name),
		);
		const check = (table: string, columns: string[], predicate: string) => {
			if (!names.has(table)) return; // No table means this native recovery source has no stored rows.
			const actual = new Set(
				this.storage.sql
					.exec<{ name: string }>(`PRAGMA table_info(${table})`)
					.toArray()
					.map((row) => row.name),
			);
			if (columns.some((column) => !actual.has(column))) deny();
			if (
				this.storage.sql
					.exec<{ n: number }>(
						`SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`,
					)
					.toArray()[0]!.n !== 0
			)
				deny();
		};
		const trackingSchemas = {
			cf_agents_workflows: [
				"id",
				"workflow_id",
				"workflow_name",
				"status",
				"metadata",
				"error_name",
				"error_message",
				"created_at",
				"updated_at",
				"completed_at",
			],
			cf_agents_fibers: [
				"fiber_id",
				"idempotency_key",
				"name",
				"status",
				"snapshot",
				"metadata_json",
				"error_message",
				"created_at",
				"started_at",
				"completed_at",
			],
			cf_agents_runs: [
				"id",
				"name",
				"snapshot",
				"created_at",
				"completed_at",
				"outcome",
				"error_message",
			],
		};
		for (const [table, columns] of Object.entries(trackingSchemas)) {
			if (!names.has(table)) continue;
			const actual = this.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(${table})`)
				.toArray()
				.map((row) => row.name)
				.sort();
			if (JSON.stringify(actual) !== JSON.stringify([...columns].sort()))
				deny();
		}
		// Pinned Agents Tasks accepts only these three terminal states. A live lease/wake remains disqualifying.
		check(
			"cf_agents_task_runs",
			["state", "generation", "next_at", "settled_at"],
			"state IS NULL OR state NOT IN ('completed','failed','cancelled') OR generation IS NOT NULL OR next_at IS NOT NULL OR settled_at IS NULL",
		);
		if (names.has("cf_think_submissions")) {
			const columns = new Set(
				this.storage.sql
					.exec<{ name: string }>("PRAGMA table_info(cf_think_submissions)")
					.toArray()
					.map((row) => row.name),
			);
			check(
				"cf_think_submissions",
				["status"],
				"status IS NULL OR status NOT IN ('completed','aborted','skipped','error')" +
					(columns.has("result_status") ? " OR result_status='retry'" : ""),
			);
		}
		// Descendants, tool delivery and lifecycle jobs require their own qualification, outside this operation.
		for (const table of [
			"cf_agents_facet_runs",
			"cf_agent_tool_runs",
			"cf_agents_jobs",
			"cf_agents_schedules",
			"cf_agents_sub_agents",
		])
			check(table, [], "1");
		// PiHarness's default pi_ prefix is applied to pi-durable's actual v1 SQLite migrations.
		const piSchema = {
			pi_durable_schema: ["singleton", "version"],
			pi_durable_metadata: ["singleton", "next_id", "next_seq"],
			pi_record_ids: ["id", "record_type"],
			pi_conversations: [
				"id",
				"owner_conversation_id",
				"owner_task_id",
				"record",
			],
			pi_entries: ["id", "conversation_id", "head", "commit_seq", "record"],
			pi_tasks: [
				"id",
				"conversation_id",
				"kind",
				"status",
				"abort_requested",
				"background",
				"record",
			],
			pi_submissions: [
				"id",
				"conversation_id",
				"request_id",
				"status",
				"record",
			],
			pi_documents: [
				"id",
				"kind",
				"family",
				"key_value",
				"scope_kind",
				"owner_id",
				"created_at",
				"retired_at",
				"record",
			],
			pi_document_revisions: [
				"document_id",
				"seq",
				"kind",
				"version",
				"content",
			],
		};
		if (Object.keys(piSchema).some((name) => names.has(name))) {
			if (CURRENT_SQLITE_SCHEMA_VERSION !== 1) deny();
			for (const [table, columns] of Object.entries(piSchema)) {
				if (!names.has(table)) deny();
				const actual = this.storage.sql
					.exec<{ name: string }>(`PRAGMA table_info(${table})`)
					.toArray()
					.map((row) => row.name)
					.sort();
				if (JSON.stringify(actual) !== JSON.stringify([...columns].sort()))
					deny();
			}
			const schema = this.storage.sql
				.exec<{ singleton: number; version: number }>(
					"SELECT singleton,version FROM pi_durable_schema",
				)
				.toArray();
			if (
				schema.length !== 1 ||
				schema[0]!.singleton !== 1 ||
				schema[0]!.version !== 1
			)
				deny();
			check(
				"pi_tasks",
				["status", "record"],
				"status IS NULL OR status!='terminal' OR NOT json_valid(record) OR json_extract(record,'$.state.status') IS NULL OR json_extract(record,'$.state.status')!=status",
			);
			check(
				"pi_submissions",
				["status", "record"],
				"status IS NULL OR status NOT IN ('done','unanswered') OR NOT json_valid(record) OR json_extract(record,'$.status') IS NULL OR json_extract(record,'$.status')!=status",
			);
		}
		for (const key of [
			"pi-facet-pending-submission",
			"facet-pending-submission",
		])
			if (
				this.storage.kv
					.list({ start: key, end: `${key}\0`, limit: 1 })
					[Symbol.iterator]()
					.next().done === false
			)
				deny();
		for (const prefix of [
			"__cf_messenger_recovery:",
			"cf:chat-recovery:incident:",
			"pi-tool-approval:",
		])
			if (
				this.storage.kv.list({ prefix, limit: 1 })[Symbol.iterator]().next()
					.done === false
			)
				deny();
	}
	retire(value: TrackingRetirementRequest): TrackingRetirementReceipt {
		try {
			const request = Request.parse(value);
			return this.storage.transactionSync(() => {
				this.recoveries();
				const exists =
					this.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
							RECEIPT,
						)
						.toArray().length !== 0;
				if (exists) {
					const rows = this.storage.sql
						.exec<{ receipt: string; receipt_hash: string }>(
							`SELECT receipt,receipt_hash FROM ${RECEIPT}`,
						)
						.toArray();
					if (rows.length !== 1) deny();
					const row = rows[0]!,
						receipt = Receipt.parse(JSON.parse(row.receipt));
					if (
						hash(receipt) !== row.receipt_hash ||
						JSON.stringify(receipt.request) !== JSON.stringify(request) ||
						receipt.objectId !== this.objectId ||
						receipt.archiveHash !== request.snapshotId ||
						receipt.originalSourceHash !== request.sourceHash
					)
						deny();
					const original = this.archive.trackingRetirementProof({
						...request,
						expectedCurrentSourceHash: receipt.postRetirementSourceHash,
					});
					if (
						receipt.deletedSetHash !==
							hash({
								workflows: original.workflows,
								fibers: original.fibers,
								runs: original.runs,
							}) ||
						receipt.workflowCount !== original.workflows.length ||
						receipt.fiberCount !== original.fibers.length ||
						receipt.runCount !== original.runs.length
					)
						deny();
					return receipt;
				}
				const proof = this.archive.trackingRetirementProof(request);
				const deleted = {
					workflows: proof.workflows,
					fibers: proof.fibers,
					runs: proof.runs,
				};
				const receipt: TrackingRetirementReceipt = {
					version: 1,
					request,
					objectId: this.objectId,
					archiveHash: request.snapshotId,
					originalSourceHash: request.sourceHash,
					deletedSetHash: hash(deleted),
					postRetirementSourceHash: proof.postRetirementSourceHash,
					workflowCount: proof.workflows.length,
					fiberCount: proof.fibers.length,
					runCount: proof.runs.length,
				};
				for (const [table, column, ids] of [
					["cf_agents_workflows", "id", proof.workflows],
					["cf_agents_fibers", "fiber_id", proof.fibers],
					["cf_agents_runs", "id", proof.runs],
				] as const)
					for (const id of ids)
						this.storage.sql.exec(`DELETE FROM ${table} WHERE ${column}=?`, id);
				this.storage.sql.exec(
					`CREATE TABLE ${RECEIPT}(id INTEGER PRIMARY KEY CHECK(id=1),receipt TEXT NOT NULL,receipt_hash TEXT NOT NULL)`,
				);
				this.storage.sql.exec(
					`INSERT INTO ${RECEIPT} VALUES(1,?,?)`,
					JSON.stringify(receipt),
					hash(receipt),
				);
				// No writes follow this full streaming/source/custody check. Any reentrant last-write change rolls back.
				this.recoveries();
				this.archive.trackingRetirementProof({
					...request,
					expectedCurrentSourceHash: proof.postRetirementSourceHash,
				});
				return receipt;
			});
		} catch {
			return deny();
		}
	}
}

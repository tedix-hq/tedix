/**
 * Runtime admission tables inside the tedi runtime Durable Object's SQLite.
 * Generate migrations with
 * `bun run db:runtime-admission-store:generate -- --name <change>`.
 *
 * Every record is canonical JSON written and verified by
 * apps/tedi-runtime/src/runtime-admission*.ts; other runtime modules read
 * `runtime_admission_identities.input` by name.
 */
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The one admission snapshot of this object. */
export const runtimeAdmission = sqliteTable(
	"runtime_admission",
	{
		id: integer("id").primaryKey(),
		record: text("record").notNull(),
	},
	(table) => [check("runtime_admission_singleton", sql`${table.id} = 1`)],
);

/**
 * Written once by `initialize` and never removed. The migration creates every
 * admission table on the first admission write, so a state table no longer
 * proves the object was initialized; this row does. A missing state row with
 * this row present means the state was deleted, and reads fail closed.
 */
export const runtimeAdmissionInitialized = sqliteTable(
	"runtime_admission_initialized",
	{ id: integer("id").primaryKey() },
	(table) => [
		check("runtime_admission_initialized_singleton", sql`${table.id} = 1`),
	],
);

/** Accepted turn claims, keyed by turn id. */
export const runtimeAdmissionTurns = sqliteTable("runtime_admission_turns", {
	id: text("id").primaryKey(),
	record: text("record").notNull(),
});

/** Idempotent admission operations: the normalized input and its result. */
export const runtimeAdmissionOperations = sqliteTable(
	"runtime_admission_operations",
	{
		id: text("id").primaryKey(),
		input: text("input").notNull(),
		result: text("result").notNull(),
	},
);

/** Accepted run identities with the full canonical input they were accepted for. */
export const runtimeAdmissionIdentities = sqliteTable(
	"runtime_admission_identities",
	{
		runId: text("run_id").primaryKey(),
		record: text("record").notNull(),
		input: text("input").notNull(),
	},
);

/** Verified evidence snapshots, keyed by their digest. */
export const runtimeAdmissionEvidence = sqliteTable(
	"runtime_admission_evidence",
	{
		digest: text("digest").primaryKey(),
		action: text("action").notNull(),
		snapshot: text("snapshot").notNull(),
		claim: text("claim"),
	},
);

/** Terminal receipts of accepted runs. */
export const runtimeAdmissionReceipts = sqliteTable(
	"runtime_admission_receipts",
	{
		runId: text("run_id").primaryKey(),
		record: text("record").notNull(),
	},
);

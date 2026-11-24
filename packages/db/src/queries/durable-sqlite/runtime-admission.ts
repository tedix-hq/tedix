/**
 * Reads and writes of runtime admission state in the tedi runtime Durable
 * Object (`runtime-admission-store/schema.ts`). All synchronous, so admission
 * checks and writes run inside one `transactionSync` block without yielding.
 *
 * Tables appear lazily: never-admitted objects have none, and objects
 * admitted before the migration chain may hold only some. Callers check
 * `runtimeAdmissionTableExists` before reading a table they did not write.
 */
import { eq, sql } from "drizzle-orm";
import type { RuntimeAdmissionDb } from "../../runtime-admission-store/store";
import {
	runtimeAdmission,
	runtimeAdmissionEvidence,
	runtimeAdmissionIdentities,
	runtimeAdmissionOperations,
	runtimeAdmissionReceipts,
	runtimeAdmissionTurns,
} from "../../runtime-admission-store/schema";

const TABLE_INFO = {
	runtime_admission: sql`PRAGMA table_info(runtime_admission)`,
	runtime_admission_identities: sql`PRAGMA table_info(runtime_admission_identities)`,
	runtime_admission_evidence: sql`PRAGMA table_info(runtime_admission_evidence)`,
	runtime_admission_receipts: sql`PRAGMA table_info(runtime_admission_receipts)`,
};

/** Whether an admission table exists yet; table_info is empty for a missing table. */
export function runtimeAdmissionTableExists(
	db: RuntimeAdmissionDb,
	table: keyof typeof TABLE_INFO,
): boolean {
	return db.all(TABLE_INFO[table]).length > 0;
}

export function readRuntimeAdmissionRecord(
	db: RuntimeAdmissionDb,
): string | undefined {
	return db
		.select({ record: runtimeAdmission.record })
		.from(runtimeAdmission)
		.where(eq(runtimeAdmission.id, 1))
		.get()?.record;
}

export function saveRuntimeAdmissionRecord(
	db: RuntimeAdmissionDb,
	record: string,
): void {
	db.insert(runtimeAdmission)
		.values({ id: 1, record })
		.onConflictDoUpdate({ target: runtimeAdmission.id, set: { record } })
		.run();
}

export function findRuntimeAdmissionTurn(
	db: RuntimeAdmissionDb,
	turnId: string,
): string | undefined {
	return db
		.select({ record: runtimeAdmissionTurns.record })
		.from(runtimeAdmissionTurns)
		.where(eq(runtimeAdmissionTurns.id, turnId))
		.get()?.record;
}

export function listRuntimeAdmissionTurnIds(db: RuntimeAdmissionDb): string[] {
	return db
		.select({ id: runtimeAdmissionTurns.id })
		.from(runtimeAdmissionTurns)
		.all()
		.map((row) => row.id);
}

export function insertRuntimeAdmissionTurn(
	db: RuntimeAdmissionDb,
	p: { turnId: string; record: string },
): void {
	db.insert(runtimeAdmissionTurns)
		.values({ id: p.turnId, record: p.record })
		.run();
}

export function updateRuntimeAdmissionTurn(
	db: RuntimeAdmissionDb,
	p: { turnId: string; record: string },
): void {
	db.update(runtimeAdmissionTurns)
		.set({ record: p.record })
		.where(eq(runtimeAdmissionTurns.id, p.turnId))
		.run();
}

export function findRuntimeAdmissionOperation(
	db: RuntimeAdmissionDb,
	operationId: string,
): { input: string; result: string } | undefined {
	return db
		.select({
			input: runtimeAdmissionOperations.input,
			result: runtimeAdmissionOperations.result,
		})
		.from(runtimeAdmissionOperations)
		.where(eq(runtimeAdmissionOperations.id, operationId))
		.get();
}

export function insertRuntimeAdmissionOperation(
	db: RuntimeAdmissionDb,
	p: { operationId: string; input: string; result: string },
): void {
	db.insert(runtimeAdmissionOperations)
		.values({ id: p.operationId, input: p.input, result: p.result })
		.run();
}

export function findRuntimeAdmissionIdentity(
	db: RuntimeAdmissionDb,
	runId: string,
): { record: string; input: string } | undefined {
	return db
		.select({
			record: runtimeAdmissionIdentities.record,
			input: runtimeAdmissionIdentities.input,
		})
		.from(runtimeAdmissionIdentities)
		.where(eq(runtimeAdmissionIdentities.runId, runId))
		.get();
}

/**
 * The accepted input as a list of `{ input }` rows. Receipt snapshots hash
 * this exact shape, so it must stay a row list keyed `input`.
 */
export function listRuntimeAdmissionIdentityInput(
	db: RuntimeAdmissionDb,
	runId: string,
): Array<{ input: string }> {
	return db
		.select({ input: runtimeAdmissionIdentities.input })
		.from(runtimeAdmissionIdentities)
		.where(eq(runtimeAdmissionIdentities.runId, runId))
		.all();
}

export function insertRuntimeAdmissionIdentity(
	db: RuntimeAdmissionDb,
	p: { runId: string; record: string; input: string },
): void {
	db.insert(runtimeAdmissionIdentities).values(p).run();
}

export function findRuntimeAdmissionEvidence(
	db: RuntimeAdmissionDb,
	digest: string,
): { snapshot: string; action: string; claim: string | null } | undefined {
	return db
		.select({
			snapshot: runtimeAdmissionEvidence.snapshot,
			action: runtimeAdmissionEvidence.action,
			claim: runtimeAdmissionEvidence.claim,
		})
		.from(runtimeAdmissionEvidence)
		.where(eq(runtimeAdmissionEvidence.digest, digest))
		.get();
}

/** Whether any evidence was ever recorded; rows are never deleted. */
export function hasRuntimeAdmissionEvidence(db: RuntimeAdmissionDb): boolean {
	return (
		db
			.select({ digest: runtimeAdmissionEvidence.digest })
			.from(runtimeAdmissionEvidence)
			.limit(1)
			.get() !== undefined
	);
}

export function insertRuntimeAdmissionEvidence(
	db: RuntimeAdmissionDb,
	p: { digest: string; action: string; snapshot: string; claim: string | null },
): void {
	db.insert(runtimeAdmissionEvidence).values(p).run();
}

export function findRuntimeAdmissionReceipt(
	db: RuntimeAdmissionDb,
	runId: string,
): string | undefined {
	return db
		.select({ record: runtimeAdmissionReceipts.record })
		.from(runtimeAdmissionReceipts)
		.where(eq(runtimeAdmissionReceipts.runId, runId))
		.get()?.record;
}

/**
 * The receipt as a list of `{ record }` rows. Receipt snapshots hash this
 * exact shape, so it must stay a row list keyed `record`.
 */
export function listRuntimeAdmissionReceipt(
	db: RuntimeAdmissionDb,
	runId: string,
): Array<{ record: string }> {
	return db
		.select({ record: runtimeAdmissionReceipts.record })
		.from(runtimeAdmissionReceipts)
		.where(eq(runtimeAdmissionReceipts.runId, runId))
		.all();
}

export function insertRuntimeAdmissionReceipt(
	db: RuntimeAdmissionDb,
	p: { runId: string; record: string },
): void {
	db.insert(runtimeAdmissionReceipts).values(p).run();
}

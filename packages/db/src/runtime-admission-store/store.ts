/**
 * Runtime admission storage in the tedi runtime Durable Object's SQLite,
 * driven through `drizzle-orm/durable-sqlite`. Queries live in
 * `queries/durable-sqlite/runtime-admission.ts`.
 *
 * Read-only admission guards run on objects that were never admitted and must
 * create nothing, so the migration chain is applied by the first admission
 * write (`ensureRuntimeAdmissionTables`), not when the store is opened.
 */
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { runtimeAdmissionStoreMigrations } from "./migrations";
import { runtimeAdmissionInitialized } from "./schema";

/** Drizzle's own ledger, shared by every store in this object; not in the schema. */
const drizzleMigrations = sqliteTable("__drizzle_migrations", {
	id: integer("id").primaryKey(),
	name: text("name"),
});
const BASELINE = Object.keys(runtimeAdmissionStoreMigrations).sort()[0]!;

export type RuntimeAdmissionDb = ReturnType<typeof drizzle>;
type AdmissionStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

const clients = new WeakMap<AdmissionStorage, RuntimeAdmissionDb>();

/** Drizzle client over the object's storage; creates no tables. */
export function openRuntimeAdmissionStore(
	storage: AdmissionStorage,
): RuntimeAdmissionDb {
	let db = clients.get(storage);
	if (!db) {
		db = drizzle(storage as DurableObjectStorage);
		clients.set(storage, db);
	}
	return db;
}

/**
 * Apply the admission migration chain. Call inside the write transaction that
 * first needs the tables: the migrator's own transaction nests, so a refused
 * write rolls the tables back with everything else and leaves a
 * never-admitted object without them. Once applied, a call only reads the
 * migrations table.
 */
export function ensureRuntimeAdmissionTables(storage: AdmissionStorage): void {
	const db = openRuntimeAdmissionStore(storage);
	const legacyInitialized = initializedBeforeChain(db);
	migrate(db, { migrations: runtimeAdmissionStoreMigrations });
	if (legacyInitialized)
		db.insert(runtimeAdmissionInitialized)
			.values({ id: 1 })
			.onConflictDoNothing()
			.run();
}

/**
 * Before the chain, `runtime_admission` was created only by `initialize`, in
 * the same transaction as its row, so its presence meant initialized. That
 * holds only until this object applies the chain.
 */
function initializedBeforeChain(db: RuntimeAdmissionDb): boolean {
	if (db.all(sql`PRAGMA table_info(runtime_admission)`).length === 0)
		return false;
	if (db.all(sql`PRAGMA table_info(__drizzle_migrations)`).length === 0)
		return true;
	return (
		db
			.select({ id: drizzleMigrations.id })
			.from(drizzleMigrations)
			.where(eq(drizzleMigrations.name, BASELINE))
			.get() === undefined
	);
}

/** Whether `initialize` ever committed in this object, even if its state row is gone. */
export function runtimeAdmissionWasInitialized(
	storage: AdmissionStorage,
): boolean {
	const db = openRuntimeAdmissionStore(storage);
	if (initializedBeforeChain(db)) return true;
	if (
		db.all(sql`PRAGMA table_info(runtime_admission_initialized)`).length === 0
	)
		return false;
	return db.select().from(runtimeAdmissionInitialized).get() !== undefined;
}

/** Record that `initialize` committed; call in its transaction after the tables exist. */
export function markRuntimeAdmissionInitialized(
	storage: AdmissionStorage,
): void {
	openRuntimeAdmissionStore(storage)
		.insert(runtimeAdmissionInitialized)
		.values({ id: 1 })
		.onConflictDoNothing()
		.run();
}

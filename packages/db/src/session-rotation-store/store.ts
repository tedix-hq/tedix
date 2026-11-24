/**
 * A session rotation Durable Object's own SQLite, driven through
 * `drizzle-orm/durable-sqlite`. Queries live in
 * `queries/durable-sqlite/session-rotation.ts`.
 */
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { sessionRotationStoreMigrations } from "./migrations";

export type SessionRotationStoreDb = ReturnType<typeof drizzle>;

export function openSessionRotationStore(
	storage: DurableObjectStorage,
): SessionRotationStoreDb {
	const db = drizzle(storage);
	migrate(db, { migrations: sessionRotationStoreMigrations });
	return db;
}

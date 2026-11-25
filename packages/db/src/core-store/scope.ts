/**
 * Request-scoped core store for Worker entrypoints.
 *
 * `withCoreStore(env, fn, schedule)` opens one `createCoreStore(env)` client
 * for the async scope of `fn` and closes it when `fn` settles. On D1 it is a
 * pass-through: `coreDb`/`coreQueryDb` keep creating the same per-call
 * Drizzle wrappers the factories always did, so default behavior is
 * unchanged.
 *
 * `coreDb(env)` / `coreQueryDb(env)` replace `createDbClient(env.DB)` /
 * `createDbQueryClient(env.DB)` at call sites. Inside a `withCoreStore`
 * scope they return the shared store client; on D1 outside a scope they
 * return a fresh legacy client exactly as before; on Postgres outside a
 * scope they throw, because an unscoped Postgres client has no owner to
 * close it. Every Worker entrypoint (fetch, scheduled, queue, Durable
 * Object methods, Workflow `run`, WorkerEntrypoint RPC) must therefore run
 * its work inside `withCoreStore`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createDbClient, type DbClient } from "../client";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { createCoreStore, type CoreStoreEnv } from "./client";

export interface CoreStoreScope {
	db: DbClient;
	close(): Promise<void>;
}

const storage = new AsyncLocalStorage<CoreStoreScope>();

export function isD1CoreStore(env: CoreStoreEnv): boolean {
	return !env.CORE_STORE || env.CORE_STORE === "d1";
}

/**
 * Run `fn` with one core store client bound to the async context. Postgres
 * clients are per event; `schedule` (normally `ctx.waitUntil`) receives the
 * close promise so it outlives the response, and is awaited inline when no
 * scheduler is supplied.
 */
export async function withCoreStore<T>(
	env: CoreStoreEnv,
	fn: () => T | Promise<T>,
	schedule?: (promise: Promise<unknown>) => void,
): Promise<T> {
	if (isD1CoreStore(env)) return fn();
	const store = createCoreStore(env);
	try {
		return await storage.run({ db: store.db, close: store.close }, fn);
	} finally {
		const closing = store.close();
		if (schedule) schedule(closing);
		else await closing;
	}
}

/** The scoped core client, or a fresh D1 client outside a Postgres scope. */
export function coreDb(env: CoreStoreEnv): DbClient {
	const scope = storage.getStore();
	if (scope) return scope.db;
	if (isD1CoreStore(env)) return createDbClient(env.DB);
	throw new Error(
		"CORE_STORE=postgres database access requires a withCoreStore scope",
	);
}

/** `coreDb` narrowed to the relation-free query surface. */
export function coreQueryDb(env: CoreStoreEnv): DbQueryClient {
	const scope = storage.getStore();
	if (scope) return scope.db as unknown as DbQueryClient;
	if (isD1CoreStore(env)) return createDbQueryClient(env.DB);
	throw new Error(
		"CORE_STORE=postgres database access requires a withCoreStore scope",
	);
}

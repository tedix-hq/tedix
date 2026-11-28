/**
 * Request-scoped core store for Worker entrypoints.
 *
 * `withCoreStore(env, fn, schedule)` opens one `createCoreStore(env)` client
 * for the async scope of `fn` and closes it when `fn` settles. On D1 it
 * binds audit delivery while `coreDb`/`coreQueryDb` keep creating per-call
 * Drizzle wrappers.
 *
 * `coreDb(env)` / `coreQueryDb(env)` replace `createDbClient(env.DB)` /
 * `createDbQueryClient(env.DB)` at call sites. Inside a `withCoreStore`
 * scope they return the shared store client; on D1 outside a scope they
 * return a fresh client with audit delivery bound; on Postgres outside a
 * scope they throw, because an unscoped Postgres client has no owner to
 * close it. Every Worker entrypoint (fetch, scheduled, queue, Durable
 * Object methods, Workflow `run`, WorkerEntrypoint RPC) must therefore run
 * its work inside `withCoreStore`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { configureLogStore, createDbClient, type DbClient } from "../client";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import {
	createCoreStore,
	postgresClientView,
	type CoreStoreEnv,
} from "./client";
import {
	configureAuditDelivery,
	withAuditDelivery,
} from "../queries/audit-delivery-context";

export interface CoreStoreScope {
	db: DbClient;
	close(): Promise<void>;
	/** Background work (waitUntil) that may still query this client. */
	background?: Promise<unknown>[];
}

/**
 * Register background work started inside a Postgres scope, so the scope's
 * client closes once it settles instead of after a fixed delay. A no-op on D1
 * and outside a scope.
 */
export function trackCoreStoreWork(promise: Promise<unknown>): void {
	storage.getStore()?.background?.push(promise);
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
	/** Grace after tracked work; callers that track all waitUntil work pass less. */
	graceMs = UNTRACKED_CLOSE_DELAY_MS,
	/** Route or job name for the scope's query-load log line. */
	label?: string,
): Promise<T> {
	if (isD1CoreStore(env)) return withAuditDelivery(env, fn);
	// A nested scope (an entrypoint wrapping serveFetch, say) reuses the open
	// client instead of holding a second one for the same request.
	if (storage.getStore()) return await fn();
	const store = createCoreStore(env);
	// Audit and telemetry history stays in the LOGS_DB partitions.
	configureLogStore(store.db, env, [], postgresClientView(store.db));
	// Audit writes queue on the core outbox, drained to the organization log
	// store and LOGS_DB, exactly as the D1 delivery bindings do.
	configureAuditDelivery(store.db, env);
	const background: Promise<unknown>[] = [];
	const startedAt = Date.now();
	try {
		return await storage.run(
			{ db: store.db, close: store.close, background },
			fn,
		);
	} finally {
		const queries = store.stats?.queries ?? 0;
		const wallMs = Date.now() - startedAt;
		if (queries >= HEAVY_SCOPE_QUERIES || wallMs >= HEAVY_SCOPE_WALL_MS)
			console.info({
				event: "core_store_scope",
				label: label ?? null,
				queries,
				wallMs,
			});
		if (schedule) {
			// Each open client holds ~190 KB, so a fixed linger multiplied by
			// the request rate ran tedix-api isolates out of memory. Close once
			// the tracked background work settles (it may register more while
			// it runs), after a short grace for work started without tracking.
			schedule(
				(async () => {
					const deadline = Date.now() + BACKGROUND_CLOSE_LIMIT_MS;
					let settled = -1;
					while (settled !== background.length && Date.now() < deadline) {
						settled = background.length;
						await Promise.race([
							Promise.allSettled(background),
							sleep(Math.max(0, deadline - Date.now())),
						]);
					}
					await sleep(graceMs);
				})().finally(() => store.close()),
			);
		} else await store.close();
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scope at or past either threshold logs its query count and wall time. */
const HEAVY_SCOPE_QUERIES = 8;
const HEAVY_SCOPE_WALL_MS = 1_500;

/** Longest a scope's client waits for its tracked background work. */
export const BACKGROUND_CLOSE_LIMIT_MS = 30_000;

/** Grace for callers whose waitUntil work is not tracked (Durable Objects, workflows). */
export const UNTRACKED_CLOSE_DELAY_MS = 3_000;

/** Grace for entrypoints that track every waitUntil promise. */
export const TRACKED_CLOSE_DELAY_MS = 250;

/** The scoped core client, or a fresh D1 client outside a Postgres scope. */
export function coreDb(env: CoreStoreEnv): DbClient {
	const scope = storage.getStore();
	if (scope) return scope.db;
	if (isD1CoreStore(env))
		return configureAuditDelivery(createDbClient(env.DB as D1Database), env);
	throw new Error(
		"CORE_STORE=postgres database access requires a withCoreStore scope",
	);
}

/**
 * The scoped Postgres client when called inside a Postgres withCoreStore
 * scope, else undefined. Lets helpers that still accept a raw D1 binding
 * follow the selected store instead of silently reading D1.
 */
export function scopedCoreQueryDb(): DbQueryClient | undefined {
	return storage.getStore()?.db as unknown as DbQueryClient | undefined;
}

/** `coreDb` narrowed to the relation-free query surface. */
export function coreQueryDb(env: CoreStoreEnv): DbQueryClient {
	const scope = storage.getStore();
	if (scope) return scope.db as unknown as DbQueryClient;
	if (isD1CoreStore(env))
		return configureAuditDelivery(
			createDbQueryClient(env.DB as D1Database),
			env,
		);
	throw new Error(
		"CORE_STORE=postgres database access requires a withCoreStore scope",
	);
}

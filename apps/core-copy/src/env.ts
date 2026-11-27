// The bindings this Worker uses, declared explicitly. `cloudflare.config.ts` is
// their source of truth; ops deploy values supply real ids at deploy time.
export interface Env {
	/** Core D1 database. Read-only: the copy never writes to D1. */
	DB: D1Database;
	/** Postgres target reached through Cloudflare Hyperdrive. */
	HYPERDRIVE: Hyperdrive;
	/** Checkpoint Durable Object namespace: one JSON document per key. */
	COPY_CHECKPOINTS: DurableObjectNamespace;
	/** Shared secret for the admin endpoints (Bearer or x-tedix-core-copy-token). */
	CORE_COPY_ADMIN_TOKEN?: string;
	ENVIRONMENT: string;
	/** EU jurisdiction for the checkpoint Durable Object (worker-kit helper). */
	DO_JURISDICTION?: string;
	GIT_SHA: string;
}

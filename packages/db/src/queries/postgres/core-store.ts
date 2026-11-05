import type { DbClient } from "../../client";

/** Storage planes that may own control-plane state during the clean-cut port. */
export type CoreStorePlane = "platform-d1" | "postgres";

export type CoreStoreBinding<PostgresClient> =
	| { plane: "platform-d1"; db: DbClient }
	| { plane: "postgres"; db: PostgresClient };

export interface CoreStoreClients<PostgresClient> {
	platform: DbClient;
	postgres?: PostgresClient;
}

/**
 * Resolve explicit storage-plane config without silently falling back to D1.
 * The Postgres client stays generic so domain leaves can use the narrowest
 * client supplied by the shared Postgres schema package.
 */
export function resolveCoreStore<PostgresClient>(
	config: { plane: CoreStorePlane },
	clients: CoreStoreClients<PostgresClient>,
): CoreStoreBinding<PostgresClient> {
	if (config.plane === "platform-d1") {
		return { plane: "platform-d1", db: clients.platform };
	}
	if (!clients.postgres) {
		throw new Error(
			"CORE_STORE_UNBOUND: storage-plane config selects postgres but no Postgres client was provided.",
		);
	}
	return { plane: "postgres", db: clients.postgres };
}

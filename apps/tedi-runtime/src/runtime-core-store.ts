import { readReplicaFirst } from "@tedix/db/client";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { coreQueryDb, isD1CoreStore } from "@tedix/db/core-store/scope";
import {
	createDbQueryClient,
	type DbQueryClient,
} from "@tedix/db/query-client";

/** Keep D1 routing reads replica-first; Postgres uses the entrypoint's scoped client. */
export function readRuntimeReplicaFirst<T>(
	env: CoreStoreEnv & { DB: D1Database },
	read: (db: DbQueryClient) => Promise<T>,
): Promise<T> {
	if (!isD1CoreStore(env)) return read(coreQueryDb(env));
	return readReplicaFirst(env.DB, (session) =>
		read(createDbQueryClient(session as D1Database)),
	);
}

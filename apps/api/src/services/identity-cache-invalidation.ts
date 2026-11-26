import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { coreDb, isD1CoreStore } from "@tedix/db/core-store/scope";
import { createDbSession } from "@tedix/db/client";
import { invalidateAuthContextCache } from "@tedix/db/queries/auth-context-cache";

/** Only the named internal service entrypoint exposes this logout fence. */
export async function invalidateIdentityCache(
	request: Request,
	env: CoreStoreEnv,
) {
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const db = isD1CoreStore(env)
		? createDbSession(env.DB as D1Database, undefined, "first-primary").db
		: coreDb(env);
	await invalidateAuthContextCache(db);
	return new Response(null, { status: 204 });
}

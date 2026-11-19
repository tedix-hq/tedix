import { createDbSession } from "@tedix/db/client";
import { invalidateAuthContextCache } from "@tedix/db/queries/auth-context-cache";

/** Only the named internal service entrypoint exposes this logout fence. */
export async function invalidateIdentityCache(
	request: Request,
	env: Pick<CloudflareEnv, "DB">,
) {
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const primary = createDbSession(env.DB, undefined, "first-primary");
	await invalidateAuthContextCache(primary.db);
	return new Response(null, { status: 204 });
}

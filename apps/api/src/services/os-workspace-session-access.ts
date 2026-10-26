import { createDbQueryClient } from "@tedix/db/query-client";
import { z } from "zod";
import { readWorkspaceSessionRole } from "./os-workspace-collaborators";

const inputSchema = z
	.object({
		workspaceId: z.string().min(1),
		userIds: z.array(z.string().min(1)).min(1).max(32),
	})
	.strict();

/** Only InternalEntrypoint routes here; public HTTP cannot assert a socket identity. */
export async function workspaceSessionAccess(
	request: Request,
	env: Pick<CloudflareEnv, "DB">,
) {
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const parsed = inputSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return new Response(null, { status: 400 });
	const database = createDbQueryClient(env.DB);
	const roles = await Promise.all(
		[...new Set(parsed.data.userIds)].map(
			async (userId) =>
				[
					userId,
					await readWorkspaceSessionRole(
						database,
						parsed.data.workspaceId,
						userId,
					),
				] as const,
		),
	);
	return Response.json({ roles: Object.fromEntries(roles) });
}

import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { verifyWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import type { WorkspaceAppHostDO } from "./workspace-app-host-do";

export const WORKSPACE_APP_CALL_PATH = "/__internal/workspace-app/call";

export async function handleWorkspaceAppCall(
	request: Request,
	env: {
		SECRETS_MASTER_KEY: string;
		WORKSPACE_APP_HOST?: DurableObjectNamespace<WorkspaceAppHostDO>;
	},
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (!env.WORKSPACE_APP_HOST)
		return new Response("App runtime unavailable", { status: 503 });
	let input: Parameters<WorkspaceAppHostDO["call"]>[0];
	let session;
	try {
		input = await request.json();
		session = await verifyWorkspaceAppSession(
			env.SECRETS_MASTER_KEY,
			input.session,
		);
	} catch {
		return new Response("Invalid app session", { status: 403 });
	}
	const host = env.WORKSPACE_APP_HOST.getByName(
		`${session.organizationId}:${session.workspaceId}`,
	);
	return Response.json(await host.call(input));
}

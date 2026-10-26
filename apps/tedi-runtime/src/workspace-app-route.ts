import { AppRuntimeFilesSchema } from "@tedix/api-contract/schemas/os-app-runtime";
import { loadAppRuntimeWorker } from "@tedix/api-contract/utils/app-runtime";
import { z } from "zod";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { verifyWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import type { WorkspaceAppHostDO } from "./workspace-app-host-do";

export const WORKSPACE_APP_CALL_PATH = "/__internal/workspace-app/call";
export const WORKSPACE_APP_REVOKE_PATH = "/__internal/workspace-app/revoke";

type WorkspaceAppRouteEnv = {
	SECRETS_MASTER_KEY: string;
	WORKSPACE_APP_HOST?: DurableObjectNamespace<WorkspaceAppHostDO>;
};

const RevokeSchema = z
	.object({
		organizationId: z.string().min(1).max(200),
		workspaceId: z.uuid(),
		principalIds: z.array(z.string().min(1).max(200)).max(500),
		at: z.number().int().positive(),
	})
	.strict();

/** Cut the named principals' live app sessions and restart the workspace's apps. */
export async function handleWorkspaceAppRevoke(
	request: Request,
	env: WorkspaceAppRouteEnv,
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (!env.WORKSPACE_APP_HOST)
		return new Response("App runtime unavailable", { status: 503 });
	const parsed = RevokeSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return new Response("Invalid revocation", { status: 400 });
	const host = env.WORKSPACE_APP_HOST.getByName(
		`${parsed.data.organizationId}:${parsed.data.workspaceId}`,
	);
	return Response.json(await host.revokeSessions(parsed.data));
}

export async function handleWorkspaceAppCall(
	request: Request,
	env: WorkspaceAppRouteEnv,
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

export const WORKSPACE_APP_CLOSE_DRAFT_PATH =
	"/__internal/workspace-app/close-draft";
export async function handleWorkspaceAppCloseDraft(
	request: Request,
	env: WorkspaceAppRouteEnv,
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (!env.WORKSPACE_APP_HOST)
		return new Response("App runtime unavailable", { status: 503 });
	const parsed = z
		.object({
			organizationId: z.string().min(1).max(200),
			workspaceId: z.uuid(),
			gadgetId: z.uuid(),
			proposalId: z.uuid(),
			baseRevisionId: z.uuid(),
			merged: z.boolean(),
		})
		.strict()
		.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return new Response("Invalid draft closure", { status: 400 });
	const host = env.WORKSPACE_APP_HOST.getByName(
		`${parsed.data.organizationId}:${parsed.data.workspaceId}`,
	);
	return Response.json(await host.closeDraft(parsed.data));
}

export const WORKSPACE_APP_VALIDATE_PATH = "/__internal/workspace-app/validate";
/** Fresh, capability-free isolate: no app storage, API binding or outbound network. */
export async function handleWorkspaceAppValidate(
	request: Request,
	env: { LOADER: WorkerLoader },
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	const parsed = z
		.object({
			files: AppRuntimeFilesSchema,
			compatibilityDate: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional(),
		})
		.strict()
		.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return new Response("Invalid app source", { status: 400 });
	try {
		const worker = loadAppRuntimeWorker(
			env.LOADER,
			`validate:${crypto.randomUUID()}`,
			parsed.data.files,
			{ compatibilityDate: parsed.data.compatibilityDate, validation: true },
		);
		return await worker.getEntrypoint().fetch(new Request("https://validate/"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Response(`server.js:1:1: App dry-load failed: ${message}`, {
			status: 400,
		});
	}
}

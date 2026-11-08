/**
 * Platform-admin door to the workspace objects' migration routes.
 *
 * tedix-workspace-do has no public address; the one-shot migration tool
 * reaches it through this Worker's WORKSPACE_RUNTIME service binding. Only a
 * platform administrator may pass, only three route shapes are forwarded,
 * and the workspace Worker's own bearer is attached from this Worker's
 * secret store. Nothing but route shape, status and duration is logged.
 */

export const MIGRATION_PROXY_PREFIX = "/admin/migration/workspaces/";

const ROUTE =
	/^\/admin\/migration\/workspaces\/([^/]+)\/([^/]+)(\/import|\/rows)?$/;

export type MigrationProxyPlan =
	| { kind: "not_proxied" }
	| { kind: "forbidden" }
	| { kind: "method_not_allowed" }
	| { kind: "forward"; path: string; method: "GET" | "POST"; shape: string };

export function isMigrationProxyPath(pathname: string): boolean {
	return pathname.startsWith(MIGRATION_PROXY_PREFIX);
}

/** A platform administrator holds `platform:admin` (or the wildcard). */
export function isPlatformAdminScopes(
	scopes: readonly string[] | undefined,
): boolean {
	return Boolean(scopes?.includes("platform:admin") || scopes?.includes("*"));
}

/** Pure decision: who may pass and which of the three routes this is. */
export function planMigrationProxy(input: {
	method: string;
	pathname: string;
	scopes: readonly string[] | undefined;
}): MigrationProxyPlan {
	const match = input.pathname.match(ROUTE);
	if (!match) return { kind: "not_proxied" };
	if (!isPlatformAdminScopes(input.scopes)) return { kind: "forbidden" };
	const suffix = match[3] ?? "";
	const method = suffix === "" ? "GET" : "POST";
	if (input.method !== method) return { kind: "method_not_allowed" };
	return {
		kind: "forward",
		path: `/migration/workspaces/${match[1]}/${match[2]}${suffix}`,
		method,
		shape: suffix === "" ? "describe" : suffix.slice(1),
	};
}

export interface MigrationProxyEnv {
	WORKSPACE_RUNTIME?: { fetch(request: Request): Promise<Response> };
	MIGRATE_WORKSPACES_TOKEN?: string;
}

const NO_BODY_403 = () => new Response(null, { status: 403 });

/**
 * Forward one admitted call. `scopes` must come from this Worker's own
 * authentication of the request, never from inbound headers.
 */
export async function handleMigrationProxy(
	request: Request,
	env: MigrationProxyEnv,
	scopes: readonly string[] | undefined,
	log: (entry: Record<string, string | number>) => void = (entry) =>
		console.log(JSON.stringify({ event: "migration_proxy", ...entry })),
): Promise<Response> {
	const url = new URL(request.url);
	const plan = planMigrationProxy({
		method: request.method,
		pathname: url.pathname,
		scopes,
	});
	if (plan.kind === "not_proxied") return new Response(null, { status: 404 });
	if (plan.kind === "forbidden") return NO_BODY_403();
	if (plan.kind === "method_not_allowed")
		return new Response(null, { status: 405 });
	const token = env.MIGRATE_WORKSPACES_TOKEN?.trim();
	if (!env.WORKSPACE_RUNTIME || !token) {
		log({ shape: plan.shape, status: 503, durationMs: 0 });
		return new Response(null, { status: 503 });
	}
	const started = Date.now();
	const headers = new Headers({ authorization: `Bearer ${token}` });
	const parts = plan.path.split("/");
	try {
		headers.set("X-Workspace-Org", decodeURIComponent(parts[3]!));
		headers.set("X-Workspace-Id", decodeURIComponent(parts[4]!));
	} catch {
		return new Response(null, { status: 400 });
	}
	const contentType = request.headers.get("content-type");
	if (contentType) headers.set("content-type", contentType);
	const upstream = await env.WORKSPACE_RUNTIME.fetch(
		new Request(`https://workspace.internal${plan.path}`, {
			method: plan.method,
			headers,
			body: plan.method === "POST" ? await request.arrayBuffer() : undefined,
		}),
	);
	log({
		shape: plan.shape,
		status: upstream.status,
		durationMs: Date.now() - started,
	});
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			"content-type":
				upstream.headers.get("content-type") ?? "application/json",
		},
	});
}

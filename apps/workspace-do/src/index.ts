/**
 * Worker entry. Other workers reach a workspace object through the
 * `InternalEntrypoint` service binding (RPC) or by forwarding an HTTP request
 * (WebSocket subscribe, MCP). The public fetch serves health and the
 * token-guarded migration routes.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { readDurableObjectJurisdiction } from "@tedix/worker-kit/durable-objects";
import type { ExportRowsInput, WorkspaceRpc } from "./do";
import type { TurnRequest, WorkspaceEnv, WorkspaceScope } from "./env";

export { TurnFacet, WorkspaceBindingLoopback, WorkspaceDO } from "./do";

function stubFor(env: WorkspaceEnv, scope: WorkspaceScope): WorkspaceRpc {
	return tenantStoreStub(env.WORKSPACE, env, scope) as unknown as WorkspaceRpc;
}

export class InternalEntrypoint extends WorkerEntrypoint<WorkspaceEnv> {
	sendTurn(scope: WorkspaceScope, input: TurnRequest) {
		return stubFor(this.env, scope).sendTurn(scope, input);
	}
	cancelTurn(scope: WorkspaceScope, turnId: string) {
		return stubFor(this.env, scope).cancelTurn(scope, turnId);
	}
	readEvents(
		scope: WorkspaceScope,
		input?: { conversationId?: string | null; after?: number; limit?: number },
	) {
		return stubFor(this.env, scope).readEvents(scope, input);
	}
	readLedger(
		scope: WorkspaceScope,
		conversationId: string,
		input?: { before?: number | null; limit?: number },
	) {
		return stubFor(this.env, scope).readLedger(scope, conversationId, input);
	}
	listConversations(scope: WorkspaceScope) {
		return stubFor(this.env, scope).listConversations(scope);
	}
	readTurn(scope: WorkspaceScope, turnId: string) {
		return stubFor(this.env, scope).readTurn(scope, turnId);
	}
	awaitTurn(scope: WorkspaceScope, turnId: string, timeoutMs: number) {
		return stubFor(this.env, scope).awaitTurn(scope, turnId, timeoutMs);
	}
	readChangeRecords(
		scope: WorkspaceScope,
		query?: { afterSequence?: number; limit?: number; resource?: string },
	) {
		return stubFor(this.env, scope).readChangeRecords(scope, query);
	}
	readMessages(scope: WorkspaceScope, conversationId: string, limit?: number) {
		return stubFor(this.env, scope).readMessages(scope, conversationId, limit);
	}
	decideApproval(
		scope: WorkspaceScope,
		input: {
			approvalId: string;
			decision: "approve" | "deny";
			by: string;
			note?: string;
		},
	) {
		return stubFor(this.env, scope).decideApproval(scope, input);
	}
	/** WebSocket subscribe and MCP: forwarded with the scope headers set by the caller. */
	override fetch(request: Request): Promise<Response> {
		const migration = new URL(request.url).pathname.match(MIGRATION_PATH);
		if (migration) {
			return handleMigration(request, this.env, migration).catch(
				migrationErrorResponse,
			);
		}
		const organizationId = request.headers.get("X-Workspace-Org");
		const workspaceId = request.headers.get("X-Workspace-Id");
		if (!organizationId || !workspaceId)
			return Promise.resolve(
				new Response("X-Workspace-Org and X-Workspace-Id are required", {
					status: 400,
				}),
			);
		return stubFor(this.env, { organizationId, workspaceId }).fetch(request);
	}
}

const MIGRATION_PATH =
	/^\/migration\/workspaces\/([^/]+)\/([^/]+)(\/import|\/rows)?$/;

/** The migration tool's three routes, guarded by `MIGRATE_WORKSPACES_TOKEN`. */
async function handleMigration(
	request: Request,
	env: WorkspaceEnv,
	match: RegExpMatchArray,
): Promise<Response> {
	const token = env.MIGRATE_WORKSPACES_TOKEN?.trim();
	const presented = request.headers
		.get("Authorization")
		?.replace(/^Bearer\s+/i, "")
		.trim();
	if (!token || !presented || presented !== token) {
		return new Response("Unauthorized", { status: 401 });
	}
	// Keep this fence at the worker as well as the importer: an older client
	// must not move customer data through either public or service fetch.
	if (match[3] === "/import" && request.method === "POST") {
		return Response.json(
			{
				code: "MEMORY_MIGRATION_PREREQUISITES_UNPROVEN",
				error:
					"Organization memory authorization parity, a validated full snapshot and historical log coverage must be established before customer data moves",
			},
			{ status: 409 },
		);
	}
	const scope: WorkspaceScope = {
		organizationId: decodeURIComponent(match[1] ?? ""),
		workspaceId: decodeURIComponent(match[2] ?? ""),
	};
	const stub = stubFor(env, scope);
	const route = match[3] ?? "";
	if (route === "" && request.method === "GET") {
		const description = await stub.describe(scope);
		return Response.json({
			...description,
			jurisdiction: readDurableObjectJurisdiction(env) ?? null,
		});
	}
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	const body = (await request.json()) as Record<string, unknown>;
	if (route === "/rows") {
		const input: ExportRowsInput = {
			table: String(body.table ?? ""),
			after: typeof body.after === "string" ? body.after : null,
			limit: Number(body.limit ?? 500),
		};
		return Response.json(await stub.exportRows(scope, input));
	}
	return new Response("Not found", { status: 404 });
}

function migrationErrorResponse(error: unknown): Response {
	return Response.json(
		{ error: error instanceof Error ? error.message : String(error) },
		{ status: 400 },
	);
}

export default {
	async fetch(request: Request, env: WorkspaceEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "workspace-do",
				sha: env.GIT_SHA ?? "unknown",
			});
		}
		const migration = url.pathname.match(MIGRATION_PATH);
		if (migration) {
			return handleMigration(request, env, migration).catch(
				migrationErrorResponse,
			);
		}
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<WorkspaceEnv>;

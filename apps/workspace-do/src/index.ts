/**
 * Worker entry. Other workers reach a workspace object through the
 * `InternalEntrypoint` service binding (RPC) or by forwarding an HTTP request
 * (WebSocket subscribe, MCP). The public fetch serves health and the
 * token-guarded migration routes.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
	OutputOperation,
	OutputQuery,
	OutputQueryResult,
	WorkspaceOutputRuntime,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { readDurableObjectJurisdiction } from "@tedix/worker-kit/durable-objects";
import type { MemoryOwnerScope } from "@tedix/api-contract/schemas/memory-graph";
import type { MemoryOwnerAccess } from "@tedix/db/tenant-store/memory-owner";
import {
	queryOwnedMemory,
	type MemoryOperation,
	type MemoryQuery,
	type MemoryQueryResult,
} from "@tedix/db/queries/memory-graph/tenant-rpc";
import type { ExportRowsInput, WorkspaceRpc } from "./do";
import type { TurnRequest, WorkspaceEnv, WorkspaceScope } from "./env";

export { TurnFacet, WorkspaceBindingLoopback, WorkspaceDO } from "./do";

function stubFor(env: WorkspaceEnv, scope: WorkspaceScope): WorkspaceRpc {
	return tenantStoreStub(env.WORKSPACE, env, scope) as unknown as WorkspaceRpc;
}

export class InternalEntrypoint extends WorkerEntrypoint<WorkspaceEnv> {
	refreshOutputProjection(
		scope: WorkspaceScope,
		outputId: string,
	): Promise<void> {
		return (
			stubFor(this.env, scope) as WorkspaceRpc & WorkspaceOutputRuntime
		).refreshOutputProjection(scope, outputId);
	}
	outputQuery<K extends OutputOperation>(
		scope: WorkspaceScope,
		query: OutputQuery<K>,
	): Promise<OutputQueryResult<K>> {
		return (
			stubFor(this.env, scope) as WorkspaceRpc & WorkspaceOutputRuntime
		).outputQuery(scope, query);
	}
	/** Storage port; the gateway retains operation and per-fact authorization. */
	ownedMemory<K extends MemoryOperation>(
		owner: MemoryOwnerScope,
		access: MemoryOwnerAccess,
		query: MemoryQuery<K>,
	): Promise<MemoryQueryResult<K>> {
		return queryOwnedMemory(
			{
				plane: "do-local-sqlite",
				namespace: this.env.WORKSPACE,
				env: this.env,
			},
			owner,
			access,
			query,
		);
	}

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

/** Blobs travel as `{ "$b64": … }`; everything else is JSON as stored. */
function decodeRow(row: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => {
			if (value && typeof value === "object" && "$b64" in value) {
				const bytes = Uint8Array.from(
					atob(String((value as { $b64: string }).$b64)),
					(c) => c.charCodeAt(0),
				);
				return [key, bytes.buffer];
			}
			return [key, value];
		}),
	);
}

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
	const scope: WorkspaceScope = {
		organizationId: decodeURIComponent(match[1] ?? ""),
		workspaceId: decodeURIComponent(match[2] ?? ""),
	};
	const route = match[3] ?? "";
	if (route === "" && request.method === "GET") {
		const description = await stubFor(env, scope).describe(scope);
		return Response.json({
			...description,
			jurisdiction: readDurableObjectJurisdiction(env) ?? null,
		});
	}
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	const body = (await request.json()) as Record<string, unknown>;
	const stub = () => stubFor(env, scope);
	if (route === "/import") {
		const table = String(body.table ?? "");
		// Organization memory stays in the organization database with its
		// permissions; no client may move it into a workspace.
		if (table.startsWith("memory_"))
			return Response.json(
				{
					code: "ORGANIZATION_MEMORY_STAYS",
					error: `${table} is organization memory and does not move into a workspace`,
				},
				{ status: 409 },
			);
		const rows = Array.isArray(body.rows)
			? (body.rows as Record<string, unknown>[])
			: [];
		return Response.json(
			await stub().importRows(scope, {
				batchId: String(body.batchId ?? ""),
				table,
				rows: rows.map(decodeRow),
			}),
		);
	}
	if (route === "/rows") {
		const input: ExportRowsInput = {
			table: String(body.table ?? ""),
			after: typeof body.after === "string" ? body.after : null,
			limit: Number(body.limit ?? 500),
		};
		return Response.json(await stub().exportRows(scope, input));
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

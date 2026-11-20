import type {
	OsWorkspaceChangeRecordsQuery,
	OsWorkspaceChangeRecordsExport,
} from "@tedix/api-contract/schemas/os-workspace-change-records";
import type { ChangeRecordQuery } from "./adapters";
/**
 * Worker entry. Other workers reach a workspace object through the
 * `InternalEntrypoint` service binding (RPC) or by forwarding an HTTP request
 * (WebSocket subscribe, MCP). The public fetch serves only health.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
	DocumentTransfer,
	DocumentTransferPackage,
	OutputOperation,
	OutputQuery,
	OutputQueryResult,
	WorkspaceOutputRuntime,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { readDurableObjectJurisdiction } from "@tedix/worker-kit/durable-objects";
import { secureEqual } from "@tedix/worker-kit/request-auth";
import type { MemoryOwnerScope } from "@tedix/api-contract/schemas/memory-graph";
import type { MemoryOwnerAccess } from "@tedix/db/tenant-store/memory-owner";
import {
	queryOwnedMemory,
	type MemoryOperation,
	type MemoryQuery,
	type MemoryQueryResult,
} from "@tedix/db/queries/memory-graph/tenant-rpc";
import type { WorkspaceRpc } from "./do";
import type { TurnRequest, WorkspaceEnv, WorkspaceScope } from "./env";

export { TurnFacet, WorkspaceBindingLoopback, WorkspaceDO } from "./do";

function stubFor(env: WorkspaceEnv, scope: WorkspaceScope): WorkspaceRpc {
	return tenantStoreStub(env.WORKSPACE, env, scope) as unknown as WorkspaceRpc;
}

export class InternalEntrypoint extends WorkerEntrypoint<WorkspaceEnv> {
	prepareDocumentTransfer(scope: WorkspaceScope, transfer: DocumentTransfer) {
		return stubFor(this.env, scope).prepareDocumentTransfer(scope, transfer);
	}
	importDocumentTransfer(
		scope: WorkspaceScope,
		payload: DocumentTransferPackage,
	) {
		return stubFor(this.env, scope).importDocumentTransfer(scope, payload);
	}
	confirmDocumentTransfer(scope: WorkspaceScope, transfer: DocumentTransfer) {
		return stubFor(this.env, scope).confirmDocumentTransfer(scope, transfer);
	}
	removeDocumentTransfer(scope: WorkspaceScope, transfer: DocumentTransfer) {
		return stubFor(this.env, scope).removeDocumentTransfer(scope, transfer);
	}
	transferOutput(
		scope: WorkspaceScope,
		outputId: string,
		targetWorkspaceId: string,
	) {
		return stubFor(this.env, scope).transferOutput(
			scope,
			outputId,
			targetWorkspaceId,
		);
	}
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
		// A local run has no jurisdiction; everywhere else a new store must be in the EU.
		if (
			query.op === "initialize" &&
			this.env.ENVIRONMENT !== "development" &&
			readDurableObjectJurisdiction(this.env) !== "eu"
		)
			throw new Error(
				"Empty workspace initialization requires EU jurisdiction",
			);
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
	appendAgentRunNotice(
		scope: WorkspaceScope,
		input: { conversationId: string; attemptId: string; content: string },
	) {
		return stubFor(this.env, scope).appendAgentRunNotice(scope, input);
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
	listConversationTurnIds(scope: WorkspaceScope, conversationId: string) {
		return stubFor(this.env, scope).listConversationTurnIds(
			scope,
			conversationId,
		);
	}
	readTurn(scope: WorkspaceScope, turnId: string) {
		return stubFor(this.env, scope).readTurn(scope, turnId);
	}
	awaitTurn(scope: WorkspaceScope, turnId: string, timeoutMs: number) {
		return stubFor(this.env, scope).awaitTurn(scope, turnId, timeoutMs);
	}
	exportChangeRecords(
		scope: WorkspaceScope,
		query: OsWorkspaceChangeRecordsQuery,
	): Promise<OsWorkspaceChangeRecordsExport> {
		return stubFor(this.env, scope).exportChangeRecords(scope, query);
	}
	readChangeRecords(scope: WorkspaceScope, query?: ChangeRecordQuery) {
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

const LOCAL_SEED_PATH = /^\/local-demo\/workspaces\/([^/]+)\/([^/]+)$/;

/** The local demo launcher's seed call; never served outside development. */
async function seedLocalDemo(
	request: Request,
	env: WorkspaceEnv,
	match: RegExpMatchArray,
): Promise<Response> {
	const token = env.LOCAL_WORKSPACE_SEED_TOKEN?.trim();
	const presented = request.headers
		.get("Authorization")
		?.replace(/^Bearer\s+/i, "")
		.trim();
	if (request.method !== "POST" || !(await secureEqual(presented, token)))
		return new Response("Unauthorized", { status: 401 });
	const scope: WorkspaceScope = {
		organizationId: decodeURIComponent(match[1] ?? ""),
		workspaceId: decodeURIComponent(match[2] ?? ""),
	};
	const tables = (await request.json()) as Record<
		string,
		Record<string, string | number | null>[]
	>;
	return Response.json(await stubFor(env, scope).seedLocalDemo(scope, tables));
}

export default {
	async fetch(request: Request, env: WorkspaceEnv): Promise<Response> {
		const url = new URL(request.url);
		const seed = url.pathname.match(LOCAL_SEED_PATH);
		if (seed && env.ENVIRONMENT === "development")
			return seedLocalDemo(request, env, seed);
		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "workspace-do",
				sha: env.GIT_SHA ?? "unknown",
			});
		}
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<WorkspaceEnv>;

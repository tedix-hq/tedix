import { sweepWorkspaceSchemaVersions } from "./schema-sweep";
import {
	copyGadgetExecutionBody,
	readGadgetExecutionBody,
} from "./gadget-execution-archive";
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
import {
	durableObjectStubByName,
	readDurableObjectJurisdiction,
} from "@tedix/worker-kit/durable-objects";
import type {
	GatewayChangeRecordCheckpointQuery,
	GatewayChangeRecordRangeParams,
	OrganizationLogAppendInput,
	OrganizationLogRuntime,
} from "@tedix/db/queries/durable-sqlite/organization-log-rpc";
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
import {
	workspaceRecoveryScope,
	type WorkspaceRecoveryPhase,
} from "./workspace-recovery-drill";
import { personChatsName, type PersonChatsOwner } from "./person-chats";
import type { AgentRunReport } from "./run-report";
import type { TurnRequest, WorkspaceEnv, WorkspaceScope } from "./env";

export { TurnFacet, WorkspaceBindingLoopback, WorkspaceDO } from "./do";
export { OrganizationLogStore } from "./organization-log";

function stubFor(env: WorkspaceEnv, scope: WorkspaceScope): WorkspaceRpc {
	return tenantStoreStub(env.WORKSPACE, env, scope) as unknown as WorkspaceRpc;
}

function personChatsStub(
	env: WorkspaceEnv,
	owner: PersonChatsOwner,
): WorkspaceRpc {
	return durableObjectStubByName(
		env.WORKSPACE,
		env,
		personChatsName(owner),
	) as unknown as WorkspaceRpc;
}

/**
 * The organization's log store, or undefined while this Worker has no
 * `ORGANIZATION_LOG` binding (appends then answer `forward` and reads
 * `not_live`, and the api fails the call).
 */
function organizationLog(
	env: WorkspaceEnv,
	organizationId: string,
): OrganizationLogRuntime | undefined {
	const namespace = (env as { ORGANIZATION_LOG?: DurableObjectNamespace })
		.ORGANIZATION_LOG;
	if (!namespace) return undefined;
	return durableObjectStubByName(
		namespace,
		env,
		`org:${organizationId}`,
	) as unknown as OrganizationLogRuntime;
}

export class InternalEntrypoint
	extends WorkerEntrypoint<WorkspaceEnv>
	implements OrganizationLogRuntime
{
	/** Internal service binding only; the operator supplies every provider inventory page. */
	sweepOwnSchemaVersions(objectIds: string[]) {
		return sweepWorkspaceSchemaVersions(this.env, objectIds);
	}

	async organizationLogAppend(
		organizationId: string,
		input: OrganizationLogAppendInput,
	) {
		const log = organizationLog(this.env, organizationId);
		return log
			? log.organizationLogAppend(organizationId, input)
			: { status: "forward" as const };
	}
	async organizationLogList(
		organizationId: string,
		query: Parameters<OrganizationLogRuntime["organizationLogList"]>[1],
	) {
		const log = organizationLog(this.env, organizationId);
		return log
			? log.organizationLogList(organizationId, query)
			: { status: "not_live" as const };
	}
	async organizationLogGet(organizationId: string, id: string) {
		const log = organizationLog(this.env, organizationId);
		return log
			? log.organizationLogGet(organizationId, id)
			: { status: "not_live" as const };
	}
	async organizationLogRange(
		organizationId: string,
		range: GatewayChangeRecordRangeParams,
		page: { afterSequence?: number; limit: number },
	) {
		const log = organizationLog(this.env, organizationId);
		return log
			? log.organizationLogRange(organizationId, range, page)
			: { status: "not_live" as const };
	}
	async organizationLogCheckpoints(
		organizationId: string,
		query: GatewayChangeRecordCheckpointQuery,
	) {
		const log = organizationLog(this.env, organizationId);
		return log
			? log.organizationLogCheckpoints(organizationId, query)
			: { status: "not_live" as const };
	}
	async rehearseStorageRecovery(
		organizationId: string,
		agentId: string,
		drillId: string,
		phase: WorkspaceRecoveryPhase,
	) {
		const scope = await workspaceRecoveryScope(
			organizationId,
			agentId,
			drillId,
		);
		return stubFor(this.env, scope).rehearseStorageRecovery(
			scope,
			phase,
			agentId,
			drillId,
		);
	}
	readGadgetExecutionOutput(
		scope: WorkspaceScope,
		executionId: string,
		sha256: string,
	) {
		return stubFor(this.env, scope).readGadgetExecutionOutput(
			scope,
			executionId,
			sha256,
		);
	}
	copyGadgetExecutionOutput(
		scope: WorkspaceScope,
		executionId: string,
		output: string,
	) {
		return stubFor(this.env, scope).copyGadgetExecutionOutput(
			scope,
			executionId,
			output,
		);
	}
	async archiveDetachedGadgetExecutionOutput(
		scope: WorkspaceScope,
		executionId: string,
		output: string | null,
		sha256: string,
	) {
		const bucket = this.env.R2_BUCKET;
		if (output === null) {
			await readGadgetExecutionBody(bucket, scope, executionId, sha256);
		} else if (
			(await copyGadgetExecutionBody(bucket, scope, executionId, output))
				.sha256 !== sha256
		) {
			throw new Error("Workspace execution output digest changed");
		}
		return sha256;
	}
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
	reportAgentRun(scope: WorkspaceScope, report: AgentRunReport) {
		return stubFor(this.env, scope).reportAgentRun(scope, report);
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
	rebuildPersonChats(scope: WorkspaceScope, previousUserIds?: string[]) {
		return stubFor(this.env, scope).rebuildPersonChats(scope, previousUserIds);
	}
	/** One person's workspace chats for Home; the api checks access per workspace. */
	listPersonChats(owner: PersonChatsOwner, limit?: number) {
		return personChatsStub(this.env, owner).listPersonChats(owner, limit);
	}
	forgetPersonChatWorkspace(owner: PersonChatsOwner, workspaceId: string) {
		return personChatsStub(this.env, owner).forgetPersonChatWorkspace(
			owner,
			workspaceId,
		);
	}
	hasConversation(scope: WorkspaceScope, conversationId: string) {
		return stubFor(this.env, scope).hasConversation(scope, conversationId);
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
			likeThis?: boolean;
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

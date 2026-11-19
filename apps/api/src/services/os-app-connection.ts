import { call } from "@orpc/server";
import { z } from "zod";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import {
	PersonalResourceToolBindingSchema,
	resolveToolAnnotations,
	type ToolConfig,
} from "@tedix/api-contract/schemas/tools";
import type { WorkspaceConnectionActor } from "@tedix/api-contract/schemas/workspace-connection-read";
import type { WorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { getAppByIdWithToolsForOrganization } from "@tedix/db/queries/app-records";
import {
	getConnectionInstance,
	listConnectionInstances,
} from "@tedix/db/queries/connection-instances";
import {
	createOsGadgetExecution,
	settleOsAppCallExecution,
} from "@tedix/db/queries/os-workspaces/executions";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { requestFirstPartyMcp } from "../lib/first-party-mcp";
import { canonicalDigest } from "../lib/blueprint-digest";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";
import {
	evaluateOwnAccess,
	ownAccessRefusal,
	type OwnAccessEvaluation,
} from "./connection-access-check";

type ConnectionInstanceRow = NonNullable<
	Awaited<ReturnType<typeof getConnectionInstance>>
>;

const inputSchema = z.strictObject({
	appId: z.string().min(1),
	toolId: z.string().min(1),
	arguments: z.record(z.string(), JsonValueSchema),
	approvalRequestId: z.uuid().optional(),
});

type ConnectionCaller =
	| { kind: "app"; session: WorkspaceAppSession }
	| {
			kind: "agent";
			workspaceId: string;
			conversationId: string;
			actor: WorkspaceConnectionActor;
	  };

/** Keeps the app's refusal text while allowing the agent to offer the right connect link. */
export class WorkspaceConnectionNotConnected extends Error {}

function refuse(): never {
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Connection call is not permitted for this slot",
	);
}

/**
 * The account a call runs on belongs to the person the session acts as.
 * A personal slot resolves from that person's own connected accounts for the
 * provider, never from the workspace owner's; an organization slot resolves
 * from the organization account the slot is bound to, as policy allows.
 */
async function resolveActingAccount(
	db: BaseContext["db"],
	actingUserId: string | null,
	resource: OsWorkspaceResourceRow,
): Promise<ConnectionInstanceRow> {
	if (resource.connectionScope !== "user") {
		const account = await getConnectionInstance(
			db,
			{ organizationId: resource.organizationId },
			resource.connectionInstanceId!,
			resource.providerId,
		);
		if (!account?.tokenIds.length || !account.tokenSub)
			throw new WorkspaceConnectionNotConnected(
				"Connection call is not permitted for this slot",
			);
		return account;
	}
	if (!actingUserId) refuse();
	if (resource.personalOwnerUserId === actingUserId) {
		const account = await getConnectionInstance(
			db,
			{ userId: actingUserId },
			resource.connectionInstanceId!,
			resource.providerId,
		);
		if (!account?.tokenIds.length || !account.tokenSub)
			throw new WorkspaceConnectionNotConnected(
				"Connection call is not permitted for this slot",
			);
		return account;
	}
	const own = (
		await listConnectionInstances(db, { userId: actingUserId })
	).find(
		(row) =>
			row.providerId === resource.providerId &&
			row.tokenIds.length > 0 &&
			row.tokenSub,
	);
	if (!own)
		throw new WorkspaceConnectionNotConnected(
			`This slot reads a personal ${resource.providerId} account. Connect your own ${resource.providerId} account to use it; the workspace owner's account is never used on your behalf.`,
		);
	return own;
}

/**
 * The app's Runs tab lists one observation receipt per connection read. It
 * records who read which slot through which account and what the access check
 * found, never the provider data itself.
 */
function observationReceipt(
	context: BaseContext,
	caller: ConnectionCaller,
	resource: OsWorkspaceResourceRow,
	read: { appSlug: string; toolId: string; actingUserId: string | null },
	access: OwnAccessEvaluation,
) {
	return {
		id: crypto.randomUUID(),
		organizationId: resource.organizationId,
		workspaceId: resource.workspaceId,
		// Agent observations use a conversation namespace; there is no gadget FK.
		gadgetId:
			caller.kind === "app"
				? caller.session.gadgetId
				: `conversation:${caller.conversationId}`,
		...(caller.kind === "app"
			? {
					revisionId: caller.session.revisionId,
					revision: caller.session.revision,
				}
			: {}),
		input: JSON.stringify({
			kind: "connection_observation",
			...(caller.kind === "agent"
				? { conversationId: caller.conversationId, actor: caller.actor }
				: {}),
			appSlug: read.appSlug,
			toolId: read.toolId,
			slot: resource.slot,
			providerId: resource.providerId,
			resourceType: resource.resourceType,
			providerResourceId: resource.providerResourceId,
			resourceName: resource.name,
			account:
				resource.connectionScope === "user" ? "personal" : "organization",
			actingUserId: read.actingUserId,
			checkEachPersonsAccess: access.setting,
			ownAccess: access.outcome,
			mode: access.mode,
			wouldDeny: access.wouldDeny,
			containsRestrictedData: access.containsRestrictedData,
		}),
		grantedCapabilities: JSON.stringify(["connections.read"]),
		policyDecision: JSON.stringify({
			allowed: !access.denied,
			reasons: [
				"connection_observation",
				`own_access:${access.outcome}`,
				...(access.wouldDeny
					? [access.denied ? "own_access:denied" : "own_access:would_deny"]
					: []),
			],
		}),
		createdByKind: read.actingUserId ? ("user" as const) : ("service" as const),
		createdById:
			read.actingUserId ??
			(caller.kind === "agent"
				? `workspace-agent:${caller.conversationId}`
				: ""),
		runtimeEnvironment: context.env.ENVIRONMENT,
	};
}

/** App sessions retain their existing actor and preview boundary. */
export async function callWorkspaceAppConnection(
	context: BaseContext,
	session: WorkspaceAppSession,
	resource: OsWorkspaceResourceRow,
	input: unknown,
) {
	try {
		return await callWorkspaceResourceConnection(
			context,
			{ kind: "app", session },
			resource,
			input,
		);
	} catch (error) {
		if (error instanceof WorkspaceConnectionNotConnected)
			throw createError(ErrorCodes.FORBIDDEN, error.message);
		throw error;
	}
}

/** All resource, tool, argument, account, access and dispatch checks live here. */
export async function callWorkspaceResourceConnection(
	context: BaseContext,
	caller: ConnectionCaller,
	resource: OsWorkspaceResourceRow,
	input: unknown,
) {
	const args = inputSchema.parse(input);
	if (caller.kind === "app") {
		const session = caller.session;
		if (
			context.authType !== "user" ||
			!context.user?.sub ||
			session.principal.kind !== "user" ||
			session.principal.id !== context.user.sub ||
			session.actorUserId !== context.user.sub ||
			!["build", "owner"].includes(session.role) ||
			session.previewId
		)
			refuse();
	}
	const workspaceId =
		caller.kind === "app" ? caller.session.workspaceId : caller.workspaceId;
	const actingUserId =
		caller.kind === "app"
			? (context.user?.sub ?? null)
			: caller.actor.kind === "user"
				? caller.actor.id
				: null;
	if (
		resource.organizationId !== context.organizationId ||
		resource.workspaceId !== workspaceId ||
		resource.status !== "active" ||
		!resource.connectionInstanceId ||
		resource.providerId === "tedix" ||
		!["user", "tenant"].includes(resource.connectionScope)
	)
		refuse();
	if (!actingUserId && resource.connectionScope === "user")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Personal accounts require a turn started by a signed-in person. Scheduled and tedi-started turns may use only organization accounts.",
		);
	const surface = await getAppByIdWithToolsForOrganization(
		context.db,
		args.appId,
		resource.organizationId,
	);
	const tool = surface?.tools.find(
		(row) => row.enabled && row.toolId === args.toolId,
	);
	const annotations = tool ? resolveToolAnnotations(tool) : undefined;
	const config = tool?.config as ToolConfig | null | undefined;
	if (
		resource.providerId === "google-drive" &&
		annotations?.readOnlyHint !== true &&
		resource.providerAccess?.canWrite !== true
	)
		throw createError(ErrorCodes.FORBIDDEN, "This Drive resource is read-only");
	const auth = config?.auth;
	const routing = surface?.app.metadata?.mcpConfig;
	if (
		!surface ||
		!tool ||
		!config ||
		!["external", "mcp"].includes(config.transport ?? "") ||
		config.connectionReadOnly !== true ||
		annotations?.readOnlyHint !== true ||
		annotations?.destructiveHint === true ||
		auth?.type !== "connection" ||
		auth.connectionId !== resource.providerId ||
		routing?.connectionProviderId !== resource.providerId ||
		routing.connectionInstanceId !== resource.connectionInstanceId ||
		routing.connectionScope !== resource.connectionScope
	)
		refuse();
	const scopes = z
		.array(z.string().trim().min(1))
		.max(50)
		.parse(JSON.parse(resource.requiredScopes));
	if (
		JSON.stringify([...new Set(auth.scopes ?? [])].sort()) !==
			JSON.stringify([...new Set(scopes)].sort()) ||
		resource.providerAccess?.canRead === false
	)
		refuse();
	// A reviewed path mapping must bind every provider resource argument to this slot.
	// Account-wide tools without such a mapping remain unavailable.
	const binding = PersonalResourceToolBindingSchema.parse(
		config.personalResourceBinding,
	);
	if (
		binding.resourceType !== resource.resourceType ||
		binding.operation !== "read" ||
		!("paths" in binding)
	)
		refuse();
	function checkPath(value: unknown, path: string[]): void {
		if (!path.length) {
			if (value !== resource.providerResourceId) refuse();
			return;
		}
		const [head, ...tail] = path;
		if (head === "*") {
			if (!Array.isArray(value) || !value.length || value.length > 50) refuse();
			for (const item of value) checkPath(item, tail);
			return;
		}
		if (
			!head ||
			["__proto__", "constructor", "prototype"].includes(head) ||
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			!Object.hasOwn(value, head)
		)
			refuse();
		checkPath((value as Record<string, unknown>)[head], tail);
	}
	for (const path of binding.paths) checkPath(args.arguments, path);
	const account = await resolveActingAccount(
		context.db,
		actingUserId,
		resource,
	);
	const access = await evaluateOwnAccess(context, actingUserId, resource);
	const receipt = observationReceipt(
		context,
		caller,
		resource,
		{ appSlug: surface.app.slug, toolId: tool.toolId, actingUserId },
		access,
	);
	const db = createDbQueryClient(context.env.DB);
	if (access.denied) {
		const message = ownAccessRefusal(resource.providerId, access.outcome);
		await createOsGadgetExecution(db, {
			...receipt,
			status: "denied",
			error: message,
			completedAt: new Date().toISOString(),
		});
		throw createError(ErrorCodes.FORBIDDEN, message);
	}
	const effectiveConfig = {
		...config,
		auth: {
			...auth,
			connectionInstanceId: account.id,
			credentialScope: resource.connectionScope,
		},
	};
	const { MCP_SERVICE, MCP_URL } = context.env;
	if (!MCP_SERVICE || !MCP_URL)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"MCP service unavailable",
		);
	const { mcpGovernanceContractRouter } =
		await import("../rpc/routers/mcp-governance");
	const configHash = await sha256Hex(JSON.stringify(effectiveConfig));
	const approval = await call(
		mcpGovernanceContractRouter.requestOwnerToolApproval,
		{
			organizationId: resource.organizationId,
			...(actingUserId ? { userId: actingUserId } : {}),
			appSlug: surface.app.slug,
			toolId: tool.toolId,
			target: {
				transport: config.transport ?? "",
				configHash,
				workspaceId: resource.workspaceId,
				...(caller.kind === "app"
					? {
							gadgetId: caller.session.gadgetId,
							revisionId: caller.session.revisionId,
							slot: resource.slot,
						}
					: { conversationId: caller.conversationId, actor: caller.actor }),
				resourceHash: await canonicalDigest(resource),
				accountHash: await canonicalDigest(account),
			},
			args: args.arguments,
			...(args.approvalRequestId
				? { approvalRequestId: args.approvalRequestId }
				: {}),
		},
		{
			context: {
				...context,
				authType: "service-binding",
				workspaceConnectionRead:
					caller.kind === "agent"
						? { actor: caller.actor, toolRowId: tool.id }
						: undefined,
				headers: new Headers({ "X-Service-Binding": "true" }),
			},
		},
	);
	if (!approval.approved) return JsonValueSchema.parse({ approval });
	await createOsGadgetExecution(db, { ...receipt, status: "running" });
	const receiptScope = {
		organizationId: resource.organizationId,
		executionId: receipt.id,
	};
	// The gateway resolves and checks live credentials; they never enter this adapter.
	const result = await requestFirstPartyMcp(
		{
			url: `${MCP_URL}/mcp`,
			clientName: "tedix-workspace-app",
			fetch: (url, init) => MCP_SERVICE.fetch(url, init),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": resource.organizationId,
				"X-Tedix-Host": `${surface.app.slug}.${new URL(MCP_URL).hostname}`,
				...(actingUserId ? { "X-Tedix-Acting-User": actingUserId } : {}),
				"X-Tedix-Kernel": "true",
				"X-Tedix-Tedi-Scopes": "connections.read",
			},
		},
		"tools/call",
		{
			name: tool.toolId,
			arguments: args.arguments,
			_meta: {
				"tedix/expectedToolConfig": configHash,
				"tedix/expectedConnection": {
					providerId: resource.providerId,
					connectionInstanceId: account.id,
					scope: resource.connectionScope,
					scopes: auth.scopes ?? [],
				},
			},
		},
	).catch(async (error: unknown) => {
		await settleOsAppCallExecution(db, {
			...receiptScope,
			status: "failed",
			error: "Connection read failed",
		});
		throw error;
	});
	const failed =
		typeof result === "object" &&
		result !== null &&
		(result as { isError?: unknown }).isError === true;
	await settleOsAppCallExecution(db, {
		...receiptScope,
		status: failed ? "failed" : "completed",
		...(failed ? { error: "Provider reported an error" } : {}),
	});
	// Retain human-required protocol results; never answer elicitation or open consent.
	return JsonValueSchema.parse(result);
}

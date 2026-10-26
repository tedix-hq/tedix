import { call } from "@orpc/server";
import { z } from "zod";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import {
	PersonalResourceToolBindingSchema,
	resolveToolAnnotations,
	type ToolConfig,
} from "@tedix/api-contract/schemas/tools";
import type { WorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { getAppByIdWithToolsForOrganization } from "@tedix/db/queries/app-records";
import {
	getConnectionInstance,
	listConnectionInstances,
} from "@tedix/db/queries/connection-instances";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";

type ConnectionInstanceRow = NonNullable<
	Awaited<ReturnType<typeof getConnectionInstance>>
>;
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { requestFirstPartyMcp } from "../lib/first-party-mcp";
import { canonicalDigest } from "../lib/blueprint-digest";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";

const inputSchema = z.strictObject({
	appId: z.string().min(1),
	toolId: z.string().min(1),
	arguments: z.record(z.string(), JsonValueSchema),
	approvalRequestId: z.uuid().optional(),
});

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
	actingUserId: string,
	resource: OsWorkspaceResourceRow,
): Promise<ConnectionInstanceRow> {
	if (resource.connectionScope !== "user") {
		const account = await getConnectionInstance(
			db,
			{ organizationId: resource.organizationId },
			resource.connectionInstanceId!,
			resource.providerId,
		);
		if (!account?.tokenIds.length || !account.tokenSub) refuse();
		return account;
	}
	if (resource.personalOwnerUserId === actingUserId) {
		const account = await getConnectionInstance(
			db,
			{ userId: actingUserId },
			resource.connectionInstanceId!,
			resource.providerId,
		);
		if (!account?.tokenIds.length || !account.tokenSub) refuse();
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
		throw createError(
			ErrorCodes.FORBIDDEN,
			`This slot reads a personal ${resource.providerId} account. Connect your own ${resource.providerId} account to use it; the workspace owner's account is never used on your behalf.`,
		);
	return own;
}

/** Only reviewed, resource-bound reads are supported; effectful tools retain their human boundary. */
export async function callWorkspaceAppConnection(
	context: BaseContext,
	session: WorkspaceAppSession,
	resource: OsWorkspaceResourceRow,
	input: unknown,
) {
	const args = inputSchema.parse(input);
	if (
		context.authType !== "user" ||
		!context.user?.sub ||
		session.principal.kind !== "user" ||
		session.principal.id !== context.user.sub ||
		session.actorUserId !== context.user.sub ||
		!["build", "owner"].includes(session.role) ||
		session.previewId ||
		resource.organizationId !== context.organizationId ||
		resource.workspaceId !== session.workspaceId ||
		resource.status !== "active" ||
		!resource.connectionInstanceId ||
		resource.providerId === "tedix"
	)
		refuse();
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
		context.user.sub,
		resource,
	);
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
			userId: context.user.sub,
			appSlug: surface.app.slug,
			toolId: tool.toolId,
			target: {
				transport: config.transport ?? "",
				configHash,
				workspaceId: resource.workspaceId,
				gadgetId: session.gadgetId,
				revisionId: session.revisionId,
				slot: resource.slot,
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
				headers: new Headers({ "X-Service-Binding": "true" }),
			},
		},
	);
	if (!approval.approved) return JsonValueSchema.parse({ approval });
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
				"X-Tedix-Acting-User": context.user.sub,
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
	);
	// Retain human-required protocol results; never answer elicitation or open consent.
	return JsonValueSchema.parse(result);
}

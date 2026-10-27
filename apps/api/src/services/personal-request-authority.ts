import { enforceConnectionConsumerGrants } from "../rpc/routers/connections/consumer-grant-resolution";
import {
	personalResourceScopesCover,
	reviewedPersonalAccountName,
	reviewedPersonalResourceReadScopes,
} from "@tedix/api-contract/utils/personal-resource-tool-binding";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { getPersonalRequestConsent } from "@tedix/db/queries/personal-request-consent";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getSubmissionById } from "@tedix/db/queries/runtime-submissions/read-models";
import { getToolByAppAndToolIdForOrganization } from "@tedix/db/queries/tools";
import {
	getAppByIdForOrganization,
	getAppMetadataJson,
} from "@tedix/db/queries/app-records";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	fetchConnectionToken,
	fetchConnectionTokenByScopes,
} from "@tedix/auth/connections";
import { insertKernelRuntimeEventIfAbsent } from "@tedix/db/queries/kernel-runtime-events";
import { insertTediRuntimeEvent } from "@tedix/db/queries/cognitive-runtime";
import { getDescopeManagement } from "../lib/descope-management";
import { fetchNamedConnection } from "../rpc/routers/connections/policy-resolution";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";

const REQUEST_TTL_MS = 15 * 60 * 1000;

/** Resolve only server-stored, unrestricted links; every hop stays organization-scoped. */
async function resolveRequestTool(
	db: BaseContext["db"],
	input: { organizationId: string; appId: string; toolId: string },
) {
	let { appId, toolId } = input;
	const visited = new Set<string>();
	for (let hops = 0; hops < 8; hops++) {
		const key = `${appId}:${toolId}`;
		if (visited.has(key)) return;
		visited.add(key);
		const tool = await getToolByAppAndToolIdForOrganization(db, {
			organizationId: input.organizationId,
			appId,
			toolId,
		});
		if (tool) return tool;
		const app = await getAppByIdForOrganization(
			db,
			appId,
			input.organizationId,
		);
		if (!app) return;
		const links = getAppMetadataJson(app)?.mcpConfig?.aggregateApps;
		if (!Array.isArray(links)) return;
		const namespaced = toolId.includes("__");
		const candidates = links.flatMap((link) => {
			if (
				!isRecord(link) ||
				typeof link.appId !== "string" ||
				link.toolIds !== undefined ||
				link.endpointPrefixes !== undefined
			)
				return [];
			const prefix = link.prefix ?? link.slug;
			if (namespaced) {
				if (typeof prefix !== "string" || !toolId.startsWith(`${prefix}__`))
					return [];
				return [{ appId: link.appId, toolId: toolId.slice(prefix.length + 2) }];
			}
			return link.appId === app.sourceAppId
				? [{ appId: link.appId, toolId }]
				: [];
		});
		if (candidates.length !== 1) return;
		({ appId, toolId } = candidates[0]!);
	}
}

/** Only authenticated human ingress can mint consent; metadata and acting-user headers cannot. */
export async function admitPersonalRequest(
	context: BaseContext,
	input: {
		organizationId: string;
		runId: string;
		conversationId: string;
		tediId?: string;
		createdAt: string;
	},
) {
	if (
		context.authType !== "user" ||
		context.tediId ||
		context.externalAgentPrincipalId ||
		!context.user?.sub
	)
		return;
	const requesterUserId = context.descopeUserId ?? context.user.sub;
	await insertAuditEvent(context.db, {
		id: `personal-request:${input.organizationId}:${input.runId}`,
		organizationId: input.organizationId,
		actorId: requesterUserId,
		actorType: "user",
		action: "personal.request.admitted",
		resourceType: "run",
		resourceId: input.runId,
		ignoreDuplicates: true,
		metadata: {
			requesterUserId,
			rootRunId: input.runId,
			conversationId: input.conversationId,
			tediId: input.tediId ?? null,
			expiresAt: new Date(
				Date.parse(input.createdAt) + REQUEST_TTL_MS,
			).toISOString(),
		},
	});
	const admitted = await getPersonalRequestConsent(
		context.db,
		input.organizationId,
		input.runId,
	);
	if (
		!admitted ||
		admitted.actorId !== requesterUserId ||
		admitted.metadata?.conversationId !== input.conversationId ||
		(admitted.metadata?.tediId ?? null) !== (input.tediId ?? null)
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"This request id already belongs to a different requester or run",
		);
	return true;
}

/** A run id is a lookup key. Persisted consent and an active dispatch supply authority. */
export async function resolveRequestPersonalCredential(
	context: BaseContext,
	input: {
		organizationId: string;
		tediId: string;
		providerId: string;
		connectionInstanceId?: string;
		userId?: string;
		appId?: string;
		scope?: "tenant" | "user" | "hybrid";
	},
) {
	const runId = context.headers.get("X-Tedix-Request-Run-Id");
	if (!runId) return null;
	const deny = (message: string): never => {
		throw createError(ErrorCodes.FORBIDDEN, message);
	};
	if (
		context.authType !== "service-binding" ||
		context.tediId !== input.tediId ||
		context.headers.has("X-Tedix-Skill-Run-Id")
	)
		return deny(
			"Personal request reads require the authenticated answering tedi",
		);
	const rootRunId = context.headers.get("X-Tedix-Request-Root-Run-Id") ?? runId;
	const consent = await getPersonalRequestConsent(
		context.db,
		input.organizationId,
		rootRunId,
	);
	// No request admission means the existing background/tenant policy still applies.
	if (!consent) return null;
	const grant = consent.metadata;
	const userId = consent.actorId;
	if (
		!grant ||
		!userId ||
		grant.requesterUserId !== userId ||
		grant.rootRunId !== rootRunId ||
		typeof grant.conversationId !== "string" ||
		typeof grant.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(grant.expiresAt)) ||
		Date.parse(grant.expiresAt) <= Date.now() ||
		Date.parse(grant.expiresAt) - consent.timestamp.getTime() >
			REQUEST_TTL_MS + 1000 ||
		(input.userId && input.userId !== userId)
	)
		return deny("No unexpired consent from this request's account owner");
	const validateRun = async () => {
		let home: Awaited<ReturnType<typeof getKernelRuntimeRun>> = undefined;
		if (grant.tediId) {
			if (grant.tediId !== input.tediId || rootRunId !== runId)
				return deny("Personal request belongs to another tedi or run");
			const submission = await getSubmissionById(
				context.db,
				`sub:${runId}`,
				input.organizationId,
			);
			if (
				!submission ||
				submission.tediId !== input.tediId ||
				submission.runId !== runId ||
				submission.status !== "running"
			)
				return deny("Personal request run is no longer active");
		} else {
			home = await getKernelRuntimeRun(context.db, {
				id: rootRunId,
				organizationId: input.organizationId,
			});
			const workItemId = context.headers.get("X-Tedix-Request-Work-Item-Id");
			const plan = home?.metadata?.homePlan;
			const assignments =
				plan && typeof plan === "object" && !Array.isArray(plan)
					? plan.assignments
					: null;
			const dispatched =
				home?.delegatedTediId === input.tediId &&
				home.childRunId === runId &&
				home.metadata?.workItemId === workItemId;
			const planned =
				Array.isArray(assignments) &&
				assignments.some(
					(value) =>
						value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						value.ownerTediId === input.tediId &&
						value.childRunId === runId &&
						value.workItemId === workItemId &&
						(value.status === "queued" || value.status === "running") &&
						typeof value.dispatchedAt === "string" &&
						Boolean(value.dispatchedAt),
				);
			if (
				!home ||
				!["queued", "running"].includes(home.status) ||
				!workItemId ||
				(!dispatched && !planned)
			)
				return deny("Personal request does not admit this delegated run");
		}

		return home;
	};
	await validateRun();
	const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
	if (!toolId || !input.appId)
		return deny("Personal request reads require an exact installed tool");
	const tool = await resolveRequestTool(context.db, {
		organizationId: input.organizationId,
		appId: input.appId,
		toolId,
	});
	const scopes = tool?.enabled
		? reviewedPersonalResourceReadScopes(
				input.providerId,
				tool.config?.mcpToolName,
			)
		: undefined;
	// Custom installed bindings never expand the server-reviewed read allowlist.
	if (!scopes) {
		if (input.scope === "hybrid") return null;
		return deny("This tool is not a reviewed personal-account read");
	}
	const instance = input.connectionInstanceId
		? await getConnectionInstance(
				context.db,
				{ userId },
				input.connectionInstanceId,
				input.providerId,
			)
		: undefined;
	if (input.connectionInstanceId && !instance)
		return deny("This personal account does not belong to the requester");
	await enforceConnectionConsumerGrants(context, {
		organizationId: input.organizationId,
		providerId: input.providerId,
		connectionInstanceId: input.connectionInstanceId,
		personalUserId: userId,
	});
	const scopedToken = input.connectionInstanceId
		? await fetchNamedConnection(
				context,
				{ userId },
				input.providerId,
				input.connectionInstanceId,
			)
		: await fetchConnectionTokenByScopes(
				getDescopeManagement(context.env, true),
				input.providerId,
				userId,
				scopes,
			);
	// The vault's exact-scope lookup can miss a broader Calendar read grant.
	// Coverage is checked locally, still against this requester's exact account.
	const defaultAccount =
		!instance && (!scopedToken || !scopedToken.tokenSub)
			? await fetchConnectionToken(
					getDescopeManagement(context.env, true),
					input.providerId,
					userId,
				)
			: null;
	const token = scopedToken ?? defaultAccount;
	if (!token && input.scope === "hybrid" && !input.connectionInstanceId)
		return null;
	if (
		!token ||
		token.reconnectNeeded ||
		!personalResourceScopesCover(token.scopes ?? [], scopes)
	)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"The requester's personal account needs connection or reconnection with read access",
		);
	if (Date.parse(grant.expiresAt) <= Date.now())
		return deny("Personal request expired during credential lookup");
	const home = await validateRun();
	const accountLabel =
		instance?.label ??
		token.tokenSub ??
		(defaultAccount?.id === token.id ? defaultAccount?.tokenSub : undefined);
	const account = accountLabel ?? token.id ?? input.providerId;
	const notice = `Read your ${reviewedPersonalAccountName(input.providerId) ?? input.providerId}${accountLabel ? ` (${accountLabel})` : ""} for this request`;
	const use = {
		requesterUserId: userId,
		tediId: input.tediId,
		rootRunId,
		runId,
		providerId: input.providerId,
		connectionInstanceId: input.connectionInstanceId ?? null,
		account,
		tokenId: token.id ?? null,
		toolId,
		scopes,
		notice,
	};
	// Audit is awaited before handing the token to MCP. Each call is checked and recorded afresh.
	await insertAuditEvent(context.db, {
		organizationId: input.organizationId,
		actorType: "tedi",
		actorId: input.tediId,
		action: "personal.request.read",
		resourceType: "connection",
		resourceId: input.connectionInstanceId ?? token.id ?? input.providerId,
		metadata: use,
	});
	const event = {
		id: crypto.randomUUID(),
		organizationId: input.organizationId,
		kind: "context.injected" as const,
		runId: rootRunId,
		payload: { personalAccountRead: use, content: notice },
		runtimeBackend: "cloudflare-agents" as const,
		createdAt: new Date().toISOString(),
	};
	if (home)
		await insertKernelRuntimeEventIfAbsent(context.db, {
			...event,
			conversationId: home.conversationId,
			delegatedTediId: input.tediId,
			childRunId: runId,
		});
	else
		await insertTediRuntimeEvent(context.db, {
			...event,
			tediId: input.tediId,
			conversationId: grant.conversationId,
		});
	return { accessToken: token.accessToken, scopes };
}

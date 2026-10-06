import { personalResourceScopesCover } from "@tedix/api-contract/utils/personal-resource-tool-binding";
import {
	OsDerivedAccessEnvelopeSchema,
	OsDerivedResourceAccessSchema,
	type OsDerivedAccessEnvelope,
} from "@tedix/api-contract/schemas/os-workspaces";
import { getProviderEventSubscription } from "@tedix/db/queries/provider-events";
import type { CreatePersonalResourceDelegation } from "@tedix/api-contract/schemas/personal-resource-delegations";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getPersonalResourceDelegation } from "@tedix/db/queries/personal-resource-delegations";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type {
	NewPersonalResourceDelegationRow,
	PersonalResourceDelegationRow,
} from "@tedix/db/schema/personal-resource-delegations";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	hasConnectionCredentialResolutionAuthority,
} from "../rpc/orpc";
import { requireOrgId } from "../rpc/org-scope";
import { fetchNamedConnection } from "../rpc/routers/connections/policy-resolution";

function deny(message: string): never {
	throw createError(ErrorCodes.FORBIDDEN, message);
}
export async function requirePersonalDelegationOwner(
	context: BaseContext,
): Promise<{ organizationId: string; ownerUserId: string }> {
	if (context.authType !== "user" || !context.user?.sub || context.tediId)
		deny("Personal consent requires the authenticated account owner");
	const organizationId = requireOrgId(context);
	const ownerUserId = context.user.sub;
	const membership = await getMemberByUserId(
		context.db,
		organizationId,
		ownerUserId,
	);
	if (membership?.status !== "active")
		deny("An active organization membership is required");
	return { organizationId, ownerUserId };
}
/** Hash identifiers of grants, never OAuth secret material. Reconnection requires new consent. */
export async function personalConnectionGrantFingerprint(
	tokenIds: string[],
): Promise<string> {
	if (
		!Array.isArray(tokenIds) ||
		tokenIds.length === 0 ||
		tokenIds.some((id) => typeof id !== "string" || !id.trim())
	)
		deny("The exact personal account is disconnected");
	const bytes = new TextEncoder().encode(
		JSON.stringify([...new Set(tokenIds)].sort()),
	);
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}
function scopesFromResource(value: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		deny("Resource scopes are invalid");
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length > 50 ||
		!parsed.every(
			(s) =>
				typeof s === "string" &&
				s.trim() === s &&
				s.length > 0 &&
				s.length <= 300,
		)
	)
		deny("Resource scopes are invalid");
	return [...new Set(parsed as string[])].sort();
}
function declaredToolIds(source: string): Set<string> {
	return new Set(Object.values(parseCapabilityManifest(source).mcp).flat());
}
/** Validate returned vault metadata too; a token for another grant must never be used. */
export function validatePersonalDelegationToken(
	row: Pick<PersonalResourceDelegationRow, "accountSubject" | "requiredScopes">,
	token: { tokenSub?: string; scopes?: string[] },
	approvedTokenIds: string[],
	tokenId: string | undefined,
): void {
	if (
		!tokenId ||
		!approvedTokenIds.includes(tokenId) ||
		token.tokenSub !== row.accountSubject ||
		!personalResourceScopesCover(token.scopes ?? [], row.requiredScopes)
	)
		deny("The returned credential is outside the approved account or scopes");
}
export async function preparePersonalResourceDelegation(
	context: BaseContext,
	input: CreatePersonalResourceDelegation,
	now = new Date(),
): Promise<NewPersonalResourceDelegationRow> {
	const owner = await requirePersonalDelegationOwner(context);
	const expires = Date.parse(input.expiresAt);
	if (!Number.isFinite(expires) || expires <= now.getTime())
		deny("Personal consent must have a future expiry");
	const [workspace, resource, tedi, skill] = await Promise.all([
		getOsWorkspace(context.db, {
			organizationId: owner.organizationId,
			workspaceId: input.workspaceId,
		}),
		getOsWorkspaceResource(context.db, {
			organizationId: owner.organizationId,
			workspaceId: input.workspaceId,
			resourceId: input.resourceId,
		}),
		getTediByIdForOrganization(context.db, input.tediId, owner.organizationId),
		getSkillEntry(context.db, input.skillId, owner.organizationId),
	]);
	if (
		workspace?.status !== "active" ||
		resource?.status !== "active" ||
		resource.connectionScope !== "user" ||
		!resource.providerResourceId.trim()
	)
		deny("Select an active personal Workspace resource");
	if (
		!tedi ||
		tedi.retiredAt ||
		!skill ||
		skill.revision !== input.skillRevision ||
		skill.lifecycleState === "archived" ||
		(skill.tediId && skill.tediId !== input.tediId)
	)
		deny("Select an active worker and exact skill revision");
	const declared = declaredToolIds(skill.files?.["SKILL.md"] ?? skill.content);
	if (input.toolIds.some((toolId) => !declared.has(toolId)))
		deny("Consent cannot grant an undeclared skill tool");
	const account = await getConnectionInstance(
		context.db,
		{ userId: owner.ownerUserId },
		input.connectionInstanceId,
		resource.providerId,
	);
	if (
		resource.personalOwnerUserId !== owner.ownerUserId ||
		resource.connectionInstanceId !== input.connectionInstanceId
	)
		deny("The resource is bound to another personal account");
	if (!account?.tokenSub)
		deny("The exact personal account has no verified identity");
	const grantFingerprint = await personalConnectionGrantFingerprint(
		account.tokenIds,
	);
	const requiredScopes = scopesFromResource(resource.requiredScopes);
	// The live grant check intentionally precedes fetchNamedConnection, which can
	// discover vault grants. It must not revive a disconnected delegation.
	const token = await fetchNamedConnection(
		context,
		{ userId: owner.ownerUserId },
		resource.providerId,
		account.id,
		requiredScopes,
	);
	if (!token) deny("The exact personal account is unavailable");
	validatePersonalDelegationToken(
		{ accountSubject: account.tokenSub, requiredScopes },
		token,
		account.tokenIds,
		token.id,
	);
	const current = await getConnectionInstance(
		context.db,
		{ userId: owner.ownerUserId },
		account.id,
		resource.providerId,
	);
	if (
		!current ||
		current.tokenSub !== account.tokenSub ||
		(await personalConnectionGrantFingerprint(current.tokenIds)) !==
			grantFingerprint
	)
		deny("Connection changed during consent; try again");
	return {
		...input,
		...owner,
		id: crypto.randomUUID(),
		providerId: resource.providerId,
		resourceType: resource.resourceType,
		providerResourceId: resource.providerResourceId,
		accountSubject: account.tokenSub,
		grantFingerprint,
		requiredScopes,
		expiresAt: new Date(expires).toISOString(),
		createdAt: now.toISOString(),
		revokedAt: null,
	};
}
export type PersonalResourceDelegationUse = {
	delegationId: string;
	tediId: string;
	skillId: string;
	skillRevision: number;
	workspaceId: string;
	resourceId: string;
	providerId: string;
	connectionInstanceId: string;
	operation: string;
	toolId: string;
	providerResourceId: string;
	requiredScopes: string[];
};
/** Before EACH credential lookup/provider operation. No cached consent decisions. */
export async function authorizePersonalResourceDelegation(
	context: BaseContext,
	input: PersonalResourceDelegationUse,
	now = new Date(),
): Promise<{
	delegation: PersonalResourceDelegationRow;
	ownerUserId: string;
	connectionInstanceId: string;
	approvedTokenIds: string[];
	skillRunId: string;
}> {
	const organizationId = requireOrgId(context);
	if (
		context.authType !== "service-binding" ||
		context.tediId !== input.tediId ||
		!hasConnectionCredentialResolutionAuthority(context) ||
		context.headers.get("X-Tedix-Mcp-Tool-Id") !== input.toolId
	)
		deny("Delegation requires a trusted worker tool execution");
	const runId = context.headers.get("X-Tedix-Skill-Run-Id");
	const epoch = context.headers.get("X-Tedix-Workflow-Execution-Epoch");
	if (
		!runId ||
		!epoch ||
		!/^\d+$/.test(epoch) ||
		!Number.isSafeInteger(Number(epoch))
	)
		deny("Delegation requires verified live run provenance");
	const run = await getSkillRun(
		context.db,
		runId,
		organizationId,
		context.env.ENVIRONMENT,
	);
	if (
		!run ||
		run.status !== "running" ||
		run.tediId !== input.tediId ||
		run.skillId !== input.skillId ||
		run.skillRevision !== input.skillRevision ||
		run.executionEpoch !== Number(epoch) ||
		run.workflowRetiredAt ||
		run.restartRequestedAt ||
		!run.workflowInstanceId ||
		!run.workflowSource ||
		!run.skillDoc ||
		!declaredToolIds(run.skillDoc).has(input.toolId)
	)
		deny(
			"The pinned workflow execution is not active or did not declare this tool",
		);
	const row = await getPersonalResourceDelegation(context.db, {
		organizationId,
		id: input.delegationId,
	});
	if (
		!row ||
		row.revokedAt ||
		Date.parse(row.expiresAt) <= now.getTime() ||
		!Number.isFinite(Date.parse(row.expiresAt)) ||
		row.tediId !== input.tediId ||
		row.skillId !== input.skillId ||
		row.skillRevision !== input.skillRevision ||
		row.workspaceId !== input.workspaceId ||
		row.resourceId !== input.resourceId ||
		row.providerId !== input.providerId ||
		row.connectionInstanceId !== input.connectionInstanceId ||
		row.providerResourceId !== input.providerResourceId ||
		!row.operations.includes(input.operation) ||
		!row.toolIds.includes(input.toolId) ||
		!personalResourceScopesCover(row.requiredScopes, input.requiredScopes)
	)
		deny("No current personal consent matches this exact operation");
	const approvedTokenIds = await validateLivePersonalDelegation(
		context,
		row,
		now,
	);
	const parsed = OsDerivedAccessEnvelopeSchema.safeParse(
		run.resourceAccessEnvelope,
	);
	const bound = parsed.success
		? parsed.data.sources.find(
				(source) =>
					source.connectionScope === "user" &&
					source.delegationId === row.id &&
					source.workspaceResourceId === row.resourceId,
			)
		: undefined;
	if (
		!bound ||
		!samePersonalSource(bound, row) ||
		!bound.operations.includes(input.operation) ||
		!bound.toolIds?.includes(input.toolId)
	)
		deny("The live run did not admit this exact personal resource operation");

	return {
		delegation: row,
		ownerUserId: row.ownerUserId,
		connectionInstanceId: row.connectionInstanceId,
		approvedTokenIds,
		skillRunId: run.id,
	};
}

function samePersonalSource(
	source: ReturnType<typeof OsDerivedResourceAccessSchema.parse>,
	row: PersonalResourceDelegationRow,
): boolean {
	return (
		source.connectionScope === "user" &&
		source.personalOwnerUserId === row.ownerUserId &&
		source.connectionInstanceId === row.connectionInstanceId &&
		source.delegationId === row.id &&
		source.workspaceId === row.workspaceId &&
		source.workspaceResourceId === row.resourceId &&
		source.providerId === row.providerId &&
		source.resourceType === row.resourceType &&
		source.providerResourceId === row.providerResourceId &&
		source.requiredScopes.length === row.requiredScopes.length &&
		source.requiredScopes.every((scope) =>
			row.requiredScopes.includes(scope),
		) &&
		source.operations.every((operation) =>
			row.operations.includes(operation),
		) &&
		Boolean(source.toolIds?.length) &&
		source.toolIds!.every((toolId) => row.toolIds.includes(toolId))
	);
}
export function personalDelegationSource(row: PersonalResourceDelegationRow) {
	return OsDerivedResourceAccessSchema.parse({
		workspaceResourceId: row.resourceId,
		workspaceId: row.workspaceId,
		providerId: row.providerId,
		resourceType: row.resourceType,
		providerResourceId: row.providerResourceId,
		connectionScope: "user",
		personalOwnerUserId: row.ownerUserId,
		connectionInstanceId: row.connectionInstanceId,
		delegationId: row.id,
		requiredScopes: row.requiredScopes,
		operations: row.operations,
		toolIds: row.toolIds,
	});
}
async function validateLivePersonalDelegation(
	context: BaseContext,
	row: PersonalResourceDelegationRow,
	now = new Date(),
): Promise<string[]> {
	const organizationId = requireOrgId(context);
	if (
		row.organizationId !== organizationId ||
		row.revokedAt ||
		!Number.isFinite(Date.parse(row.expiresAt)) ||
		Date.parse(row.expiresAt) <= now.getTime()
	)
		deny("Personal consent is revoked or expired");
	const [membership, tedi, workspace, resource, account, skill] =
		await Promise.all([
			getMemberByUserId(context.db, organizationId, row.ownerUserId),
			getTediByIdForOrganization(context.db, row.tediId, organizationId),
			getOsWorkspace(context.db, {
				organizationId,
				workspaceId: row.workspaceId,
			}),
			getOsWorkspaceResource(context.db, {
				organizationId,
				workspaceId: row.workspaceId,
				resourceId: row.resourceId,
			}),
			getConnectionInstance(
				context.db,
				{ userId: row.ownerUserId },
				row.connectionInstanceId,
				row.providerId,
			),
			getSkillEntry(context.db, row.skillId, organizationId),
		]);
	if (
		membership?.status !== "active" ||
		!skill ||
		skill.lifecycleState === "archived" ||
		skill.revision !== row.skillRevision ||
		(skill.tediId && skill.tediId !== row.tediId) ||
		!tedi ||
		tedi.retiredAt ||
		workspace?.status !== "active" ||
		!resource ||
		resource.status !== "active" ||
		resource.connectionScope !== "user" ||
		resource.personalOwnerUserId !== row.ownerUserId ||
		resource.connectionInstanceId !== row.connectionInstanceId ||
		resource.providerId !== row.providerId ||
		resource.resourceType !== row.resourceType ||
		resource.providerResourceId !== row.providerResourceId ||
		!account ||
		account.tokenSub !== row.accountSubject
	)
		deny("Personal consent dependencies are no longer active or have changed");
	const currentScopes = scopesFromResource(resource.requiredScopes);
	if (
		currentScopes.length !== row.requiredScopes.length ||
		currentScopes.some((scope) => !row.requiredScopes.includes(scope)) ||
		(await personalConnectionGrantFingerprint(account.tokenIds)) !==
			row.grantFingerprint
	)
		deny("The resource scopes or connection grants changed; renew consent");
	return account.tokenIds;
}
/** Host-owned admission: validates every personal source before its immutable run snapshot is persisted. */
export async function validatePersonalRunSources(
	context: BaseContext,
	input: {
		tediId: string;
		skillId: string;
		skillRevision: number;
		resourceAccessEnvelope: OsDerivedAccessEnvelope;
	},
): Promise<OsDerivedAccessEnvelope> {
	const envelope = OsDerivedAccessEnvelopeSchema.parse(
		input.resourceAccessEnvelope,
	);
	const organizationId = requireOrgId(context);
	for (const source of envelope.sources) {
		if (source.connectionScope !== "user") continue;
		if (context.authType !== "user" && context.authType !== "service-binding")
			deny(
				"Personal run admission requires an owner or trusted internal service",
			);
		if (context.tediId && context.tediId !== input.tediId)
			deny("The acting worker does not match the admitted resource worker");
		const row = await getPersonalResourceDelegation(context.db, {
			organizationId,
			id: source.delegationId!,
		});
		if (
			!row ||
			row.tediId !== input.tediId ||
			row.skillId !== input.skillId ||
			row.skillRevision !== input.skillRevision ||
			!samePersonalSource(source, row) ||
			(context.authType === "user" && context.user?.sub !== row.ownerUserId)
		)
			deny("The admitted source does not match owner consent");
		await validateLivePersonalDelegation(context, row);
	}
	return envelope;
}
export async function resolvePersonalResourceDelegatedCredential(
	context: BaseContext,
	input: PersonalResourceDelegationUse,
) {
	const authority = await authorizePersonalResourceDelegation(context, input);
	const token = await fetchNamedConnection(
		context,
		{ userId: authority.ownerUserId },
		input.providerId,
		authority.connectionInstanceId,
		authority.delegation.requiredScopes,
	);
	if (
		!token?.accessToken ||
		(token.expiresAt && Number(token.expiresAt) <= Date.now() / 1000)
	)
		deny("The exact delegated credential is unavailable or expired");
	validatePersonalDelegationToken(
		authority.delegation,
		token,
		authority.approvedTokenIds,
		token.id,
	);
	await authorizePersonalResourceDelegation(context, input);
	return {
		accessToken: token.accessToken,
		delegation: authority.delegation,
		source: personalDelegationSource(authority.delegation),
	};
}
/** Personal bytes remain private; a workspace reader or unrelated skill is not the account owner. */
export async function authorizePersonalDerivedSource(
	context: BaseContext,
	source: ReturnType<typeof OsDerivedResourceAccessSchema.parse>,
): Promise<boolean> {
	if (source.connectionScope !== "user" || !source.delegationId) return false;
	try {
		const row = await getPersonalResourceDelegation(context.db, {
			organizationId: requireOrgId(context),
			id: source.delegationId,
		});
		if (!row || !samePersonalSource(source, row)) return false;
		await validateLivePersonalDelegation(context, row);
		if (context.authType === "user")
			return context.user?.sub === row.ownerUserId && !context.tediId;
		if (context.authType !== "service-binding" || context.tediId !== row.tediId)
			return false;
		const runId = context.headers.get("X-Tedix-Skill-Run-Id"),
			epoch = context.headers.get("X-Tedix-Workflow-Execution-Epoch");
		if (!runId || !epoch || !/^\d+$/.test(epoch)) return false;
		const run = await getSkillRun(
			context.db,
			runId,
			row.organizationId,
			context.env.ENVIRONMENT,
		);
		if (
			!run ||
			run.status !== "running" ||
			run.tediId !== row.tediId ||
			run.skillId !== row.skillId ||
			run.skillRevision !== row.skillRevision ||
			run.executionEpoch !== Number(epoch) ||
			run.workflowRetiredAt ||
			run.restartRequestedAt
		)
			return false;
		const envelope = OsDerivedAccessEnvelopeSchema.safeParse(
			run.resourceAccessEnvelope,
		);
		return (
			envelope.success &&
			envelope.data.sources.some((bound) => samePersonalSource(bound, row))
		);
	} catch {
		return false;
	}
}
/** Only persisted subscription leases can use this standing credential path. Never called by ordinary token fallback. */
export async function resolvePersonalSubscriptionCredential(
	context: BaseContext,
	input: { subscriptionId: string; organizationId: string },
) {
	if (requireOrgId(context) !== input.organizationId)
		deny("Subscription organization mismatch");
	const persisted = await getProviderEventSubscription(
		context.db,
		input.organizationId,
		input.subscriptionId,
	);
	const subscription = persisted;
	if (
		!subscription ||
		subscription.connectionScope !== "user" ||
		subscription.status === "disabled" ||
		!subscription.personalOwnerUserId ||
		!subscription.delegationId ||
		!subscription.workspaceId ||
		!subscription.workspaceResourceId ||
		!subscription.executionToolId ||
		!subscription.connectionInstanceId
	)
		deny("No active personal subscription lease exists");
	const owner =
		context.authType === "user" &&
		context.user?.sub === subscription.personalOwnerUserId &&
		!context.tediId;
	const internal =
		context.authType === "service-binding" &&
		!context.headers.get("X-Tedix-Mcp-Tool-Id") &&
		!context.gatewayEndUserId &&
		!context.user &&
		!context.tediId &&
		!context.externalAgentPrincipalId;
	if (!owner && !internal)
		deny(
			"Standing subscription credentials require their exact owner or trusted renewal service",
		);
	const ids = subscription.resourceDelegationIds;
	if (
		!Array.isArray(ids) ||
		!ids.length ||
		ids.length > 20 ||
		new Set(ids).size !== ids.length ||
		!ids.includes(subscription.delegationId)
	)
		deny("Subscription resource consent references are invalid");
	const rows: PersonalResourceDelegationRow[] = [];
	for (const id of ids) {
		const row = await getPersonalResourceDelegation(context.db, {
			organizationId: input.organizationId,
			id,
		});
		if (
			!row ||
			row.ownerUserId !== subscription.personalOwnerUserId ||
			row.tediId !== subscription.tediId ||
			row.skillId !== subscription.skillId ||
			row.skillRevision !== subscription.skillRevision ||
			row.workspaceId !== subscription.workspaceId ||
			!row.operations.includes("subscribe") ||
			!row.toolIds.includes(subscription.executionToolId)
		)
			deny("Subscription purpose is outside its pinned owner consent");
		await validateLivePersonalDelegation(context, row);
		const skill = await getSkillEntry(
			context.db,
			row.skillId,
			row.organizationId,
		);
		if (
			!skill ||
			!declaredToolIds(skill.files?.["SKILL.md"] ?? skill.content).has(
				subscription.executionToolId,
			)
		)
			deny("Subscription callback tool is not declared on the pinned skill");
		rows.push(row);
	}
	const primary = rows.find((row) => row.id === subscription.delegationId)!;
	if (
		primary.resourceId !== subscription.workspaceResourceId ||
		primary.providerId !== subscription.providerId ||
		primary.providerResourceId !== subscription.calendarId ||
		primary.connectionInstanceId !== subscription.connectionInstanceId ||
		primary.resourceType !== "calendar"
	)
		deny("Subscription calendar or account changed");
	const approved = await validateLivePersonalDelegation(context, primary);
	const token = await fetchNamedConnection(
		context,
		{ userId: primary.ownerUserId },
		primary.providerId,
		primary.connectionInstanceId,
		primary.requiredScopes,
	);
	if (
		!token?.accessToken ||
		(token.expiresAt && Number(token.expiresAt) <= Date.now() / 1000)
	)
		deny("Standing calendar credential is missing or expired");
	validatePersonalDelegationToken(primary, token, approved, token.id);
	for (const row of rows) await validateLivePersonalDelegation(context, row);
	const freshSubscription = await getProviderEventSubscription(
		context.db,
		input.organizationId,
		input.subscriptionId,
	);
	if (JSON.stringify(freshSubscription) !== JSON.stringify(persisted))
		deny("Standing subscription changed while resolving its credential");
	const resourceAccessEnvelope = OsDerivedAccessEnvelopeSchema.parse({
		version: 1,
		sources: rows.map(personalDelegationSource),
	});
	return {
		accessToken: token.accessToken,
		source: personalDelegationSource(primary),
		resourceAccessEnvelope,
	};
}

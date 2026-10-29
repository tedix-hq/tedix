import {
	getMemberByUserId,
	getMemberByCanonicalUserId,
} from "@tedix/db/queries/organization-members";
import {
	getOsShareSkillReadGrant,
	getOsShareGrantApprover,
} from "@tedix/db/queries/os-shares";
import {
	getOsGadget,
	getOsGadgetRevision,
} from "@tedix/db/queries/os-workspaces/gadgets";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { OsShareLinkRow } from "@tedix/db/schema/os-shares";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { OsGadgetManifestSchema } from "@tedix/api-contract/schemas/os-workspaces";
import {
	isAppRuntimeManifest,
	appRuntimePermission,
} from "@tedix/api-contract/utils/app-runtime";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	hasTedisReadAuthorization,
	hasRequiredScope,
} from "../rpc/orpc";

export interface GuestSkillReadScope {
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
	revisionId: string;
	shareLinkId: string;
}

export async function approvedGuestSkillRead(
	db: DbQueryClient,
	scope: GuestSkillReadScope,
	slot: string,
	resources?: readonly OsWorkspaceResourceRow[],
) {
	const grant = await getOsShareSkillReadGrant(db, { ...scope, slot });
	if (!grant || grant.workspaceId !== scope.workspaceId) return null;
	const member = await getOsShareGrantApprover(
		db,
		scope.organizationId,
		grant.approvedByUserId,
	);
	if (
		!member ||
		member.kind !== "human" ||
		member.status !== "active" ||
		!["owner", "admin"].includes(member.role)
	)
		return null;
	const bound =
		resources ??
		(await listOsWorkspaceResources(db, {
			...scope,
			status: "active",
			limit: 200,
		}));
	const resource = bound.find(
		(row) => row.id === grant.resourceId && row.slot === slot,
	);
	if (
		!resource ||
		resource.status !== "active" ||
		resource.organizationId !== scope.organizationId ||
		resource.workspaceId !== scope.workspaceId ||
		resource.providerId !== "tedix" ||
		resource.resourceType !== "skill" ||
		resource.providerResourceId !== grant.providerResourceId
	)
		return null;
	return { grant, member, resource };
}

/** Only an active human owner/admin can approve an exact existing read grant. */
export async function prepareGuestSkillReadGrants(
	context: BaseContext,
	link: OsShareLinkRow,
	slots: readonly string[],
) {
	const member =
		context.authType === "user" && context.user?.sub
			? context.userId
				? await getMemberByCanonicalUserId(
						context.db,
						link.organizationId,
						context.userId,
					)
				: await getMemberByUserId(
						context.db,
						link.organizationId,
						context.user.sub,
					)
			: null;
	const userId = member?.userId;
	if (
		!userId ||
		!member ||
		member.kind !== "human" ||
		member.status !== "active" ||
		!["owner", "admin"].includes(member.role) ||
		!hasTedisReadAuthorization(context) ||
		!hasRequiredScope(context, "tedis:read")
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An organization owner or admin must approve guest research access",
		);
	if (
		link.resourceType !== "gadget" ||
		link.role !== "use" ||
		link.access !== "anyone_with_link" ||
		link.policyMaxRole === "viewer" ||
		link.revokedAt ||
		link.disabledAt ||
		(link.expiresAt && Date.parse(link.expiresAt) <= Date.now())
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Guest research access requires an active anyone-with-link app use link",
		);
	const app = await getOsGadget(context.db, {
		organizationId: link.organizationId,
		gadgetId: link.resourceId,
	});
	const revisionId =
		link.revisionMode === "pinned"
			? link.pinnedRevisionId
			: app?.currentRevisionId;
	const revision = revisionId
		? await getOsGadgetRevision(context.db, {
				organizationId: link.organizationId,
				revisionId,
			})
		: null;
	if (
		!app ||
		app.status !== "active" ||
		!revision ||
		revision.gadgetId !== app.id
	)
		throw createError(ErrorCodes.NOT_FOUND, "App revision not found");
	const manifest = OsGadgetManifestSchema.parse(JSON.parse(revision.manifest));
	if (!isAppRuntimeManifest(manifest))
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This app cannot grant guest research access",
		);
	const resources = await listOsWorkspaceResources(context.db, {
		organizationId: link.organizationId,
		workspaceId: app.workspaceId,
		status: "active",
		limit: 200,
	});
	return slots.map((slot) => {
		const resource = resources.find(
			(row) =>
				row.slot === slot &&
				row.providerId === "tedix" &&
				row.resourceType === "skill",
		);
		const grant = manifest.resourceGrants?.find((g) => g.slot === slot);
		if (
			!resource ||
			!grant ||
			grant.operations.some((op) => op !== "skills.read") ||
			!appRuntimePermission({
				role: "use",
				grants: manifest.resourceGrants ?? [],
				operation: "skills.read",
				slot,
			}).allowed
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Guest research access must name an existing skill read-only slot",
			);
		return {
			id: crypto.randomUUID(),
			organizationId: link.organizationId,
			shareLinkId: link.id,
			workspaceId: app.workspaceId,
			gadgetId: app.id,
			revisionId: revision.id,
			resourceId: resource.id,
			providerResourceId: resource.providerResourceId,
			slot,
			approvedByUserId: userId,
			approvedAt: new Date().toISOString(),
			revokedAt: null,
		};
	});
}

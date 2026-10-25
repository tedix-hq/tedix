import { implement } from "@orpc/server";
import { osSharesContract } from "@tedix/api-contract/contracts/os-shares";
import type { OsShareLink } from "@tedix/api-contract/contracts/os-shares";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import {
	countActiveOsShareSessions,
	createOsShareLink,
	deleteOsShareLink,
	getScopedOsShareLink,
	listOsShareLinks,
	restrictOsShareLink,
	revokeOsShareLink,
} from "@tedix/db/queries/os-shares";
import {
	getOsGadget,
	getOsGadgetRevision,
	listOsGadgets,
} from "@tedix/db/queries/os-workspaces/gadgets";
import { getOsOutput } from "@tedix/db/queries/os-workspaces/outputs";
import { getOsOutputRevision } from "@tedix/db/queries/os-workspaces/outputs";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { assertOsWorkspaceVisible } from "../../services/os-workspace-visibility";
import { cutWorkspaceAppSessions } from "../../services/os-app-session-revocation";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { OsShareLinkRow } from "@tedix/db/schema/os-shares";
import {
	generateOsShareToken,
	hashOsShareToken,
} from "../../lib/os-share-redemption";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_SHARES_AUDIT, osAudit } from "../os-audit";
import { resolveCreator } from "./os-workspaces-shared";
import { resolveWorkspaceResourceAvailability } from "../../services/os-workspace-resource-availability";

import { osShareReviewsRouter } from "./os-share-reviews";

const osSharesOs = implement(osSharesContract).$context<BaseContext>();
const authed = osSharesOs.use(withAuth).use(osAudit(OS_SHARES_AUDIT));
// Share links govern read access to tenant OS outputs, so they sit on the
// same two planes as the os-workspaces domain they expose: listing is os:read,
// minting/revoking a link is authoring authority over the shared output
// (os:author; settings:manage remains sufficient), plus the apps:read /
// apps:write machine scopes.
const readOs = authed.use(AUTHZ.osRead);
const authorOs = authed.use(AUTHZ.osAuthor);
const adminOs = authed.use(AUTHZ.osAdmin);

function queryDb(context: BaseContext) {
	return createDbQueryClient(context.env.DB);
}

/** Wire shape for one share link. The token hash never leaves the store. */
function mapShareLink(row: OsShareLinkRow): OsShareLink {
	return {
		id: row.id,
		organizationId: row.organizationId,
		resourceType: row.resourceType,
		resourceId: row.resourceId,
		role: row.role,
		revisionMode: row.revisionMode,
		pinnedRevisionId: row.pinnedRevisionId,
		note: row.note,
		policyMaxRole: row.policyMaxRole,
		policyReason: row.policyReason,
		policyRestrictedAt: row.policyRestrictedAt,
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		revokedAt: row.revokedAt,
	};
}

/** Bind the caller's organization into a resource lookup, or 404. */
async function requireResource(
	context: BaseContext,
	resourceType: "output" | "gadget" | "workspace",
	resourceId: string,
) {
	const organizationId = requireOrgId(context);
	const db = queryDb(context);
	if (resourceType === "output") {
		const output = await getOsOutput(db, {
			organizationId,
			outputId: resourceId,
		});
		if (!output) throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		await requireShareableWorkspace(context, output.workspaceId);
		return output;
	}
	if (resourceType === "gadget") {
		const gadget = await getOsGadget(db, {
			organizationId,
			gadgetId: resourceId,
		});
		if (!gadget) throw createError(ErrorCodes.NOT_FOUND, "OS app not found");
		await requireShareableWorkspace(context, gadget.workspaceId);
		return gadget;
	}
	const workspace = await getOsWorkspace(db, {
		organizationId,
		workspaceId: resourceId,
	});
	if (!workspace) {
		throw createError(ErrorCodes.NOT_FOUND, "OS workspace not found");
	}
	await requireShareableWorkspace(context, workspace.id);
	return workspace;
}

/**
 * A share link reaches people outside a private workspace, so nothing in a
 * private workspace is shareable. Non-owners get NOT_FOUND: they cannot learn
 * it exists.
 */
async function requireShareableWorkspace(
	context: BaseContext,
	workspaceId: string | null,
): Promise<void> {
	if (!workspaceId) return;
	const workspace = await getOsWorkspace(queryDb(context), {
		organizationId: requireOrgId(context),
		workspaceId,
	});
	if (!workspace || workspace.visibility !== "private") return;
	await assertOsWorkspaceVisible(context, workspace);
	throw createError(
		ErrorCodes.BAD_REQUEST,
		"This is in a private workspace. Share the workspace with your organization first, then make a link.",
	);
}

async function requirePinnedRevision(
	context: BaseContext,
	resourceType: "output" | "gadget" | "workspace",
	resourceId: string,
	revisionId: string | undefined,
): Promise<string | null> {
	if (resourceType === "workspace") return null;
	if (!revisionId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Pinned share requires a revision",
		);
	}
	const organizationId = requireOrgId(context);
	const db = queryDb(context);
	if (resourceType === "output") {
		const revision = await getOsOutputRevision(db, {
			organizationId,
			revisionId,
		});
		if (!revision || revision.outputId !== resourceId) {
			throw createError(ErrorCodes.NOT_FOUND, "OS output revision not found");
		}
		return revision.id;
	}
	const revision = await getOsGadgetRevision(db, {
		organizationId,
		revisionId,
	});
	if (!revision || revision.gadgetId !== resourceId) {
		throw createError(ErrorCodes.NOT_FOUND, "OS app revision not found");
	}
	return revision.id;
}

async function pinnedWorkspaceSnapshot(
	context: BaseContext,
	workspaceId: string,
) {
	const organizationId = requireOrgId(context);
	const db = queryDb(context);
	const workspace = await getOsWorkspace(db, { organizationId, workspaceId });
	if (!workspace)
		throw createError(ErrorCodes.NOT_FOUND, "OS workspace not found");
	const gadgets = await listOsGadgets(db, organizationId, {
		workspaceId,
		status: "active",
		limit: 200,
	});
	const items = await Promise.all(
		gadgets.map(async (gadget) => {
			const revision = gadget.currentRevisionId
				? await getOsGadgetRevision(db, {
						organizationId,
						revisionId: gadget.currentRevisionId,
					})
				: null;
			return {
				id: gadget.id,
				name: gadget.name,
				description: gadget.description,
				revision: revision
					? {
							id: revision.id,
							revision: revision.revision,
							manifest: JSON.parse(revision.manifest),
						}
					: null,
			};
		}),
	);
	return JSON.stringify({
		workspace: {
			id: workspace.id,
			name: workspace.name,
			description: workspace.description,
		},
		gadgets: items,
	});
}

async function requireShareableOutputRevision(
	context: BaseContext,
	outputId: string,
	revisionId: string | null,
) {
	const organizationId = requireOrgId(context);
	const output = await getOsOutput(queryDb(context), {
		organizationId,
		outputId,
	});
	const selectedRevisionId = revisionId ?? output?.currentRevisionId;
	const revision = selectedRevisionId
		? await getOsOutputRevision(queryDb(context), {
				organizationId,
				revisionId: selectedRevisionId,
			})
		: null;
	if (!revision?.accessEnvelope) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"We can't tell where this version's content came from, so it can't be shared",
		);
	}
	let rawEnvelope: unknown;
	try {
		rawEnvelope = JSON.parse(revision.accessEnvelope);
	} catch {
		rawEnvelope = null;
	}
	const parsed = OsDerivedAccessEnvelopeSchema.safeParse(rawEnvelope);
	if (!parsed.success) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This version's source record is damaged, so it can't be shared",
		);
	}
	for (const source of parsed.data.sources) {
		const resource = await getOsWorkspaceResource(queryDb(context), {
			organizationId,
			workspaceId: source.workspaceId,
			resourceId: source.workspaceResourceId,
		});
		if (
			!resource ||
			resource.status !== "active" ||
			resource.connectionScope !== source.connectionScope ||
			resource.providerId !== source.providerId ||
			resource.resourceType !== source.resourceType ||
			resource.providerResourceId !== source.providerResourceId
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Something this version was made from is no longer available, so it can't be shared",
			);
		}
		const availability = await resolveWorkspaceResourceAvailability(context, {
			...resource,
			requiredScopes: source.requiredScopes,
		});
		if (availability.status !== "available") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"An account this version was made from can't be checked right now, so it can't be shared",
			);
		}
	}
}

const sharesCreate = authorOs.shares.create.handler(
	async ({ input, context }) => {
		const resource = await requireResource(
			context,
			input.resourceType,
			input.resourceId,
		);
		if (input.expiresAt !== undefined) {
			const expiry = Date.parse(input.expiresAt);
			if (!Number.isFinite(expiry) || expiry <= Date.now()) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"expiresAt must be a future timestamp",
				);
			}
		}
		const creator = resolveCreator(context);
		const pinnedRevisionId =
			input.revisionMode === "pinned"
				? await requirePinnedRevision(
						context,
						input.resourceType,
						input.resourceId,
						input.pinnedRevisionId,
					)
				: null;
		const pinnedSnapshot =
			input.revisionMode === "pinned" && input.resourceType === "workspace"
				? await pinnedWorkspaceSnapshot(context, input.resourceId)
				: null;
		if (input.resourceType === "output") {
			await requireShareableOutputRevision(
				context,
				input.resourceId,
				pinnedRevisionId,
			);
		}
		const token = generateOsShareToken();
		const row = await createOsShareLink(queryDb(context), {
			id: crypto.randomUUID(),
			organizationId: resource.organizationId,
			resourceType: input.resourceType,
			resourceId: resource.id,
			tokenHash: await hashOsShareToken(token),
			role: input.role,
			revisionMode: input.revisionMode,
			pinnedRevisionId,
			pinnedSnapshot,
			note: input.note ?? null,
			policyMaxRole: null,
			policyReason: null,
			policyRestrictedAt: null,
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: new Date().toISOString(),
			expiresAt: input.expiresAt ?? null,
			revokedAt: null,
		});
		// The plaintext token exists only in this response — never again.
		return { share: mapShareLink(row), token };
	},
);

const sharesList = readOs.shares.list.handler(async ({ input, context }) => {
	const resource = await requireResource(
		context,
		input.resourceType,
		input.resourceId,
	);
	const rows = await listOsShareLinks(queryDb(context), {
		organizationId: resource.organizationId,
		resourceType: input.resourceType,
		resourceId: resource.id,
	});
	return { items: rows.map(mapShareLink) };
});

const sharesPreviewRevoke = readOs.shares.previewRevoke.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const db = queryDb(context);
		const row = await getScopedOsShareLink(db, {
			organizationId,
			shareLinkId: input.shareId,
		});
		if (!row)
			throw createError(ErrorCodes.NOT_FOUND, "OS share link not found");
		return {
			share: mapShareLink(row),
			activeSessionCount: await countActiveOsShareSessions(
				db,
				row.id,
				new Date().toISOString(),
			),
		};
	},
);

const sharesRevoke = authorOs.shares.revoke.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const db = queryDb(context);
		const revokedSessionCount = await countActiveOsShareSessions(
			db,
			input.shareId,
			new Date().toISOString(),
		);
		const row = await revokeOsShareLink(db, {
			organizationId,
			shareLinkId: input.shareId,
		});
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "OS share link not found");
		}
		await cutShareLinkAppSessions(context, db, row);
		return { share: mapShareLink(row), revokedSessionCount };
	},
);

const ROLE_RANK = { viewer: 0, use: 1, build: 2 } as const;

const sharesRestrict = authorOs.shares.restrict.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const db = queryDb(context);
		const current = await getScopedOsShareLink(db, {
			organizationId,
			shareLinkId: input.shareId,
		});
		if (!current)
			throw createError(ErrorCodes.NOT_FOUND, "OS share link not found");
		if (ROLE_RANK[input.maxRole] > ROLE_RANK[current.role]) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Policy restriction cannot widen the authored share role",
			);
		}
		const result = await restrictOsShareLink(db, {
			organizationId,
			shareLinkId: input.shareId,
			maxRole: input.maxRole,
			reason: input.reason,
		});
		if (!result) {
			const latest = await getScopedOsShareLink(db, {
				organizationId,
				shareLinkId: input.shareId,
			});
			if (!latest)
				throw createError(ErrorCodes.NOT_FOUND, "OS share link not found");
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Policy restriction cannot clear or widen the current ceiling",
			);
		}
		await cutShareLinkAppSessions(context, db, result.share);
		return {
			share: mapShareLink(result.share),
			revokedSessionCount: result.revokedSessionCount,
		};
	},
);

/**
 * A guest who opened a runtime app through this link may still hold a signed
 * app session or be inside a call; the workspace's app host refuses sessions
 * minted for the link up to now and restarts its apps.
 */
async function cutShareLinkAppSessions(
	context: BaseContext,
	db: ReturnType<typeof queryDb>,
	link: OsShareLinkRow,
) {
	if (link.resourceType !== "gadget") return;
	const gadget = await getOsGadget(db, {
		organizationId: link.organizationId,
		gadgetId: link.resourceId,
	});
	if (!gadget) return;
	await cutWorkspaceAppSessions(context.env, {
		organizationId: link.organizationId,
		workspaceId: gadget.workspaceId,
		principalIds: [link.id],
	});
}

const sharesDelete = adminOs.shares.delete.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const db = queryDb(context);
		const row = await getScopedOsShareLink(db, {
			organizationId,
			shareLinkId: input.shareId,
		});
		if (!row)
			throw createError(ErrorCodes.NOT_FOUND, "OS share link not found");
		if (!row.revokedAt) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Revoke the share link before permanently deleting it",
			);
		}
		const removed = await deleteOsShareLink(db, {
			organizationId,
			shareLinkId: row.id,
		});
		if (!removed)
			throw createError(ErrorCodes.NOT_FOUND, "OS share link not found");
		return { deleted: true as const };
	},
);

export const osSharesContractRouter = osSharesOs.router({
	reviews: osShareReviewsRouter,
	shares: {
		create: sharesCreate,
		list: sharesList,
		previewRevoke: sharesPreviewRevoke,
		revoke: sharesRevoke,
		restrict: sharesRestrict,
		delete: sharesDelete,
	},
});

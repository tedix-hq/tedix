import { implement } from "@orpc/server";
import { osSharesContract } from "@tedix/api-contract/contracts/os-shares";
import type { OsShareLink } from "@tedix/api-contract/contracts/os-shares";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import {
	addOsShareLinkInvitee,
	countActiveOsShareSessions,
	createOsShareLink,
	deleteOsShareLink,
	getScopedOsShareLink,
	listOsShareLinkInvitees,
	listOsShareLinks,
	removeOsShareLinkInvitee,
	restrictOsShareLink,
	revokeOsShareLink,
	updateOsShareLinkSettings,
} from "@tedix/db/queries/os-shares";
import { findTedixPersonByEmail } from "@tedix/db/queries/os-collaborators";
import { getOrganizationProfile } from "@tedix/db/queries/organizations";
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
import { findKernelRuntimeRunForOutputRevision } from "@tedix/db/queries/kernel-runtime-runs";
import { getRunSensitiveDataLatch } from "@tedix/db/queries/sensitive-data-latch";
import { createDbQueryClient } from "@tedix/db/query-client";
import type {
	OsShareLinkInviteeRow,
	OsShareLinkRow,
} from "@tedix/db/schema/os-shares";
import {
	generateOsSharePublicId,
	generateOsShareToken,
	hashOsShareToken,
	osShareUrl,
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

/**
 * The organization's own OS host, where its share links resolve. Read once
 * per call; the slug never changes within one.
 */
async function shareUrlFor(
	context: BaseContext,
): Promise<(publicId: string) => string> {
	const organization = await getOrganizationProfile(
		queryDb(context),
		requireOrgId(context),
	);
	if (!organization)
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	return (publicId) => osShareUrl(context.env, organization.slug, publicId);
}

/** Wire shape for one share link. The token hash never leaves the store. */
function mapShareLink(
	row: OsShareLinkRow,
	urlFor: (publicId: string) => string,
): OsShareLink {
	// Every row has a permanent id after the backfill migration; the create
	// path always sets one.
	const publicId = row.publicId ?? "";
	return {
		id: row.id,
		publicId,
		url: urlFor(publicId),
		organizationId: row.organizationId,
		resourceType: row.resourceType,
		resourceId: row.resourceId,
		access: row.access,
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
	await requireUnlatchedAuthoringRun(context, outputId, revision.id);
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

/**
 * A share link is public egress. When the Home run that saved this version
 * read data marked sensitive, the link waits until an owner or admin reviews
 * the run and clears its lock.
 */
async function requireUnlatchedAuthoringRun(
	context: BaseContext,
	outputId: string,
	revisionId: string,
): Promise<void> {
	const organizationId = requireOrgId(context);
	const run = await findKernelRuntimeRunForOutputRevision(queryDb(context), {
		organizationId,
		outputId,
		revisionId,
	});
	if (!run) return;
	const state = await getRunSensitiveDataLatch(context.db, {
		organizationId,
		runRef: { kind: "kernel_run", id: run.id },
	});
	if (!state.latch) return;
	throw createError(
		ErrorCodes.BAD_REQUEST,
		`This version can't be shared yet: the run that made it read data marked sensitive (${state.latch.source.toolId}). An owner or admin reviews that run and clears its sensitive-data lock (clear_run_sensitive_data_latch for kernel_run ${run.id}); then try again.`,
	);
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
		const urlFor = await shareUrlFor(context);
		const row = await createOsShareLink(queryDb(context), {
			id: crypto.randomUUID(),
			publicId: generateOsSharePublicId(),
			organizationId: resource.organizationId,
			resourceType: input.resourceType,
			resourceId: resource.id,
			tokenHash: await hashOsShareToken(token),
			access: input.access,
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
		return { share: mapShareLink(row, urlFor), token };
	},
);

const sharesList = readOs.shares.list.handler(async ({ input, context }) => {
	const resource = await requireResource(
		context,
		input.resourceType,
		input.resourceId,
	);
	const db = queryDb(context);
	const rows = await listOsShareLinks(db, {
		organizationId: resource.organizationId,
		resourceType: input.resourceType,
		resourceId: resource.id,
	});
	const urlFor = await shareUrlFor(context);
	const items = rows.map((row) => mapShareLink(row, urlFor));
	if (
		input.resourceType !== "gadget" ||
		!("currentRevisionId" in resource) ||
		!resource.workspaceId
	)
		return { items };
	const { guestAppRefusalForApp } =
		await import("../../lib/os-share-app-runtime");
	return {
		items,
		guestRefusal: await guestAppRefusalForApp(db, {
			...resource,
			workspaceId: resource.workspaceId,
		}),
	};
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
			share: mapShareLink(row, await shareUrlFor(context)),
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
		return {
			share: mapShareLink(row, await shareUrlFor(context)),
			revokedSessionCount,
		};
	},
);

const ROLE_RANK = { viewer: 0, use: 1, build: 2 } as const;

/**
 * Edit an active link without minting a new token. Only organization owners
 * and admins (os:admin) may change who a live link reaches.
 */
const sharesUpdate = adminOs.shares.update.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const db = queryDb(context);
		const current = await getScopedOsShareLink(db, {
			organizationId,
			shareLinkId: input.shareId,
		});
		if (!current)
			throw createError(ErrorCodes.NOT_FOUND, "OS share link not found");
		if (current.revokedAt)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This link is turned off. Make a new link instead.",
			);
		const role = input.role ?? current.role;
		if ((current.resourceType === "output") !== (role === "viewer"))
			throw createError(
				ErrorCodes.BAD_REQUEST,
				current.resourceType === "output"
					? "Output shares are read-only viewer links"
					: "App and workspace shares use the use or build role",
			);
		const expiresAt =
			input.expiresAt === undefined ? current.expiresAt : input.expiresAt;
		if (input.expiresAt) {
			const expiry = Date.parse(input.expiresAt);
			if (!Number.isFinite(expiry) || expiry <= Date.now())
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"expiresAt must be a future timestamp",
				);
		}
		const note =
			input.note === undefined ? current.note : input.note?.trim() || null;
		const access = input.access ?? current.access;
		const narrowed = ROLE_RANK[role] < ROLE_RANK[current.role];
		// Anyone who opened the link under a wider audience must come back
		// through the new one; widening to anyone_with_link cuts nobody off.
		const audienceChanged =
			access !== current.access && access !== "anyone_with_link";
		const expiresSooner =
			expiresAt !== null &&
			(current.expiresAt === null ||
				Date.parse(expiresAt) < Date.parse(current.expiresAt));
		const endSessions = narrowed || audienceChanged || expiresSooner;
		const result = await updateOsShareLinkSettings(db, {
			organizationId,
			shareLinkId: current.id,
			set: { role, access, note, expiresAt },
			endSessions,
		});
		if (!result)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This link is turned off. Make a new link instead.",
			);
		if (endSessions) await cutShareLinkAppSessions(context, db, result.share);
		return {
			share: mapShareLink(result.share, await shareUrlFor(context)),
			revokedSessionCount: result.revokedSessionCount,
		};
	},
);

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
			share: mapShareLink(result.share, await shareUrlFor(context)),
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

function mapInvitee(row: OsShareLinkInviteeRow) {
	return {
		id: row.id,
		shareLinkId: row.shareLinkId,
		email: row.email,
		userId: row.userId,
		name: row.name,
		addedByKind: row.addedByKind,
		addedById: row.addedById,
		addedAt: row.addedAt,
	};
}

/** An active link in the caller's organization, or NOT_FOUND. */
async function requireActiveShareLink(context: BaseContext, shareId: string) {
	const row = await getScopedOsShareLink(queryDb(context), {
		organizationId: requireOrgId(context),
		shareLinkId: shareId,
	});
	if (!row) throw createError(ErrorCodes.NOT_FOUND, "OS share link not found");
	if (row.revokedAt)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This link is turned off. Make a new link instead.",
		);
	return row;
}

// The invite list decides who a live link reaches, so it sits with the other
// audience edits under os:admin; reading it needs the same authority.
const inviteesList = adminOs.shares.invitees.list.handler(
	async ({ input, context }) => {
		const link = await requireActiveShareLink(context, input.shareId);
		const rows = await listOsShareLinkInvitees(queryDb(context), {
			organizationId: link.organizationId,
			shareLinkId: link.id,
		});
		return { items: rows.map(mapInvitee) };
	},
);

const inviteesAdd = adminOs.shares.invitees.add.handler(
	async ({ input, context }) => {
		const link = await requireActiveShareLink(context, input.shareId);
		const db = queryDb(context);
		const person = await findTedixPersonByEmail(db, input.email);
		const creator = resolveCreator(context);
		const row = await addOsShareLinkInvitee(db, {
			id: crypto.randomUUID(),
			organizationId: link.organizationId,
			shareLinkId: link.id,
			email: input.email,
			userId: person?.userId ?? null,
			name: person?.name ?? null,
			addedByKind: creator.kind,
			addedById: creator.id,
			addedAt: new Date().toISOString(),
		});
		return { invitee: mapInvitee(row) };
	},
);

const inviteesRemove = adminOs.shares.invitees.remove.handler(
	async ({ input, context }) => {
		const link = await requireActiveShareLink(context, input.shareId);
		const db = queryDb(context);
		const removed = await removeOsShareLinkInvitee(db, {
			organizationId: link.organizationId,
			shareLinkId: link.id,
			inviteeId: input.inviteeId,
		});
		if (removed) await cutShareLinkAppSessions(context, db, link);
		return { removed };
	},
);

export const osSharesContractRouter = osSharesOs.router({
	reviews: osShareReviewsRouter,
	shares: {
		create: sharesCreate,
		list: sharesList,
		update: sharesUpdate,
		previewRevoke: sharesPreviewRevoke,
		revoke: sharesRevoke,
		restrict: sharesRestrict,
		delete: sharesDelete,
		invitees: {
			list: inviteesList,
			add: inviteesAdd,
			remove: inviteesRemove,
		},
	},
});

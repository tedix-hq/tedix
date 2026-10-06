/**
 * Business Capability Map Router
 * Value-stream capabilities + generic entity links
 *
 * REST Endpoints:
 * POST   /capabilities               - Create capability (org scoped, depth ≤ 3)
 * PATCH  /capabilities/{id}          - Update capability (re-parent validated)
 * POST   /capabilities/{id}/archive  - Archive capability subtree (soft)
 * GET    /capabilities               - List capabilities (flat, filtered)
 * GET    /capabilities/tree          - Capability tree (max depth 3)
 * GET    /capabilities/coverage      - Coverage report (heatmap read)
 * GET    /capabilities/unmapped      - Unmapped skills/objectives (gap list)
 * POST   /capabilities/{id}/links    - Link skill/app/tedi/objective (idempotent)
 * POST   /capabilities/{id}/unlink   - Unlink entity (idempotent)
 *
 * D1 is canonical. Migration-owned triggers enqueue Capability and
 * SUPPORTS-edge changes for the durable Neo4j projection drain.
 */

import { implement } from "@orpc/server";
import { capabilitiesContract } from "@tedix/api-contract/contracts/capabilities";
import {
	archiveCapabilitySubtree,
	CapabilityDepthError,
	CapabilityLinkEntityError,
	CapabilityParentError,
	createCapability,
	getCapabilityById,
	getCapabilityBySlug,
	getCapabilityCoverage,
	getCapabilityTree,
	getUnmappedEntities,
	linkCapability,
	listCapabilities,
	unlinkCapability,
	updateCapability,
} from "@tedix/db/queries/capabilities";
import type { OrgCapability } from "@tedix/db/schema/capabilities";
import { requireOrgIdOrInput } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";

const capabilitiesOs = implement(capabilitiesContract).$context<BaseContext>();
const authOs = capabilitiesOs.use(withAuth);
const readOs = authOs.use(AUTHZ.appsRead);
const manageOs = authOs.use(AUTHZ.settingsWrite);

async function assertCapabilityAccess(
	context: BaseContext,
	capabilityId: string,
): Promise<OrgCapability> {
	const capability = await getCapabilityById(context.db, capabilityId);
	if (!capability) {
		throw createError(ErrorCodes.NOT_FOUND, "Capability not found");
	}
	const orgId = requireOrgIdOrInput(context);
	if (capability.organizationId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this capability");
	}
	return capability;
}

function slugifyName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

/** Maps typed query errors to BAD_REQUEST; rethrows everything else. */
function rethrowCapabilityError(error: unknown): never {
	if (
		error instanceof CapabilityDepthError ||
		error instanceof CapabilityParentError
	) {
		throw createError(ErrorCodes.BAD_REQUEST, error.message);
	}
	throw error;
}

const createProcedure = manageOs.create.handler(async ({ input, context }) => {
	const orgId = requireOrgIdOrInput(context, input.organizationId);
	const slug = input.slug ?? slugifyName(input.name);
	if (!slug) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Capability name produces an empty slug — pass an explicit slug",
		);
	}

	const existing = await getCapabilityBySlug(context.db, orgId, slug);
	if (existing) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Capability slug "${slug}" already exists in this organization`,
		);
	}

	try {
		const capability = await createCapability(context.db, {
			id: crypto.randomUUID(),
			organizationId: orgId,
			parentId: input.parentId ?? null,
			name: input.name,
			slug,
			description: input.description,
			valueStream: input.valueStream,
			paceLayer: input.paceLayer,
			maturityScore: input.maturityScore ?? null,
			createdAt: new Date().toISOString(),
		});
		return capability;
	} catch (error) {
		rethrowCapabilityError(error);
	}
});

const updateProcedure = manageOs.update.handler(async ({ input, context }) => {
	const existing = await assertCapabilityAccess(context, input.id);

	if (input.slug && input.slug !== existing.slug) {
		const bySlug = await getCapabilityBySlug(
			context.db,
			existing.organizationId,
			input.slug,
		);
		if (bySlug && bySlug.id !== existing.id) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Capability slug "${input.slug}" already exists in this organization`,
			);
		}
	}

	try {
		const updated = await updateCapability(context.db, input.id, {
			name: input.name,
			slug: input.slug,
			description: input.description,
			valueStream: input.valueStream,
			paceLayer: input.paceLayer,
			maturityScore: input.maturityScore,
			parentId: input.parentId,
			updatedAt: new Date().toISOString(),
		});
		if (!updated) {
			throw createError(ErrorCodes.BAD_REQUEST, "Failed to update capability");
		}
		return updated;
	} catch (error) {
		rethrowCapabilityError(error);
	}
});

const archiveProcedure = manageOs.archive.handler(
	async ({ input, context }) => {
		await assertCapabilityAccess(context, input.id);
		const archived = await archiveCapabilitySubtree(
			context.db,
			input.id,
			new Date().toISOString(),
		);
		// Archive projects as a status change, not node deletion — the durable
		// projection preserves traversal history over archived capabilities.
		return {
			archivedIds: archived.map((capability) => capability.id),
			archivedCount: archived.length,
		};
	},
);

const listProcedure = readOs.list.handler(async ({ input, context }) => {
	const orgId = requireOrgIdOrInput(context, input?.organizationId);
	const limit = input?.limit ?? 50;
	const offset = input?.offset ?? 0;
	const { data, total } = await listCapabilities(context.db, {
		organizationId: orgId,
		status: input?.status,
		paceLayer: input?.paceLayer,
		parentId: input?.parentId,
		limit,
		offset,
	});
	return {
		data,
		pagination: { limit, offset, total, hasMore: offset + limit < total },
	};
});

const treeProcedure = readOs.tree.handler(async ({ input, context }) => {
	const orgId = requireOrgIdOrInput(context, input?.organizationId);
	const roots = await getCapabilityTree(context.db, orgId, {
		includeArchived: input?.includeArchived,
	});
	return { roots };
});

const coverageProcedure = readOs.coverage.handler(
	async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input?.organizationId);
		return getCapabilityCoverage(context.db, orgId);
	},
);

const unmappedProcedure = readOs.unmapped.handler(
	async ({ input, context }) => {
		const orgId = requireOrgIdOrInput(context, input?.organizationId);
		return getUnmappedEntities(context.db, orgId, {
			includeAppScopedSkills: input?.includeAppScopedSkills,
			limit: input?.limit,
		});
	},
);

const linkProcedure = manageOs.link.handler(async ({ input, context }) => {
	const capability = await assertCapabilityAccess(context, input.id);

	// Target existence/org validation lives in linkCapability itself
	// (CapabilityLinkEntityError); the router only maps it to HTTP codes.
	let linked: Awaited<ReturnType<typeof linkCapability>>;
	try {
		linked = await linkCapability(context.db, {
			id: crypto.randomUUID(),
			capabilityId: capability.id,
			organizationId: capability.organizationId,
			entityKind: input.entityKind,
			entityId: input.entityId,
			createdAt: new Date().toISOString(),
		});
	} catch (error) {
		if (error instanceof CapabilityLinkEntityError) {
			throw createError(
				error.reason === "not_found"
					? ErrorCodes.NOT_FOUND
					: ErrorCodes.FORBIDDEN,
				error.message,
			);
		}
		throw error;
	}
	const { link, created } = linked;

	return { link, created };
});

const unlinkProcedure = manageOs.unlink.handler(async ({ input, context }) => {
	const capability = await assertCapabilityAccess(context, input.id);
	const removed = await unlinkCapability(context.db, {
		capabilityId: capability.id,
		entityKind: input.entityKind,
		entityId: input.entityId,
	});
	return { removed };
});

export const capabilitiesContractRouter = capabilitiesOs.router({
	create: createProcedure,
	update: updateProcedure,
	archive: archiveProcedure,
	list: skipOutputValidation(listProcedure),
	tree: skipOutputValidation(treeProcedure),
	coverage: skipOutputValidation(coverageProcedure),
	unmapped: skipOutputValidation(unmappedProcedure),
	link: linkProcedure,
	unlink: unlinkProcedure,
});

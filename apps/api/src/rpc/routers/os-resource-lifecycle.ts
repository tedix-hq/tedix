import { implement } from "@orpc/server";
import {
	type OsBlueprintWithVisibility,
	osWorkspacesContract,
} from "@tedix/api-contract/contracts/os-workspaces";
import {
	deleteOsBlueprint,
	getOsBlueprint,
	updateOsBlueprint,
} from "@tedix/db/queries/os-workspaces/blueprints";
import { listOsCollaborationProposals } from "@tedix/db/queries/os-workspaces/collaboration";
import {
	deleteOsGadget,
	getOsGadget,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	deleteOsOutput,
	getOsOutput,
} from "@tedix/db/queries/os-workspaces/outputs";
import { listOsShareLinks } from "@tedix/db/queries/os-shares";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { OsBlueprintRow } from "@tedix/db/schema/os-workspaces";
import { mapOsOutputRow } from "../../services/os-output-library";
import { parseBlueprintLineage } from "../../services/os-blueprint-portability";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));
const authorOs = authed.use(AUTHZ.osAuthor);
const adminOs = authed.use(AUTHZ.osAdmin);

function queryDb(context: BaseContext) {
	return createDbQueryClient(context.env.DB);
}

function mapBlueprint(row: OsBlueprintRow): OsBlueprintWithVisibility {
	return { ...row, lineage: parseBlueprintLineage(row.lineage) };
}

async function requireNoActiveShares(
	context: BaseContext,
	resourceType: "gadget" | "output",
	resourceId: string,
) {
	const rows = await listOsShareLinks(queryDb(context), {
		organizationId: requireOrgId(context),
		resourceType,
		resourceId,
	});
	if (rows.some((row) => row.revokedAt === null)) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Revoke every share link before permanently deleting the resource",
		);
	}
}

async function requireBlueprint(context: BaseContext, blueprintId: string) {
	const row = await getOsBlueprint(queryDb(context), {
		organizationId: requireOrgId(context),
		blueprintId,
	});
	if (!row) throw createError(ErrorCodes.NOT_FOUND, "OS blueprint not found");
	return row;
}

const archiveBlueprint = authorOs.blueprints.archive.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		const row = await updateOsBlueprint(
			queryDb(context),
			{ organizationId: blueprint.organizationId, blueprintId: blueprint.id },
			{ status: "archived", visibility: "org" },
		);
		if (!row) throw createError(ErrorCodes.NOT_FOUND, "OS blueprint not found");
		return { blueprint: mapBlueprint(row) };
	},
);

const deleteBlueprint = adminOs.blueprints.delete.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		if (blueprint.status !== "archived") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Archive the Blueprint before permanently deleting it",
			);
		}
		const removed = await deleteOsBlueprint(queryDb(context), {
			organizationId: blueprint.organizationId,
			blueprintId: blueprint.id,
		});
		if (!removed)
			throw createError(ErrorCodes.NOT_FOUND, "OS blueprint not found");
		return { deleted: true as const };
	},
);

const deleteOutput = adminOs.outputs.delete.handler(
	async ({ input, context }) => {
		const output = await getOsOutput(queryDb(context), {
			organizationId: requireOrgId(context),
			outputId: input.outputId,
		});
		if (!output) throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		if (output.status !== "archived") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Archive the output before permanently deleting it",
			);
		}
		await requireNoActiveShares(context, "output", output.id);
		const proposals = await listOsCollaborationProposals(
			queryDb(context),
			output.organizationId,
			{ documentType: "output", documentId: output.id, limit: 1 },
		);
		if (proposals.length > 0) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Output has retained collaboration evidence and cannot be permanently deleted",
			);
		}
		const removed = await deleteOsOutput(queryDb(context), {
			organizationId: output.organizationId,
			outputId: output.id,
		});
		if (!removed)
			throw createError(ErrorCodes.NOT_FOUND, "OS output not found");
		return { deleted: true as const };
	},
);

const deleteGadget = adminOs.gadgets.delete.handler(
	async ({ input, context }) => {
		const gadget = await getOsGadget(queryDb(context), {
			organizationId: requireOrgId(context),
			gadgetId: input.gadgetId,
		});
		if (!gadget || gadget.workspaceId !== input.workspaceId) {
			throw createError(ErrorCodes.NOT_FOUND, "OS gadget not found");
		}
		if (gadget.status !== "archived") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Archive the Gadget before permanently deleting it",
			);
		}
		await requireNoActiveShares(context, "gadget", gadget.id);
		const removed = await deleteOsGadget(queryDb(context), {
			organizationId: gadget.organizationId,
			gadgetId: gadget.id,
		});
		if (!removed)
			throw createError(ErrorCodes.NOT_FOUND, "OS gadget not found");
		return { deleted: true as const };
	},
);

export const osBlueprintLifecycleProcedures = {
	archive: archiveBlueprint,
	delete: deleteBlueprint,
};

export const osOutputLifecycleProcedures = { delete: deleteOutput };

export const osGadgetLifecycleProcedures = { delete: deleteGadget };

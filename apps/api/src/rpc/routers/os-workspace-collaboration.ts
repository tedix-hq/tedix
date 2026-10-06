import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	OsGadgetManifestSchema,
	OsOutputContentSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	createOsCollaborationProposal,
	decideOsCollaborationProposal,
	getOsCollaborationProposal,
	listOsCollaborationProposals,
	mergeOsCollaborationProposal,
	updateOsCollaborationProposalPreview,
} from "@tedix/db/queries/os-workspaces/collaboration";
import {
	getOsGadgetRevision,
	listOsGadgetRevisions,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	getOsOutputRevision,
	listOsOutputRevisions,
} from "@tedix/db/queries/os-workspaces/outputs";
import type {
	OsCollaborationProposalRow,
	OsGadgetRevisionRow,
	OsOutputRevisionRow,
} from "@tedix/db/schema/os-workspaces";
import {
	mapOsOutputRevisionRow,
	mapOsOutputRow,
} from "../../services/os-output-library";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	mapCollaborationProposal,
	mapGadgetRevision,
	queryDb,
	requireGadget,
	requireOutput,
	requireWorkspace,
	revisionConflict,
	resolveCollaborationSource,
	resolveCreator,
} from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));
const readOs = authed.use(AUTHZ.osRead);
const authorOs = authed.use(AUTHZ.osAuthor);

async function requireCollaborationProposal(
	context: BaseContext,
	proposalId: string,
): Promise<OsCollaborationProposalRow> {
	const organizationId = requireOrgId(context);
	const proposal = await getOsCollaborationProposal(queryDb(context), {
		organizationId,
		proposalId,
	});
	if (!proposal) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"OS collaboration proposal not found",
		);
	}
	return proposal;
}

async function validateProposalContent(
	context: BaseContext,
	proposal: Pick<
		OsCollaborationProposalRow,
		"documentType" | "documentId" | "workspaceId"
	>,
	content: JsonValue,
): Promise<unknown> {
	if (proposal.documentType === "gadget") {
		await requireGadget(context, proposal.workspaceId, proposal.documentId);
		return OsGadgetManifestSchema.parse(content);
	}
	const output = await requireOutput(context, proposal.documentId);
	if (output.workspaceId !== proposal.workspaceId) {
		throw createError(ErrorCodes.NOT_FOUND, "OS output not found in workspace");
	}
	const parsed = OsOutputContentSchema.parse(content);
	if (parsed.kind !== output.kind) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Proposal body is ${parsed.kind} but the output is ${output.kind}`,
		);
	}
	return parsed;
}

const collaborationList = readOs.collaboration.list.handler(
	async ({ input, context }) => {
		await requireWorkspace(context, input.workspaceId);
		const organizationId = requireOrgId(context);
		const rows = await listOsCollaborationProposals(
			queryDb(context),
			organizationId,
			{
				workspaceId: input.workspaceId,
				documentType: input.documentType,
				documentId: input.documentId,
				statuses: input.statuses,
				limit: input.limit + 1,
			},
		);
		return {
			items: rows.slice(0, input.limit).map(mapCollaborationProposal),
			truncated: rows.length > input.limit,
		};
	},
);

const collaborationGet = readOs.collaboration.get.handler(
	async ({ input, context }) => ({
		proposal: mapCollaborationProposal(
			await requireCollaborationProposal(context, input.proposalId),
		),
	}),
);

const collaborationCreate = authorOs.collaboration.create.handler(
	async ({ input, context }) => {
		await requireWorkspace(context, input.workspaceId);
		const content = await validateProposalContent(
			context,
			input,
			input.content,
		);
		let baseRevision: OsGadgetRevisionRow | OsOutputRevisionRow | undefined;
		if (input.documentType === "gadget") {
			const gadget = await requireGadget(
				context,
				input.workspaceId,
				input.documentId,
			);
			if (gadget.currentRevisionId) {
				baseRevision = await getOsGadgetRevision(queryDb(context), {
					organizationId: gadget.organizationId,
					revisionId: gadget.currentRevisionId,
				});
			}
		} else {
			const output = await requireOutput(context, input.documentId);
			if (output.workspaceId !== input.workspaceId) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					"OS output not found in workspace",
				);
			}
			baseRevision = await getOsOutputRevision(queryDb(context), {
				organizationId: output.organizationId,
				revisionId: mapOsOutputRow(output).currentRevisionId,
			});
		}
		if (!baseRevision) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"A collaboration proposal requires an existing immutable base revision",
			);
		}
		const creator = resolveCreator(context);
		const source = resolveCollaborationSource(context);
		if (
			input.sourceKind !== source.sourceKind ||
			input.sourceId !== source.sourceId
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Collaboration source must match the authenticated producer",
			);
		}
		const now = new Date().toISOString();
		const proposal = await createOsCollaborationProposal(queryDb(context), {
			id: crypto.randomUUID(),
			organizationId: baseRevision.organizationId,
			workspaceId: input.workspaceId,
			documentType: input.documentType,
			documentId: input.documentId,
			baseRevisionId: baseRevision.id,
			baseRevision: baseRevision.revision,
			status: "open",
			...source,
			sourceAttestationVersion: 1,
			content: JSON.stringify(content),
			sequence: 0,
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: now,
			updatedAt: now,
		});
		return { proposal: mapCollaborationProposal(proposal) };
	},
);

const collaborationUpdatePreview = authorOs.collaboration.updatePreview.handler(
	async ({ input, context }) => {
		const proposal = await requireCollaborationProposal(
			context,
			input.proposalId,
		);
		const content = await validateProposalContent(
			context,
			proposal,
			input.content,
		);
		const source = resolveCollaborationSource(context);
		if (
			proposal.sourceAttestationVersion !== 1 ||
			proposal.sourceKind !== source.sourceKind ||
			proposal.sourceId !== source.sourceId
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the attested proposal producer may update its preview",
			);
		}
		const updated = await updateOsCollaborationProposalPreview(
			queryDb(context),
			{
				organizationId: proposal.organizationId,
				proposalId: proposal.id,
				expectedSequence: input.expectedSequence,
				sourceKind: source.sourceKind,
				sourceId: source.sourceId,
				content: JSON.stringify(content),
			},
		);
		if (!updated) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Proposal preview changed or is no longer open",
			);
		}
		return { proposal: mapCollaborationProposal(updated) };
	},
);

function collaborationDecision(
	decision: "accepted" | "rejected",
	handler:
		| typeof authorOs.collaboration.accept
		| typeof authorOs.collaboration.reject,
) {
	return handler.handler(async ({ input, context }) => {
		const proposal = await requireCollaborationProposal(
			context,
			input.proposalId,
		);
		const creator = resolveCreator(context);
		const updated = await decideOsCollaborationProposal(queryDb(context), {
			organizationId: proposal.organizationId,
			proposalId: proposal.id,
			expectedSequence: input.expectedSequence,
			decision,
			rationale: input.rationale,
			evidenceRefs: JSON.stringify(input.evidenceRefs),
			decidedByKind: creator.kind,
			decidedById: creator.id,
		});
		if (!updated) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Proposal decision lost against a sequence or status change",
			);
		}
		return { proposal: mapCollaborationProposal(updated) };
	});
}

const collaborationAccept = collaborationDecision(
	"accepted",
	authorOs.collaboration.accept,
);
const collaborationReject = collaborationDecision(
	"rejected",
	authorOs.collaboration.reject,
);

const collaborationMerge = authorOs.collaboration.merge.handler(
	async ({ input, context }) => {
		const proposal = await requireCollaborationProposal(
			context,
			input.proposalId,
		);
		await validateProposalContent(
			context,
			proposal,
			JSON.parse(proposal.content),
		);
		const creator = resolveCreator(context);
		const result = await mergeOsCollaborationProposal(queryDb(context), {
			organizationId: proposal.organizationId,
			proposalId: proposal.id,
			expectedSequence: input.expectedSequence,
			revisionId: crypto.randomUUID(),
			rationale: input.rationale,
			evidenceRefs: JSON.stringify(input.evidenceRefs),
			mergedByKind: creator.kind,
			mergedById: creator.id,
		});
		if (!result.ok) {
			if (result.reason === "proposal_conflict") {
				throw createError(
					ErrorCodes.CONFLICT,
					"Proposal is not accepted at the expected sequence",
				);
			}
			const currentRevision =
				proposal.documentType === "gadget"
					? ((
							await listOsGadgetRevisions(
								queryDb(context),
								{
									organizationId: proposal.organizationId,
									gadgetId: proposal.documentId,
								},
								{ limit: 1 },
							)
						)[0]?.revision ?? null)
					: ((
							await listOsOutputRevisions(
								queryDb(context),
								{
									organizationId: proposal.organizationId,
									outputId: proposal.documentId,
								},
								{ limit: 1 },
							)
						)[0]?.revision ?? null);
			throw revisionConflict(
				proposal.documentType === "gadget" ? "Gadget" : "Output",
				proposal.baseRevision,
				currentRevision,
			);
		}
		return {
			proposal: mapCollaborationProposal(result.proposal),
			revision:
				proposal.documentType === "gadget"
					? mapGadgetRevision(result.revision as OsGadgetRevisionRow)
					: mapOsOutputRevisionRow(result.revision as OsOutputRevisionRow),
		};
	},
);

export const osCollaborationProcedures = {
	list: collaborationList,
	get: collaborationGet,
	create: collaborationCreate,
	updatePreview: collaborationUpdatePreview,
	accept: collaborationAccept,
	reject: collaborationReject,
	merge: collaborationMerge,
};

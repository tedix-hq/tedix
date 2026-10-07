import { implement } from "@orpc/server";
import {
	osSharesContract,
	OsReviewBatchSchema,
	OsReviewFeedbackSchema,
} from "@tedix/api-contract/contracts/os-shares";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	createOsReviewBatch,
	getActiveOsReviewBatchForGadget,
	getOsReviewBatch,
	listOsReviewFeedback,
	type OsReviewFeedbackAccess,
	saveOsReviewFeedback,
} from "@tedix/db/queries/os-review-batches";
import {
	getScopedOsShareLink,
	touchOsShareSession,
} from "@tedix/db/queries/os-shares";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import { getOsOutputRevision } from "@tedix/db/queries/os-workspaces/outputs";
import type {
	OsReviewBatchRow,
	OsReviewFeedbackRow,
} from "@tedix/db/schema/os-shares";
import { hashOsShareToken } from "../../lib/os-share-redemption";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "../../services/os-derived-resource-access";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { requireOrgId } from "../org-scope";
import { osAudit, OS_SHARES_AUDIT } from "../os-audit";
import { requireGadget, requireOutput } from "./os-workspaces-shared";

const os = implement(osSharesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_SHARES_AUDIT));
const read = authed.use(AUTHZ.osRead);
const author = authed.use(AUTHZ.osAuthor);
function human(context: BaseContext) {
	if (context.authType !== "user" || !context.user)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Review actions require your own signed-in human identity",
		);
	// Match the canonical OS share creator and audit principal.
	const id = context.user.sub;
	if (!id)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Signed-in reviewer identity is missing",
		);
	return id;
}
function unavailable(): never {
	throw createError(ErrorCodes.NOT_FOUND, "Review share unavailable");
}
function batchWire(batch: OsReviewBatchRow) {
	return OsReviewBatchSchema.parse({
		...batch,
		shareId: batch.shareLinkId,
		cards: JSON.parse(batch.cards),
	});
}
async function sourceAllowed(
	context: BaseContext,
	organizationId: string,
	envelope: string | null,
) {
	const parsed = parseDerivedAccessEnvelope(envelope);
	if (
		!parsed ||
		!(await authorizeDerivedOutputSources(context, {
			organizationId,
			accessEnvelope: parsed,
		}))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Review source access is unavailable",
		);
}
async function activeShare(context: BaseContext, shareId: string) {
	const organizationId = requireOrgId(context);
	const db = createDbQueryClient(context.env.DB);
	const link = await getScopedOsShareLink(db, {
		organizationId,
		shareLinkId: shareId,
	});
	const now = new Date().toISOString();
	if (
		!link ||
		link.resourceType !== "gadget" ||
		link.role !== "use" ||
		(link.policyMaxRole !== null && link.policyMaxRole !== "use") ||
		link.revokedAt ||
		(link.expiresAt && link.expiresAt <= now)
	)
		unavailable();
	// Exact tenant and active gadget; generic links never imply owner credentials.
	const row = await getOsGadget(db, {
		organizationId,
		gadgetId: link.resourceId,
	});
	if (!row) unavailable();
	const gadget = await requireGadget(context, row.workspaceId, link.resourceId);
	if (gadget.status !== "active") unavailable();
	return { organizationId, db, link, gadget, now };
}
async function recipient(
	context: BaseContext,
	input: { shareId: string; sessionToken: string },
) {
	const reviewerId = human(context);
	const state = await activeShare(context, input.shareId);
	const sessionHash = await hashOsShareToken(input.sessionToken);
	const session = await touchOsShareSession(state.db, sessionHash, state.now);
	if (!session || session.shareLinkId !== state.link.id) unavailable();
	const batch = await getOsReviewBatch(
		state.db,
		state.organizationId,
		state.link.id,
	);
	if (batch)
		await sourceAllowed(context, state.organizationId, batch.accessEnvelope);
	return { ...state, reviewerId, sessionHash, batch };
}
const create = author.reviews.create.handler(async ({ context, input }) => {
	const ownerId = human(context);
	if (context.userRole !== "owner")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the current organization owner can approve a review batch",
		);
	const state = await activeShare(context, input.shareId);
	if (state.link.createdByKind !== "user" || state.link.createdById !== ownerId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The review batch must be approved by this share link's owner",
		);
	const output = await requireOutput(context, input.sourceOutputId);
	if (output.workspaceId !== state.gadget.workspaceId) unavailable();
	const revision = await getOsOutputRevision(state.db, {
		organizationId: state.organizationId,
		revisionId: input.sourceRevisionId,
	});
	if (!revision || revision.outputId !== output.id) unavailable();
	await sourceAllowed(context, state.organizationId, revision.accessEnvelope);
	const batch = await createOsReviewBatch(
		state.db,
		{
			id: crypto.randomUUID(),
			organizationId: state.organizationId,
			shareLinkId: state.link.id,
			sourceOutputId: output.id,
			sourceRevisionId: revision.id,
			title: input.title,
			cards: JSON.stringify(input.cards),
			accessEnvelope: revision.accessEnvelope!,
			createdById: ownerId,
			createdAt: new Date().toISOString(),
		},
		new Date().toISOString(),
	);
	if (!batch)
		throw createError(
			ErrorCodes.CONFLICT,
			"This share already has an immutable review batch. Create a new link for a new batch.",
		);
	return { batch: batchWire(batch) };
});
const get = read.reviews.get.handler(async ({ context, input }) => {
	const state = await recipient(context, input);
	return {
		batch: state.batch ? batchWire(state.batch) : null,
		feedback: state.batch
			? (
					await listOsReviewFeedback(
						state.db,
						state.organizationId,
						state.batch.id,
						state.reviewerId,
					)
				).map((row) => OsReviewFeedbackSchema.parse(row))
			: [],
	};
});
const listFeedback = author.reviews.listFeedback.handler(
	async ({ context, input }) => {
		const organizationId = requireOrgId(context);
		const db = createDbQueryClient(context.env.DB);
		const batch = await getOsReviewBatch(db, organizationId, input.shareId);
		if (!batch) unavailable();
		await sourceAllowed(context, organizationId, batch.accessEnvelope);
		return {
			batch: batchWire(batch),
			feedback: (await listOsReviewFeedback(db, organizationId, batch.id)).map(
				(row) => OsReviewFeedbackSchema.parse(row),
			),
		};
	},
);
type FeedbackFields = {
	batchId: string;
	cardId: string;
	expectedRevision: number;
	decision: OsReviewFeedbackRow["decision"];
	editedReply: string;
	reason: string;
};
/** One write path for both entry points: same record, fences and conflict rule. */
async function writeFeedback(
	state: {
		db: ReturnType<typeof createDbQueryClient>;
		organizationId: string;
		reviewerId: string;
		batch: OsReviewBatchRow | undefined;
	},
	access: OsReviewFeedbackAccess,
	input: FeedbackFields,
) {
	if (!state.batch || state.batch.id !== input.batchId) unavailable();
	const batch = batchWire(state.batch);
	if (!batch.cards.some((card) => card.id === input.cardId)) unavailable();
	const feedback = await saveOsReviewFeedback(state.db, {
		organizationId: state.organizationId,
		access,
		batchId: input.batchId,
		cardId: input.cardId,
		reviewerId: state.reviewerId,
		expectedRevision: input.expectedRevision,
		decision: input.decision,
		editedReply: input.editedReply,
		reason: input.reason,
		now: new Date().toISOString(),
	});
	if (!feedback)
		throw createError(
			ErrorCodes.CONFLICT,
			"Feedback changed or sharing ended. Reload before saving.",
		);
	return { feedback: OsReviewFeedbackSchema.parse(feedback) };
}
const saveFeedback = read.reviews.saveFeedback.handler(
	async ({ context, input }) => {
		const state = await recipient(context, input);
		return writeFeedback(
			state,
			{
				kind: "share",
				shareId: state.link.id,
				sessionHash: state.sessionHash,
			},
			input,
		);
	},
);
/** A workspace member reviewing the batch bound to a gadget they can open. */
async function workspaceReviewer(
	context: BaseContext,
	input: { workspaceId: string; gadgetId: string },
) {
	const reviewerId = human(context);
	const organizationId = requireOrgId(context);
	const gadget = await requireGadget(
		context,
		input.workspaceId,
		input.gadgetId,
	);
	if (gadget.status !== "active") unavailable();
	const db = createDbQueryClient(context.env.DB);
	const batch = await getActiveOsReviewBatchForGadget(db, {
		organizationId,
		gadgetId: gadget.id,
		now: new Date().toISOString(),
	});
	if (batch) await sourceAllowed(context, organizationId, batch.accessEnvelope);
	return { db, organizationId, reviewerId, gadget, batch };
}
const getForGadget = read.reviews.getForGadget.handler(
	async ({ context, input }) => {
		const state = await workspaceReviewer(context, input);
		return {
			batch: state.batch ? batchWire(state.batch) : null,
			feedback: state.batch
				? (
						await listOsReviewFeedback(
							state.db,
							state.organizationId,
							state.batch.id,
							state.reviewerId,
						)
					).map((row) => OsReviewFeedbackSchema.parse(row))
				: [],
		};
	},
);
const saveGadgetFeedback = read.reviews.saveGadgetFeedback.handler(
	async ({ context, input }) => {
		const state = await workspaceReviewer(context, input);
		return writeFeedback(
			state,
			{ kind: "workspace", gadgetId: state.gadget.id },
			input,
		);
	},
);
export const osShareReviewsRouter = {
	create,
	get,
	listFeedback,
	saveFeedback,
	getForGadget,
	saveGadgetFeedback,
};

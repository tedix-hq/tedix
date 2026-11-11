import {
	getApprovalAnchor,
	reconcileToolReviewApproval,
	supersedeToolReviewApprovals,
} from "@tedix/db/queries/approvals";
import { listPendingToolReviewsForApp } from "@tedix/db/queries/tools";
import type { DbClient } from "@tedix/db/client";

const REVIEW_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;

export async function ensurePendingToolReviewApprovals(
	db: DbClient,
	input: { organizationId: string; appId: string; appName: string },
) {
	const rows = await listPendingToolReviewsForApp(db, input.appId);
	if (!rows.length) {
		await supersedeToolReviewApprovals(db, input);
		return [];
	}
	const anchor = await getApprovalAnchor(db, input.organizationId);
	if (!anchor) {
		throw new Error(
			`Cannot request tool review for ${input.appName}: organization has no active tedi approval anchor`,
		);
	}
	const createdAt = new Date().toISOString();
	return reconcileToolReviewApproval(db, {
		...input,
		tediId: anchor.id,
		createdAt,
		expiresAt: new Date(Date.parse(createdAt) + REVIEW_EXPIRY_MS).toISOString(),
	});
}

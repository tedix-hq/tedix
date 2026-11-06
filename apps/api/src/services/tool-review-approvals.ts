import {
	createApprovalRequest,
	getApprovalAnchor,
	getApprovalRequestById,
} from "@tedix/db/queries/approvals";
import { listPendingToolReviewsForApp } from "@tedix/db/queries/tools";
import type { DbClient } from "@tedix/db/client";
import { toJsonRecord } from "@tedix/db/utils/json";
import { canonicalDigest } from "../lib/blueprint-digest";

const REVIEW_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;

export async function ensurePendingToolReviewApprovals(
	db: DbClient,
	input: { organizationId: string; appId: string; appName: string },
) {
	const rows = await listPendingToolReviewsForApp(db, input.appId);
	const batches = new Map<string, typeof rows>();
	for (const row of rows) {
		const batch = batches.get(row.reviewBatchId!) ?? [];
		batch.push(row);
		batches.set(row.reviewBatchId!, batch);
	}
	if (batches.size === 0) return [];

	const anchor = await getApprovalAnchor(db, input.organizationId);
	if (!anchor) {
		throw new Error(
			`Cannot request tool review for ${input.appName}: organization has no active tedi approval anchor`,
		);
	}

	const requests = [];
	for (const [reviewBatchId, changes] of batches) {
		const payload = toJsonRecord({
			kind: "mcp_tool_catalog_change",
			appId: input.appId,
			reviewBatchId,
			expectedCount: changes.length,
			changes: changes.map((change) => ({
				rowId: change.rowId,
				toolId: change.toolId,
				schemaSourceHash: change.schemaSourceHash,
				diff: change.diff,
			})),
		});
		const id = `tool-review-${await canonicalDigest({
			organizationId: input.organizationId,
			appId: input.appId,
			reviewBatchId,
		})}`;
		const existing = await getApprovalRequestById(db, id, input.organizationId);
		if (existing) {
			requests.push(existing);
			continue;
		}
		const createdAt = new Date().toISOString();
		requests.push(
			await createApprovalRequest(db, {
				id,
				tediId: anchor.id,
				orgId: input.organizationId,
				actionType: "mcp.tool_catalog_change",
				description: `Review ${changes.length} upstream tool change${changes.length === 1 ? "" : "s"} for ${input.appName}`,
				payload,
				createdAt,
				expiresAt: new Date(
					Date.parse(createdAt) + REVIEW_EXPIRY_MS,
				).toISOString(),
			}),
		);
	}
	return requests;
}

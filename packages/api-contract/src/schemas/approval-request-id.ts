import * as z from "zod";

/**
 * Approval request ids are UUIDs, except tool-change reviews, whose id is a
 * stable digest so a rescan reuses the same pending request.
 */
export const ApprovalRequestIdSchema = z.union([
	z.uuid(),
	z.string().regex(/^tool-review-[a-f0-9]{64}$/),
]);

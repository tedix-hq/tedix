import * as z from "zod";

/**
 * Approval request ids are UUIDs. Historical tool-change reviews used a
 * prefixed digest; keep those records addressable after they are superseded.
 */
export const ApprovalRequestIdSchema = z.union([
	z.uuid(),
	z.string().regex(/^tool-review-[a-f0-9]{64}$/),
]);

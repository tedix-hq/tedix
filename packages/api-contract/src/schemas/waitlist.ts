/**
 * Waitlist Schemas for oRPC
 *
 * The waitlist gate lives entirely in the Descope `sign-up-or-in` flow and the
 * `waitlistStatus` custom user attribute (see `docs/engineering/platform/auth.md`). These
 * schemas back the Tedix admin tools that let operators read and set that
 * attribute without dropping to the raw Descope management passthrough.
 *
 * Descope defines `waitlistStatus` with the concrete options
 * `pending | approved | rejected` (default `""`). A brand-new signup that the
 * flow never stamped has an empty/absent value — the flow's `Else` branch
 * routes those users to the "Waitlist Pending" screen, so we surface that state
 * explicitly as `unset` rather than hiding it.
 */

import * as z from "zod";

/**
 * The three concrete values Descope accepts for the `waitlistStatus` attribute.
 * This is the write surface — you can only *set* a user to one of these.
 */
export const WAITLIST_STATUS_VALUES = [
	"pending",
	"approved",
	"rejected",
] as const;

export const WaitlistStatusSchema = z.enum(WAITLIST_STATUS_VALUES);
export type WaitlistStatus = z.infer<typeof WaitlistStatusSchema>;

/**
 * The read surface — includes `unset` for users whose attribute was never
 * written (empty string / absent). `unset` is not a settable value; it is a
 * derived state that behaves like `pending` in the flow's `Else` branch.
 */
export const WaitlistStatusStateSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"unset",
]);
export type WaitlistStatusState = z.infer<typeof WaitlistStatusStateSchema>;

/**
 * A single row in the waitlist admin view — a normalized projection of the
 * Descope user, not the raw record.
 */
export const WaitlistUserSchema = z.object({
	userId: z.string().describe("Descope user ID (e.g. U3GD6pUV...)"),
	loginId: z.string().nullable().describe("Primary Descope login ID"),
	email: z.string().nullable(),
	name: z.string().nullable(),
	status: z
		.string()
		.describe("Descope account status (enabled | disabled | invited)"),
	waitlistStatus: WaitlistStatusStateSchema,
	tenantCount: z
		.number()
		.describe("Number of tenants the user belongs to (0 = not yet onboarded)"),
	createdAt: z.string().nullable().describe("ISO 8601 signup time"),
});
export type WaitlistUser = z.infer<typeof WaitlistUserSchema>;

/**
 * Reference a Descope user by userId or loginId. At least one is required;
 * the handler enforces this (kept optional here so the schema composes cleanly
 * and projects to a clean tool JSON schema).
 */
export const WaitlistUserRefSchema = z.object({
	userId: z
		.string()
		.min(1)
		.optional()
		.describe("Descope user ID. Provide this or loginId."),
	loginId: z
		.string()
		.min(1)
		.optional()
		.describe("Descope login ID / email. Provide this or userId."),
});
export type WaitlistUserRef = z.infer<typeof WaitlistUserRefSchema>;

/**
 * Input for listing the waitlist queue.
 */
export const ListWaitlistInputSchema = z.object({
	status: WaitlistStatusStateSchema.optional().describe(
		"Filter by waitlist status. Omit for all users. `unset` is filtered in-app since Descope cannot query an empty attribute.",
	),
	limit: z.coerce.number().min(1).max(100).default(50),
	page: z.coerce.number().min(0).default(0),
});
export type ListWaitlistInput = z.infer<typeof ListWaitlistInputSchema>;

export const ListWaitlistResponseSchema = z.object({
	users: z.array(WaitlistUserSchema),
	total: z
		.number()
		.describe(
			"Total matches. Approximate for the `unset` filter (page-local).",
		),
	page: z.number(),
	limit: z.number(),
});
export type ListWaitlistResponse = z.infer<typeof ListWaitlistResponseSchema>;

/**
 * Input for setting a user's waitlist status.
 */
export const UpdateWaitlistStatusInputSchema = WaitlistUserRefSchema.extend({
	status: WaitlistStatusSchema.describe(
		"New waitlist status. `approved` lets the user through the sign-up flow to END.",
	),
	reason: z
		.string()
		.max(500)
		.optional()
		.describe("Optional note recorded in the audit trail."),
});
export type UpdateWaitlistStatusInput = z.infer<
	typeof UpdateWaitlistStatusInputSchema
>;

export const UpdateWaitlistStatusResponseSchema = z.object({
	user: WaitlistUserSchema,
	previousStatus: WaitlistStatusStateSchema,
});
export type UpdateWaitlistStatusResponse = z.infer<
	typeof UpdateWaitlistStatusResponseSchema
>;

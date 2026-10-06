import "@orpc/openapi/extensions/route";
/**
 * Waitlist Contract for oRPC
 *
 * Tedix-native admin surface for the onboarding waitlist gate. The gate itself
 * is owned by the Descope `sign-up-or-in` flow + the `waitlistStatus` custom
 * attribute (see `docs/platform/auth.md`); these tools let operators inspect
 * and drive that attribute from the Tedix admin surface instead of the raw
 * Descope management passthrough.
 *
 * Proc names are chosen so the schema-sync projector derives the intended
 * verb-first tool ids: `list` → `list_waitlist`, `getWaitlistStatus` →
 * `get_waitlist_status`, `updateWaitlistStatus` → `update_waitlist_status`.
 */

import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ListWaitlistInputSchema,
	ListWaitlistResponseSchema,
	UpdateWaitlistStatusInputSchema,
	UpdateWaitlistStatusResponseSchema,
	WaitlistUserRefSchema,
	WaitlistUserSchema,
} from "../schemas/waitlist";

export const waitlistContract = oc
	.route({ tags: ["waitlist"], prefix: "/waitlist" })
	.errors(baseErrors)
	.router({
		/**
		 * List the waitlist queue — Descope users projected with their
		 * normalized waitlist status. Platform-admin only.
		 * GET /waitlist
		 */
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List the onboarding waitlist",
				description:
					"List Descope users with their waitlist status (pending/approved/rejected/unset). Optionally filter by status. Platform-admin only.",
			})
			.input(ListWaitlistInputSchema)
			.output(ListWaitlistResponseSchema),

		/**
		 * Read one user's waitlist status by userId or loginId. Platform-admin only.
		 * GET /waitlist/status
		 */
		getWaitlistStatus: oc
			.route({
				method: "GET",
				path: "/status",
				summary: "Get a user's waitlist status",
				description:
					"Read a single Descope user's waitlist status and onboarding signals (tenant count, account status). Identify by userId or loginId. Platform-admin only.",
			})
			.input(WaitlistUserRefSchema)
			.output(WaitlistUserSchema),

		/**
		 * Set one user's waitlist status. `approved` unblocks the sign-up flow.
		 * Platform-admin only.
		 * PATCH /waitlist/status
		 */
		updateWaitlistStatus: oc
			.route({
				method: "PATCH",
				path: "/status",
				summary: "Set a user's waitlist status",
				description:
					"Set a Descope user's `waitlistStatus` custom attribute to pending, approved, or rejected. Setting `approved` lets the user complete the sign-up flow (reaches END → org auto-provisions). Identify by userId or loginId. Platform-admin only; audited.",
			})
			.input(UpdateWaitlistStatusInputSchema)
			.output(UpdateWaitlistStatusResponseSchema),
	});

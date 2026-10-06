/**
 * User-facing copy for the Tedix Identity journeys (login, OTP, invitation,
 * CLI consent). One module so wording cannot drift between surfaces the way
 * the continuation message once did ("Try the sign-in again." vs "…link
 * again.").
 */
export const IDENTITY_JOURNEY_COPY = {
	errors: {
		/** BYOS login screen: a provider/email interaction threw. */
		signInAdvance: "We could not continue your sign-in. Try again.",
		/** BYOS OTP screen: verify/resend threw. */
		otpVerify: "We could not verify that code. Try again.",
		/** Descope's generic flow failure, rewritten for humans. */
		flowFailed: "We couldn't complete sign-in. Please try again.",
		/** Post-authentication continuation (organization prepare + handoff). */
		continuation: "We could not finish signing you in. Try the sign-in again.",
		/** Invitation acceptance: token did not prove the invited identity. */
		invitedIdentity:
			"We could not verify the invited identity. Please sign in again.",
	},
	workspaceSelection: {
		title: "Choose a workspace",
		description:
			"Choose the organization this CLI session should use. You will review its requested access before anything is granted.",
		continueLabel: "Continue →",
		preparingLabel: "Preparing consent…",
		footnote:
			"Choosing an organization does not grant access. The next step shows the exact permissions requested by the CLI.",
	},
	permissionReview: {
		title: "Review requested access",
		description: (count: number) =>
			`This client is requesting ${count} specific Tedix capabilities. Expand a group to inspect every permission.`,
	},
} as const;

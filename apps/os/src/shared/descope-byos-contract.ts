import { IDENTITY_JOURNEY_COPY } from "./identity-journey-copy";
import type { ByosPasswordScreenContract } from "./descope-byos-password-screen";

export type DescopeFlowNext = (
	interactionId: string,
	form: Record<string, unknown>,
) => Promise<unknown>;

type DescopeFlowError = {
	code?: string;
	description?: string;
	message?: string;
	text?: string;
};

export type DescopeByosContext = Record<string, unknown> & {
	error?: DescopeFlowError | string;
};

export const DESCOPE_LOGIN_SCREEN_NAME = "Welcome Screen";
export const DESCOPE_OTP_SCREEN_NAME = "Verify OTP";

// Exported reviewer flow draft: this is a screen contract, not an authorization
// check. Descope owns the immutable identity and tenant-membership guard.
export const DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME =
	"Marketplace Reviewer Password";
export const DESCOPE_REVIEWER_SET_PASSWORD_SCREEN_NAME =
	"Marketplace Reviewer Set Password";
const REVIEWER_PASSWORD_SIGN_IN: ByosPasswordScreenContract = {
	mode: "sign-in",
	submit: "pXVwWREG7M",
	back: "tZbr-2eP17",
	backLabel: "Continue by email",
	fields: { password: "password" },
};
const REVIEWER_PASSWORD_SETUP: ByosPasswordScreenContract = {
	mode: "set",
	submit: "n6WbbqzlwS",
	fields: { newPassword: "newPassword" },
};

export function resolveDescopePasswordScreen(
	flowId: string,
	screenName: string,
): ByosPasswordScreenContract | null {
	if (
		flowId === "sign-up-or-in" &&
		screenName === DESCOPE_REVIEWER_SET_PASSWORD_SCREEN_NAME
	)
		return REVIEWER_PASSWORD_SETUP;
	return (flowId === "sign-up-or-in" ||
		flowId === "inbound-apps-multi-org-consent") &&
		screenName === DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME
		? REVIEWER_PASSWORD_SIGN_IN
		: null;
}

// Production Flow Builder contracts. A screen name is
// not a sufficient contract: Descope assigns different interaction IDs to the
// same named screen in different flows.
export const DESCOPE_LOGIN_INTERACTIONS = {
	"sign-up-or-in": {
		email: "COcMh1vzSn",
		google: "058XUDlhFP",
		apple: "DrraM2J7Lf",
		passkey: "gDYTgzMsxf",
	},
	"inbound-apps-multi-org-consent": {
		email: "3TVRPM-NqM",
		google: "FYf4hmIZgm",
		microsoft: "0L1nCJrTJX",
	},
} as const;

export const INBOUND_CONSENT_OTP_INTERACTIONS = {
	verify: "oneTimeCodeId",
	resend: "resend",
	back: "pnOqEGpL1b",
} as const;

// The step-up flow's Verify OTP screen (Descope Flow Builder, step-up v4)
// exposes only the stock verify + resend components — there is no
// "use another email" transition to route back to, so `back` is absent and
// the OTP screen hides that button for this contract.
export const STEP_UP_OTP_INTERACTIONS = {
	verify: "QXROtDaaH0",
	resend: "resend",
} as const;

/** Interaction ids a Tedix BYOS OTP screen advances the flow through. */
export type ByosOtpInteractions = {
	verify: string;
	resend: string;
	/** Omitted when the flow has no back transition (e.g. step-up). */
	back?: string;
};

export type DescopeLoginContract =
	(typeof DESCOPE_LOGIN_INTERACTIONS)[keyof typeof DESCOPE_LOGIN_INTERACTIONS];

export function descopeFlowErrorMessage(
	error: DescopeByosContext["error"],
): string | null {
	if (!error) return null;
	const message =
		typeof error === "string"
			? error
			: (error.text ?? error.description ?? error.message ?? null);
	return message === "Failed to sign up or in"
		? IDENTITY_JOURNEY_COPY.errors.flowFailed
		: message;
}

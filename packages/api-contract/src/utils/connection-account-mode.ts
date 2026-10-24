import type { ConnectionProvider } from "../schemas/connections";

export type ConnectionAccountMode = {
	mode: "single" | "multiple";
	/** One plain sentence a non-engineer can read. */
	reason: string;
};

/**
 * Whether an owner can hold more than one account for a provider.
 *
 * This is decided by how the provider signs in, not by a setting: named
 * accounts exist only for OAuth providers whose sign-in runs through Descope.
 * An API-key provider stores one key per owner, and a CIMD provider signs in
 * through Tedix's own callback, which has no named-account slot yet. The API
 * (`createConnectionInstance`) and the OS account list both read this rule,
 * so the page can never offer an account the API refuses.
 */
export function connectionAccountMode(
	provider: Pick<ConnectionProvider, "connectionType" | "registrationMode">,
): ConnectionAccountMode {
	if (provider.connectionType === "api_key")
		return {
			mode: "single",
			reason:
				"This app uses an API key, and Tedix keeps one key per owner. A second key needs its own connection.",
		};
	if (provider.registrationMode === "cimd")
		return {
			mode: "single",
			reason:
				"This app signs in directly with Tedix, which keeps one account per owner.",
		};
	return {
		mode: "multiple",
		reason:
			"You can sign in with more than one account and choose which one each app uses.",
	};
}

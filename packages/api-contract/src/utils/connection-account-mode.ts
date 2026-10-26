import type { ConnectionProvider } from "../schemas/connections";

export type ConnectionAccountMode = {
	mode: "single" | "multiple";
	/** One plain sentence a non-engineer can read. */
	reason: string;
};

export type ResolvedConnectionAccountPolicy = {
	accountMode: "single" | "multiple";
	availableAccountModes: ("single" | "multiple")[];
};

/** Resolve persisted policy within the limits of the provider's sign-in path. */
export function resolveConnectionAccountPolicy(
	provider: Pick<ConnectionProvider, "connectionType" | "registrationMode">,
	configuredMode?: "single" | "multiple",
): ResolvedConnectionAccountPolicy {
	const supportsMultipleAccounts =
		provider.connectionType === "oauth" && provider.registrationMode !== "cimd";
	return {
		accountMode:
			configuredMode === "single" || supportsMultipleAccounts
				? (configuredMode ?? (supportsMultipleAccounts ? "multiple" : "single"))
				: "single",
		availableAccountModes: supportsMultipleAccounts
			? ["single", "multiple"]
			: ["single"],
	};
}

/**
 * Whether an owner can hold more than one account for a provider.
 *
 * The API resolves the organization's persisted setting against the modes the
 * provider's sign-in mechanism supports. This helper only presents that
 * resolved setting, so account creation and the OS account list use the same
 * policy instead of deriving separate behavior.
 */
export function connectionAccountMode(
	provider: Pick<
		ConnectionProvider,
		| "accountMode"
		| "availableAccountModes"
		| "connectionType"
		| "registrationMode"
	>,
): ConnectionAccountMode {
	if (provider.accountMode === "multiple")
		return {
			mode: "multiple",
			reason:
				"You can sign in with more than one account and choose which one each app uses.",
		};
	if (provider.availableAccountModes.includes("multiple"))
		return {
			mode: "single",
			reason: "Your organization is set to use one account for this app.",
		};
	if (provider.connectionType === "api_key")
		return {
			mode: "single",
			reason:
				"This app uses an API key, and Tedix keeps one key per owner. A second key needs its own connection.",
		};
	return {
		mode: "single",
		reason:
			"This app signs in directly with Tedix, which keeps one account per owner.",
	};
}

import {
	buildSessionBrokerAuthorizeUrl,
	buildSessionBrokerLoginUrl,
} from "@tedix/auth/session-broker";

export interface ProductLoginIntent {
	authorizeUrl: string;
	intentId: string;
	skipOrganizationPreparation: boolean;
}

/**
 * Resolve the one value allowed on the shared human-login URL. All tenant,
 * callback, redirect, and session context remains inside the broker intent.
 */
export function resolveProductLoginIntent(
	value: string,
): ProductLoginIntent | null {
	try {
		const loginUrl = new URL(value);
		const intentId = loginUrl.searchParams.get("intent");
		if (!intentId) return null;
		const osOrigin = typeof __OS_URL__ === "string" ? __OS_URL__ : undefined;
		if (
			osOrigin &&
			osOrigin !== "https://os.tedix.dev" &&
			loginUrl.origin !== osOrigin
		)
			return null;
		const brokerOrigin =
			typeof __SESSION_BROKER_URL__ === "string"
				? __SESSION_BROKER_URL__
				: undefined;
		buildSessionBrokerLoginUrl(intentId, { osOrigin });
		return {
			authorizeUrl: buildSessionBrokerAuthorizeUrl(intentId, brokerOrigin),
			intentId,
			skipOrganizationPreparation:
				loginUrl.searchParams.get("outbound") === "1",
		};
	} catch {
		return null;
	}
}

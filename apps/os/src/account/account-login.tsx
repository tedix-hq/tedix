import {
	type BrokerPrefix,
	buildBrokerStartPath,
	buildOsAuthReturnUrl,
} from "@/shared/session-status";
import {
	AccountAuthProvider,
	CredentialPostLoginScreen,
} from "./account-login-primitives";

export function BrokerLoginPage({
	brokerPrefix,
	redirectTo,
}: {
	brokerPrefix: BrokerPrefix;
	redirectTo?: string;
}) {
	return (
		// This login-only SDK emits one fresh token pair to the broker. It neither
		// persists nor rotates credentials; the broker is the sole session owner.
		<AccountAuthProvider>
			<CredentialPostLoginScreen
				title="Sign in to Tedix OS"
				description="Continue to your company workspace."
				redirectUrl={buildOsAuthReturnUrl(window.location.href)}
				buildAction={() => {
					const destination = new URL(
						redirectTo ?? buildOsAuthReturnUrl(window.location.href),
						window.location.origin,
					);
					return buildBrokerStartPath(brokerPrefix, {
						redirectTo: `${destination.pathname}${destination.search}`,
					});
				}}
			/>
		</AccountAuthProvider>
	);
}

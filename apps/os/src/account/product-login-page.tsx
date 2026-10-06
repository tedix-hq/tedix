import { useEffect } from "react";
import { resolveProductLoginIntent } from "@/account/product-login-routing";
import { isDescopeFlowContinuation } from "@/shared/session-status";
import { BrokerLoginPage } from "@/account/account-login";
import { useDocumentTitle } from "@/lib/use-document-title";
import {
	AccountAuthProvider,
	CredentialPostLoginScreen,
} from "./account-login-primitives";
import { TedixBrandMark } from "@/shared/tedix-brand";

function IntentlessLoginRedirect() {
	useEffect(() => {
		// /login only means something with a broker intent. People land here
		// intentless from bookmarks and old links; hand them the real front
		// door instead of a dead end.
		window.location.replace("/");
	}, []);
	return (
		<main className="centered-state" aria-busy="true">
			<TedixBrandMark />
			<p>Taking you to the Tedix OS sign-in…</p>
			<a href="/">Return to Tedix OS</a>
		</main>
	);
}

export function ProductLoginPage() {
	useDocumentTitle("Sign in · Tedix OS");
	const intent = resolveProductLoginIntent(window.location.href);
	if (!intent) {
		// A magic-link email lands on the static `/login` with only the
		// `descope-login-flow` continuation. The flow must still mount so the
		// pending execution verifies (which also unblocks the sender tab's
		// waiting flow); the session resumed here continues through the
		// account broker instead of being discarded.
		if (isDescopeFlowContinuation(window.location.href)) {
			return (
				<BrokerLoginPage
					brokerPrefix="/auth/session-broker"
					redirectTo="/account/organizations"
				/>
			);
		}
		return <IntentlessLoginRedirect />;
	}
	return (
		<AccountAuthProvider>
			<CredentialPostLoginScreen
				title="Sign in"
				description="Continue securely to the product and organization you opened. Tedix Cloud is in private beta, by invitation."
				redirectUrl={window.location.href}
				prepareOrganization={!intent.skipOrganizationPreparation}
				buildAction={() => intent.authorizeUrl}
			/>
		</AccountAuthProvider>
	);
}

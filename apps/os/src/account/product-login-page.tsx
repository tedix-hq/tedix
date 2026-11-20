import { Link } from "@/components/kumo/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/kumo/button";
import { clearStoredAppFiles } from "@/shared/app-files-cache";
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
			<Link href="/">Return to Tedix OS</Link>
		</main>
	);
}

/** The Tedix desktop app adds this name to its browser identification. */
const inDesktopApp = () => navigator.userAgent.includes("TedixDesktop/");

/** A sign-in started in the desktop app marks the link it emails. */
function emailedLinkTarget(href: string): string {
	if (!inDesktopApp()) return href;
	const url = new URL(href);
	url.searchParams.set("desktop", "1");
	return url.href;
}

/** An emailed link that the desktop app asked for, opened in a browser. */
function isDesktopLinkInBrowser(href: string): boolean {
	return (
		!inDesktopApp() &&
		isDescopeFlowContinuation(href) &&
		new URL(href).searchParams.get("desktop") === "1"
	);
}

let appOpenTried = false;

/**
 * An emailed link signs in only the window that opens it. The sign-in flow is
 * not mounted here, so the link stays unused until the app or this browser
 * finishes it.
 */
function OpenDesktopApp({ onContinueHere }: { onContinueHere: () => void }) {
	const appLink = `tedix://sign-in?link=${encodeURIComponent(window.location.href)}`;
	useEffect(() => {
		if (appOpenTried) return;
		appOpenTried = true;
		window.location.assign(appLink);
	}, [appLink]);
	return (
		<main className="centered-state">
			<TedixBrandMark />
			<p>Open the Tedix app to finish signing in.</p>
			<Button onClick={() => window.location.assign(appLink)}>
				Open the Tedix app
			</Button>
			<Button variant="link" onClick={onContinueHere}>
				Continue in this browser instead
			</Button>
		</main>
	);
}

export function ProductLoginPage() {
	useDocumentTitle("Sign in");
	// Whoever signs in here next does not start with app files the previous
	// session left on this device.
	useEffect(() => void clearStoredAppFiles(), []);
	const [continueHere, setContinueHere] = useState(false);
	if (!continueHere && isDesktopLinkInBrowser(window.location.href))
		return <OpenDesktopApp onContinueHere={() => setContinueHere(true)} />;
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
				redirectUrl={emailedLinkTarget(window.location.href)}
				prepareOrganization={!intent.skipOrganizationPreparation}
				buildAction={() => intent.authorizeUrl}
			/>
		</AccountAuthProvider>
	);
}

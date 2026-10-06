import { IDENTITY_JOURNEY_COPY } from "@/shared/identity-journey-copy";
import { useCallback, useState, type ReactNode } from "react";
import { TedixDescopeProvider } from "@/shared/descope-provider";
import { useDocumentTitle } from "@/lib/use-document-title";
import { TedixSignUpOrInFlow } from "./descope-sign-up-or-in-flow";
import {
	IdentityJourneyFrame,
	postSessionTokenForm,
	useIdentityOrganizationContinuation,
} from "./identity-journey";

// This login-only mount emits one fresh token pair to the broker. The
// canonical broker-safe provider neither persists nor rotates credentials;
// the session broker is the sole session owner.
export function AccountAuthProvider({ children }: { children: ReactNode }) {
	return <TedixDescopeProvider>{children}</TedixDescopeProvider>;
}

export function AccountLoginFrame({
	title,
	description,
	flowReady,
	continuing = false,
	children,
	status,
	error,
}: {
	title: string;
	description: string;
	flowReady: boolean;
	continuing?: boolean;
	children: ReactNode;
	status?: string | null;
	error?: string | null;
}) {
	return (
		<IdentityJourneyFrame
			title={title}
			description={description}
			loading={!flowReady || continuing}
			loadingLabel={continuing ? "Finishing your Tedix sign-in…" : undefined}
			status={status}
			error={error}
		>
			{children}
		</IdentityJourneyFrame>
	);
}

/**
 * The one credential-handoff login screen. Both broker logins (account and
 * CLI/product) authenticate through the same BYOS flow and then hand the
 * fresh session JWT to their target via a top-level form POST; only the
 * target URL, copy, and organization preparation differ.
 */
export function CredentialPostLoginScreen({
	buildAction,
	description,
	errorMessage = IDENTITY_JOURNEY_COPY.errors.continuation,
	prepareOrganization = true,
	redirectUrl,
	title,
}: {
	/** Resolved at success time so the destination reflects the live URL. */
	buildAction: () => string;
	description: string;
	errorMessage?: string;
	prepareOrganization?: boolean;
	redirectUrl: string;
	title: string;
}) {
	useDocumentTitle("Sign in · Tedix OS");
	const [flowReady, setFlowReady] = useState(false);
	const continueJourney = useCallback(
		(sessionJwt: string) => {
			postSessionTokenForm(buildAction(), sessionJwt);
		},
		[buildAction],
	);
	const { continueAfterAuthentication, error, preparing } =
		useIdentityOrganizationContinuation({
			continueJourney,
			errorMessage,
			logLabel: "Tedix Identity organization continuation failed",
			prepareOrganization,
		});
	return (
		<AccountLoginFrame
			title={title}
			description={description}
			flowReady={flowReady}
			continuing={preparing}
			error={error}
		>
			<TedixSignUpOrInFlow
				redirectUrl={redirectUrl}
				onReady={() => setFlowReady(true)}
				onSuccess={(event) =>
					continueAfterAuthentication(event.detail.sessionJwt)
				}
			/>
		</AccountLoginFrame>
	);
}

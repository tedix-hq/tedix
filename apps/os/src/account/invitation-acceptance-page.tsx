import { IDENTITY_JOURNEY_COPY } from "@/shared/identity-journey-copy";
import { buildBrokerStartPath } from "@/shared/session-status";
import { useDescope } from "@descope/react-sdk/flows";
import { decodeUnverifiedJwtClaims } from "@tedix/auth/web";
import { useEffect, useRef, useState } from "react";
import { TedixDescopeProvider } from "@/shared/descope-provider";
import { getAuthenticatedOsApi, prepareFirstOsOrganization } from "@/lib/api";
import { useDocumentTitle } from "@/lib/use-document-title";
import { TedixBrandMark } from "@/shared/tedix-brand";
import { TedixSignUpOrInFlow } from "./descope-sign-up-or-in-flow";

function jwtSubject(token: string): string | undefined {
	const subject = decodeUnverifiedJwtClaims(token)?.sub;
	return typeof subject === "string" && subject.length > 0
		? subject
		: undefined;
}

type InvitationTarget = {
	memberId: string;
	tenantId: string;
};

function invitationTarget(url: URL): InvitationTarget | undefined {
	const memberId = url.searchParams.get("member_id");
	const tenantId = url.searchParams.get("tenant_id");
	return memberId && tenantId ? { memberId, tenantId } : undefined;
}

function recoveryUrl(target: InvitationTarget): string {
	const url = new URL("/invite", window.location.origin);
	url.searchParams.set("member_id", target.memberId);
	url.searchParams.set("tenant_id", target.tenantId);
	return url.toString();
}

function InvitationAcceptanceContent() {
	useDocumentTitle("Accept invitation · Tedix OS");
	const descope = useDescope();
	const started = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [recoveryTarget, setRecoveryTarget] = useState<InvitationTarget | null>(
		null,
	);

	const finishInvitation = async (
		target: InvitationTarget,
		initialSessionJwt: string,
		descopeUserId: string,
	) => {
		// Persist the membership immediately after Descope proves the invitee's
		// identity. Tenant selection and the product-session broker are useful
		// follow-up steps, but they must not turn a valid invitation into a
		// permanently-pending D1 record when either is interrupted.
		await getAuthenticatedOsApi(initialSessionJwt).members.acceptInvitation({
			memberId: target.memberId,
			descopeUserId,
		});

		const selected = await descope.selectTenant(target.tenantId);
		if (!selected.ok)
			throw new Error(
				"We could not open the invited workspace. Ask for a new invitation.",
			);
		const sessionJwt = selected.data?.sessionJwt;
		if (!sessionJwt)
			throw new Error(
				"Sign-in did not return a workspace session. Try the invitation link again.",
			);

		// The selected tenant claim lets the normal organization sync repair any
		// partial prior provisioning before the broker issues its product session.
		await prepareFirstOsOrganization(sessionJwt);
		window.location.replace(
			buildBrokerStartPath("/auth/session-broker", {
				redirectTo: "/account/organizations",
			}),
		);
	};

	useEffect(() => {
		const inviteUrl = new URL(window.location.href);
		const token = inviteUrl.searchParams.get("t");
		const target = invitationTarget(inviteUrl);
		if (!target) {
			setError(
				"This invitation link is incomplete. Ask your administrator for a new invitation.",
			);
			return;
		}
		if (!token) {
			setRecoveryTarget(target);
			return;
		}
		if (started.current) return;
		started.current = true;

		// `magicLink.verify` is the SDK equivalent of Descope's Verify Token
		// flow action. It replaces any browser-held CTO session with the identity
		// proved by the invitation token, then the broker derives a host-only
		// product session and D1 synchronizes the invited membership.
		void descope.magicLink.verify(token).then(
			async (result) => {
				if (!result.ok || !result.data?.sessionJwt) {
					setRecoveryTarget(target);
					return;
				}
				const descopeUserId =
					result.data.user?.userId ?? jwtSubject(result.data.sessionJwt);
				if (!descopeUserId) {
					setError(IDENTITY_JOURNEY_COPY.errors.invitedIdentity);
					return;
				}
				try {
					await finishInvitation(target, result.data.sessionJwt, descopeUserId);
				} catch (cause) {
					console.error("Tedix invitation setup failed", cause);
					setError(
						"Your invitation was verified, but workspace setup could not finish. Please sign in again to retry.",
					);
				}
			},
			(cause: unknown) => {
				console.warn("Tedix invitation token could not be verified", cause);
				setRecoveryTarget(target);
			},
		);
	}, [descope]);

	if (recoveryTarget) {
		return (
			<main className="product-login-page">
				<section className="product-login-panel" aria-label="Finish invitation">
					<TedixBrandMark />
					<h1>Finish joining your workspace</h1>
					<p>
						This invitation link has already been used or expired. Sign in with
						the invited email address to finish joining.
					</p>
					<TedixSignUpOrInFlow
						redirectUrl={recoveryUrl(recoveryTarget)}
						onSuccess={(event) => {
							const sessionJwt = event.detail.sessionJwt;
							const descopeUserId = jwtSubject(sessionJwt);
							if (!descopeUserId) {
								setError(IDENTITY_JOURNEY_COPY.errors.invitedIdentity);
								return;
							}
							setError(null);
							void finishInvitation(
								recoveryTarget,
								sessionJwt,
								descopeUserId,
							).catch((cause: unknown) => {
								console.error("Tedix invitation recovery failed", cause);
								setError(
									"We could not finish workspace setup. Please sign in again to retry.",
								);
							});
						}}
					/>
					{error ? <p role="alert">{error}</p> : null}
				</section>
			</main>
		);
	}

	return (
		<main className="centered-state" aria-busy={error ? undefined : true}>
			<TedixBrandMark />
			<h1>Accepting your invitation</h1>
			{error ? (
				<p role="alert">{error}</p>
			) : (
				<p>Securely signing you in to your workspace…</p>
			)}
		</main>
	);
}

export function InvitationAcceptancePage() {
	return (
		<TedixDescopeProvider>
			<InvitationAcceptanceContent />
		</TedixDescopeProvider>
	);
}

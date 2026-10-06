import { useCallback, useRef, useState, type ReactNode } from "react";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { TedixBrandLogo, TedixBrandMark } from "@/shared/tedix-brand";

const HIDDEN_WHILE_LOADING = {
	position: "absolute",
	visibility: "hidden",
	pointerEvents: "none",
} as const;

export type IdentityJourneyKind = "login" | "cli";

/**
 * One presentation shell for Tedix Identity journeys. The shell is deliberately
 * credential-neutral: OS, CLI, consent, CMS, and Docs continue to establish
 * their own product session or OAuth grant behind their existing boundaries.
 */
export function IdentityJourneyFrame({
	children,
	description,
	error,
	eyebrow,
	loading = false,
	loadingLabel = "Preparing your Tedix sign-in…",
	kind = "login",
	status,
	title,
}: {
	children: ReactNode;
	description: string;
	error?: string | null;
	eyebrow?: string;
	loading?: boolean;
	loadingLabel?: string;
	kind?: IdentityJourneyKind;
	status?: string | null;
	title: string;
}) {
	if (kind === "cli") {
		return (
			<main className="cli-authorize" aria-busy={loading || undefined}>
				<Surface
					tier="panel"
					variant="raised"
					className="flex w-full max-w-110 flex-col gap-1 p-7 sm:p-10"
				>
					<div className="mb-5">
						<TedixBrandMark />
					</div>
					{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
					<h1 className="text-balance font-semibold type-tedix-title">
						{title}
					</h1>
					<Text role="body" tone="secondary" className="mt-2">
						{description}
					</Text>
					{children}
					{status ? (
						<Text role="control" tone="secondary" aria-live="polite">
							{status}
						</Text>
					) : null}
					{error ? (
						<div role="alert">
							<Text role="control" tone="error">
								{error}
							</Text>
						</div>
					) : null}
				</Surface>
			</main>
		);
	}

	return (
		<>
			{loading ? (
				<main className="centered-state" aria-busy="true">
					<TedixBrandLogo />
					<p>{loadingLabel}</p>
				</main>
			) : null}
			<main
				className="product-login-page"
				aria-hidden={loading || undefined}
				style={loading ? HIDDEN_WHILE_LOADING : undefined}
			>
				<section className="product-login-panel" aria-label={title}>
					<TedixBrandLogo />
					{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
					<h1>{title}</h1>
					<p>{description}</p>
					{children}
					{status ? <p aria-live="polite">{status}</p> : null}
					{error ? <p role="alert">{error}</p> : null}
				</section>
			</main>
		</>
	);
}

/**
 * Shared post-auth continuation for every central sign-in entrypoint. The
 * idempotent preparation call creates a first organization only when needed;
 * returning members pass through the same continuation without being framed
 * as first-time users.
 */
/**
 * Hand a fresh Descope session JWT to a broker/authorize endpoint through a
 * top-level form POST. The credential travels only in the POST body of a
 * document navigation — never in a URL — and the receiving route owns the
 * session from that moment on.
 */
export function postSessionTokenForm(action: string, sessionJwt: string): void {
	const form = document.createElement("form");
	form.method = "POST";
	form.action = action;
	const token = document.createElement("input");
	token.type = "hidden";
	token.name = "session_token";
	token.value = sessionJwt;
	form.append(token);
	document.body.append(form);
	form.submit();
}

export function useIdentityOrganizationContinuation({
	continueJourney,
	errorMessage,
	logLabel,
	prepareOrganization = true,
}: {
	continueJourney: (sessionJwt: string) => void;
	errorMessage: string;
	logLabel: string;
	prepareOrganization?: boolean;
}) {
	const inFlight = useRef(false);
	const [preparing, setPreparing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const continueAfterAuthentication = useCallback(
		(sessionJwt: string) => {
			if (inFlight.current) return;
			inFlight.current = true;
			if (!prepareOrganization) {
				continueJourney(sessionJwt);
				return;
			}
			setPreparing(true);
			setError(null);
			void import("@/lib/api")
				.then(({ prepareFirstOsOrganization }) =>
					prepareFirstOsOrganization(sessionJwt),
				)
				.then(() => continueJourney(sessionJwt))
				.catch((cause: unknown) => {
					inFlight.current = false;
					setPreparing(false);
					setError(errorMessage);
					console.error(logLabel, cause);
				});
		},
		[continueJourney, errorMessage, logLabel, prepareOrganization],
	);

	return { continueAfterAuthentication, error, preparing };
}

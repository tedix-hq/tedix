/**
 * OAuth Callback Page
 *
 * Lightweight route that handles the redirect after an OAuth consent flow.
 * Consent normally runs in the popup `startOauthConnect` opens, so the usual
 * path is: post the completion message to the opener, then auto-close. When
 * the browser blocked that popup the connect ran as a top-level navigation
 * instead, and this page returns the person to the page they started from
 * (`CONNECT_RETURN_TO_KEY`), falling back to the OS root.
 *
 * Chrome-free and host-agnostic: it renders on both `os.tedix.dev` and
 * `{slug}.os.tedix.dev`, because the completion postMessage is filtered
 * strictly same-origin by its listener — the callback must land on whatever
 * host initiated the connect (`connections-actions.ts` builds the returnTo
 * from `window.location.origin`).
 */

import type { SearchSchemaInput } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import * as z from "zod/mini";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import {
	CONNECT_RETURN_TO_KEY,
	CONNECTION_COMPLETE_MESSAGE,
	CONNECTION_FAILED_MESSAGE,
	connectionFailureMessage,
	takeConnectionFlow,
} from "@/lib/connections-actions";

/**
 * The in-app path the connect started from, only ever an absolute same-origin
 * path so a poisoned storage entry cannot become an open redirect.
 */
function takeConnectReturnTo(): string {
	try {
		const stored = window.sessionStorage.getItem(CONNECT_RETURN_TO_KEY);
		window.sessionStorage.removeItem(CONNECT_RETURN_TO_KEY);
		if (stored?.startsWith("/") && !stored.startsWith("//")) return stored;
	} catch {
		// Storage denied; the root is the safe destination.
	}
	return "/";
}

/**
 * `connectError` is an optional provider/Descope callback error. A `.catch`
 * that defaulted
 * `connectError` away would silently disarm the failed-connect guard below,
 * so the catches only fire on non-string values.
 */
const oauthCallbackSearchSchema = z.object({
	connectError: z.catch(z.optional(z.string()), undefined),
	status: z.catch(z.optional(z.string()), undefined),
	reason: z.catch(z.optional(z.string()), undefined),
	provider: z.catch(z.optional(z.string()), undefined),
});

type OauthCallbackSearch = z.infer<typeof oauthCallbackSearchSchema>;

function validateOauthCallbackSearch(
	search: {
		connectError?: string;
		status?: string;
		reason?: string;
		provider?: string;
	} & SearchSchemaInput,
): OauthCallbackSearch {
	return oauthCallbackSearchSchema.parse(search);
}

export const Route = createFileRoute("/_session/_chrome-free/oauth/callback")({
	validateSearch: validateOauthCallbackSearch,
	component: OAuthCallbackPage,
});

function OAuthCallbackPage() {
	const { connectError, status, reason } = Route.useSearch();
	const callbackError =
		connectError ??
		(status !== undefined && status !== "success"
			? (reason ?? "connection_failed")
			: undefined);
	const completionFlow = useRef<
		ReturnType<typeof takeConnectionFlow> | undefined
	>(undefined);

	useEffect(() => {
		const isPopup = window.opener != null;

		if (isPopup) {
			completionFlow.current ??= takeConnectionFlow();
			const flow = completionFlow.current;
			if (!flow) return;
			// Notify the parent window to refresh connections
			try {
				window.opener.postMessage(
					callbackError
						? {
								type: CONNECTION_FAILED_MESSAGE,
								...flow,
								reason: callbackError,
							}
						: { type: CONNECTION_COMPLETE_MESSAGE, ...flow },
					window.location.origin,
				);
			} catch {
				// Parent may have been closed or cross-origin
			}
			// Auto-close after a brief delay so user sees the success state
			if (!callbackError) {
				const timer = setTimeout(() => window.close(), 1500);
				return () => clearTimeout(timer);
			}
			return;
		}

		// Keep top-level failures visible; this page never promotes credentials.
		if (callbackError) return;

		// Not a popup — the connect ran top-level. Return to the page it started
		// from with a real navigation, which also refetches the connections the
		// completion message would have invalidated.
		const returnTo = takeConnectReturnTo();
		const timer = setTimeout(() => {
			window.location.assign(returnTo);
		}, 2000);
		return () => clearTimeout(timer);
	}, [callbackError]);

	if (callbackError) {
		return (
			<main className="flex min-h-dvh items-center justify-center bg-background p-4">
				<div
					role="alert"
					className="w-full max-w-md space-y-3 px-6 text-center"
				>
					<Warning
						className="mx-auto h-12 w-12 text-kumo-warning"
						aria-hidden="true"
					/>
					<Text as="h1" role="title" weight="semibold">
						Not connected
					</Text>
					<Text as="p" role="body" tone="secondary">
						{connectionFailureMessage(callbackError)}
					</Text>
					<Button
						variant="outline"
						className="mt-1 w-full sm:w-auto"
						render={<a href="/admin/connections" />}
					>
						Return to connections
					</Button>
				</div>
			</main>
		);
	}

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-4">
			<div role="status" className="w-full max-w-md space-y-3 text-center">
				<CheckCircle
					className="mx-auto h-12 w-12 text-kumo-success"
					aria-hidden="true"
				/>
				<Text as="h1" role="title" weight="semibold">
					Authorization returned
				</Text>
				<Text as="p" role="body" tone="secondary">
					Tedix is refreshing the provider status. You can close this window.
				</Text>
			</div>
		</main>
	);
}

/**
 * Desktop app sign-in, the confirm step. The desktop app opens the browser at
 * `/auth/desktop/sign-in?key=…` (`src/auth/desktop-sign-in.ts`), which sends a
 * signed-in person here. The code starts a lasting desktop session, so
 * Continue first asks the person to sign in again (the step-up flow) and sends
 * the token it returns; the server refuses without it. Only the app that made
 * the key can read the code. Nothing is made when the page loads, and where a
 * fresh sign-in is not available (the local workspace) the page says so
 * instead of offering Continue.
 */

import type { SearchSchemaInput } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import * as z from "zod/mini";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { useStepUpAuth, useStepUpResume } from "@/lib/step-up-auth";
import { useOsIdentity } from "@/lib/use-os-identity";
import { isLocalOsHost } from "@/shared/descope-provider";
import { buildBrokerStartPath } from "@/shared/session-status";

const searchSchema = z.object({
	key: z.catch(z.optional(z.string()), undefined),
});

/** Survives a step-up flow that leaves the page (SSO, social sign-in). */
const DESKTOP_SIGN_IN_STEP_UP_INTENT = "desktop-sign-in:code";

function parseIntent(payload: unknown): { key: string } | null {
	const key = (payload as { key?: unknown } | null)?.key;
	return typeof key === "string" ? { key } : null;
}

async function requestCode(input: {
	key: string;
	steppedUpToken: string;
}): Promise<string> {
	const response = await fetch("/auth/desktop/sign-in", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = (await response.json().catch(() => null)) as {
		code?: unknown;
		error?: unknown;
	} | null;
	if (response.ok && typeof body?.code === "string") return body.code;
	throw new Error(
		typeof body?.error === "string"
			? body.error
			: "We could not prepare the sign-in.",
	);
}

export const Route = createFileRoute("/_session/_chrome-free/desktop-sign-in")({
	validateSearch: (search: { key?: string } & SearchSchemaInput) =>
		searchSchema.parse(search),
	component: DesktopSignInPage,
});

function DesktopSignInPage() {
	const { key } = Route.useSearch();
	const identity = useOsIdentity();
	const code = useMutation({ mutationFn: requestCode });
	const resume = useStepUpResume({
		key: DESKTOP_SIGN_IN_STEP_UP_INTENT,
		parse: parseIntent,
	});
	const [stepUpFailure, setStepUpFailure] = useState<string | null>(
		resume.failure,
	);
	const { requireStepUp, StepUpDialog } = useStepUpAuth({
		title: "Sign in again",
		description:
			"Signing in to the Tedix app keeps it signed in on this computer, so confirm it is you first.",
		onFailure: setStepUpFailure,
		intentKey: DESKTOP_SIGN_IN_STEP_UP_INTENT,
		// Resume only for the same link the step-up started from.
		autoResume: key !== undefined && resume.intent?.key === key,
		onResume: (steppedUpToken) => {
			if (key) code.mutate({ key, steppedUpToken });
		},
	});
	const failure = stepUpFailure ?? code.error?.message ?? null;

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-4">
			<div className="w-full max-w-md space-y-3 px-6 text-center">
				<Text as="h1" role="title" weight="semibold">
					Sign in to the Tedix app
				</Text>
				{!key ? (
					<Text as="p" role="body" tone="secondary">
						This sign-in link is incomplete. Start again from the Tedix app.
					</Text>
				) : isLocalOsHost() ? (
					<Text as="p" role="body" tone="secondary">
						The Tedix app cannot sign in through the local workspace, because it
						cannot ask you to sign in again here. Sign in to the app with Tedix
						Cloud instead.
					</Text>
				) : code.data ? (
					<>
						<Text as="p" role="body" tone="secondary">
							Open the Tedix app to finish. The button works once, for two
							minutes, and only in the app that asked.
						</Text>
						<Button
							className="mx-auto mt-1 flex w-full sm:w-auto"
							render={<a href={`tedix://sign-in?code=${code.data}`} />}
						>
							Open the Tedix app
						</Button>
					</>
				) : (
					<>
						<Text as="p" role="body" tone="secondary">
							Sign in to the Tedix app on this computer
							{identity.email ? ` as ${identity.email}` : ""}? Continue only if
							you just chose to sign in from the Tedix app. You will be asked to
							sign in again first.
						</Text>
						{failure ? (
							<div role="alert">
								<Text as="p" role="body" tone="error">
									{failure}
								</Text>
							</div>
						) : null}
						<Button
							className="mx-auto mt-1 flex w-full sm:w-auto"
							loading={code.isPending}
							disabled={code.isPending}
							onClick={() => {
								setStepUpFailure(null);
								code.reset();
								requireStepUp(
									(steppedUpToken) => code.mutate({ key, steppedUpToken }),
									{ key },
								);
							}}
						>
							Continue
						</Button>
						<StepUpDialog />
						<Text as="p" role="body" tone="secondary">
							{/* Signs out here, then returns to this page after sign-in. */}
							<Link
								href={buildBrokerStartPath("/auth/session-broker", {
									operation: "logout",
									redirectTo: `/auth/desktop/sign-in?key=${key}`,
								})}
							>
								Use a different account
							</Link>
						</Text>
					</>
				)}
			</div>
		</main>
	);
}

/**
 * Desktop app sign-in, the confirm step. The desktop app opens the browser at
 * `/auth/desktop/sign-in?key=…` (`src/auth/desktop-sign-in.ts`), which sends a
 * signed-in person here. The code the app receives becomes a lasting session,
 * so an open browser session is not enough: the person confirms who they are
 * again, and the token that proves it travels with the request for the code.
 */

import type { SearchSchemaInput } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import * as z from "zod/mini";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { operationalContextQueryOptions } from "@/lib/os-query-options";
import { useStepUpAuth, useStepUpResume } from "@/lib/step-up-auth";
import { useOsIdentity } from "@/lib/use-os-identity";

const STEP_UP_INTENT = "desktop-sign-in";

const searchSchema = z.object({
	key: z.catch(z.optional(z.string()), undefined),
});

function parseIntent(payload: unknown): { key: string } | null {
	const key = (payload as { key?: unknown } | null)?.key;
	return typeof key === "string" ? { key } : null;
}

async function requestCode(input: {
	key: string;
	proof: string;
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
	const context = useQuery(operationalContextQueryOptions());
	// Confirming through an organization's own sign-in page leaves this page
	// and comes back; the key rides along so the code is still issued.
	const resume = useStepUpResume({ key: STEP_UP_INTENT, parse: parseIntent });
	const resumed = resume.intent !== null && resume.intent.key === key;
	const [failure, setFailure] = useState<string | null>(resume.failure);
	// True when the failure came from confirming, not from issuing the code.
	const [confirmFailed, setConfirmFailed] = useState(resume.failure !== null);
	const code = useMutation({
		mutationFn: requestCode,
		onError: (error) => setFailure(error.message),
	});
	const issue = (proof: string) => {
		if (!key) return;
		setFailure(null);
		setConfirmFailed(false);
		code.mutate({ key, proof });
	};
	const { requireStepUp, StepUpDialog } = useStepUpAuth({
		tenantId: context.data?.organization.descopeTenantId ?? undefined,
		title: "Confirm it's you",
		description:
			"Signing in to the Tedix app keeps you signed in on this computer. Confirm who you are to continue.",
		onFailure: (message) => {
			setFailure(message);
			setConfirmFailed(true);
		},
		intentKey: STEP_UP_INTENT,
		autoResume: resumed,
		onResume: issue,
	});

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
				) : code.data ? (
					<>
						<Text as="p" role="body" tone="secondary">
							You are signed in. Open the Tedix app to finish. The button works
							once, for two minutes, and only in the app that asked.
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
							confirm who you are first.
						</Text>
						{failure ? (
							<div role="alert">
								<Text as="p" role="body" tone="error">
									{failure}
									{confirmFailed
										? " If your organization uses its own single sign-on and this keeps failing, the app cannot be signed in this way yet: confirming who you are must first be set up for that sign-on."
										: ""}
								</Text>
							</div>
						) : null}
						<Button
							className="mx-auto mt-1 flex w-full sm:w-auto"
							loading={code.isPending}
							disabled={code.isPending}
							onClick={() => requireStepUp(issue, { key })}
						>
							Continue
						</Button>
					</>
				)}
			</div>
			<StepUpDialog />
		</main>
	);
}

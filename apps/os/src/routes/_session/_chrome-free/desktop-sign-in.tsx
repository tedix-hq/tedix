/**
 * Desktop app sign-in, the confirm step. The desktop app opens the browser at
 * `/auth/desktop/sign-in?key=…` (`src/auth/desktop-sign-in.ts`), which sends a
 * signed-in person here. They do not sign in again: one click on Continue
 * asks for the one-time code, which only the app that made the key can read.
 * Nothing is made when the page loads.
 */

import type { SearchSchemaInput } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import * as z from "zod/mini";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { useOsIdentity } from "@/lib/use-os-identity";
import { buildBrokerStartPath } from "@/shared/session-status";

const searchSchema = z.object({
	key: z.catch(z.optional(z.string()), undefined),
});

async function requestCode(key: string): Promise<string> {
	const response = await fetch("/auth/desktop/sign-in", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ key }),
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
							you just chose to sign in from the Tedix app.
						</Text>
						{code.error ? (
							<div role="alert">
								<Text as="p" role="body" tone="error">
									{code.error.message}
								</Text>
							</div>
						) : null}
						<Button
							className="mx-auto mt-1 flex w-full sm:w-auto"
							loading={code.isPending}
							disabled={code.isPending}
							onClick={() => code.mutate(key)}
						>
							Continue
						</Button>
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

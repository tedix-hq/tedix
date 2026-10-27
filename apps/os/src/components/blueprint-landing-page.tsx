import type { OsBlueprintPublicPage } from "@tedix/api-contract/contracts/os-workspaces";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import { Text } from "@/components/kumo/text";
import { followDeviceTheme } from "@/lib/theme";

/**
 * The shareable page for one gallery blueprint. It opens without an account:
 * it reads only the public blueprint summary (no organization or member data)
 * and its one action sends the visitor to sign in, then to the gallery's
 * existing install flow for this blueprint.
 */

type PageState =
	| { status: "loading" }
	| { status: "ready"; blueprint: OsBlueprintPublicPage }
	| { status: "unavailable" };

export function blueprintShareUrl(origin: string, blueprintId: string): string {
	return `${origin}/blueprint/${encodeURIComponent(blueprintId)}`;
}

export function blueprintInstallPath(blueprintId: string): string {
	return `/blueprints?install=${encodeURIComponent(blueprintId)}`;
}

function NeedsList({
	title,
	items,
}: {
	title: string;
	items: readonly string[];
}) {
	if (items.length === 0) return null;
	return (
		<div className="grid gap-1">
			<Text as="h3" role="label" tone="secondary" className="m-0">
				{title}
			</Text>
			<ul className="m-0 flex list-none flex-wrap gap-2 p-0">
				{items.map((item) => (
					<li key={item}>
						<Badge variant="outline">{item}</Badge>
					</li>
				))}
			</ul>
		</div>
	);
}

export function BlueprintLanding({
	blueprint,
	shareUrl,
}: {
	blueprint: OsBlueprintPublicPage;
	shareUrl: string;
}) {
	const { needs } = blueprint;
	const needsSomething =
		needs.connections.length + needs.resources.length + needs.skills.length > 0;
	return (
		<main className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-8 sm:py-12">
			<header className="grid gap-2">
				<Text as="p" role="label" tone="secondary" className="m-0">
					Tedix blueprint
					{blueprint.featured ? " · Featured" : ""}
				</Text>
				<Text as="h1" role="title" tone="strong" className="m-0 break-words">
					{blueprint.name}
				</Text>
				{blueprint.description && (
					<Text as="p" role="body" tone="secondary" className="m-0">
						{blueprint.description}
					</Text>
				)}
			</header>

			<div className="flex flex-col gap-2 sm:flex-row">
				<Button
					render={<a href={blueprintInstallPath(blueprint.id)} />}
					className="w-full sm:w-auto"
				>
					Use this blueprint
				</Button>
			</div>
			<Text as="p" role="label" tone="secondary" className="m-0">
				You will sign in first, then pick a name for your copy.
			</Text>

			<section aria-labelledby="blueprint-does" className="grid gap-2">
				<Text
					as="h2"
					role="section"
					tone="strong"
					className="m-0"
					id="blueprint-does"
				>
					What it sets up
				</Text>
				{blueprint.apps.length === 0 ? (
					<Text as="p" role="body" tone="secondary" className="m-0">
						An empty workspace you can add apps to.
					</Text>
				) : (
					<ul className="m-0 grid gap-1 pl-5">
						{blueprint.apps.map((app) => (
							<li key={app.name}>
								<Text as="span" role="body">
									{app.name}
								</Text>
							</li>
						))}
					</ul>
				)}
				<NeedsList
					title="What it produces"
					items={needs.outputs.map((output) => output.title)}
				/>
			</section>

			<section aria-labelledby="blueprint-needs" className="grid gap-3">
				<Text
					as="h2"
					role="section"
					tone="strong"
					className="m-0"
					id="blueprint-needs"
				>
					What it needs
				</Text>
				{needsSomething ? (
					<>
						<NeedsList
							title="Connected accounts"
							items={needs.connections.map((c) => c.providerId)}
						/>
						<NeedsList
							title="Things you pick"
							items={needs.resources.map((r) => r.label)}
						/>
						<NeedsList title="Skills" items={needs.skills.map((s) => s.slug)} />
					</>
				) : (
					<Text as="p" role="body" tone="secondary" className="m-0">
						Nothing to connect first.
					</Text>
				)}
			</section>

			<section aria-labelledby="blueprint-share" className="grid gap-2">
				<Text
					as="h2"
					role="section"
					tone="strong"
					className="m-0"
					id="blueprint-share"
				>
					Share this page
				</Text>
				<ClipboardText text={shareUrl} className="w-full min-w-0" />
			</section>
		</main>
	);
}

export function BlueprintLandingPage({ blueprintId }: { blueprintId: string }) {
	const [state, setState] = useState<PageState>({ status: "loading" });

	useEffect(() => followDeviceTheme(), []);

	useEffect(() => {
		let alive = true;
		void (async (): Promise<PageState> => {
			const response = await fetch(
				`/api/public/blueprints/${encodeURIComponent(blueprintId)}`,
				{ credentials: "omit" },
			);
			if (!response.ok) return { status: "unavailable" };
			const body = (await response.json()) as {
				blueprint: OsBlueprintPublicPage;
			};
			return { status: "ready", blueprint: body.blueprint };
		})()
			.catch((): PageState => ({ status: "unavailable" }))
			.then((next) => {
				if (alive) setState(next);
			});
		return () => {
			alive = false;
		};
	}, [blueprintId]);

	if (state.status === "loading")
		return (
			<main
				className="mx-auto grid min-h-dvh w-full max-w-2xl place-items-center p-4"
				aria-busy
			>
				<Text as="p" role="body" tone="secondary" className="m-0">
					Loading the blueprint…
				</Text>
			</main>
		);
	if (state.status === "unavailable")
		return (
			<main className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center p-4">
				<Alert variant="destructive">
					<AlertTitle>This blueprint is not available</AlertTitle>
					<AlertDescription>
						It may have been removed from the gallery. Ask the person who sent
						the link for a new one.
					</AlertDescription>
				</Alert>
			</main>
		);
	return (
		<BlueprintLanding
			blueprint={state.blueprint}
			shareUrl={blueprintShareUrl(window.location.origin, blueprintId)}
		/>
	);
}

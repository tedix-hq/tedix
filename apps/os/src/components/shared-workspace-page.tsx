import { ArrowRight, ShieldCheck } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { WidgetFrame } from "@/components/widget-frame";
import { ROLE_LABEL } from "@/components/workspace-share-dialog";
import { osApi } from "@/lib/api";
import { gadgetWidgetTargetFromManifest } from "@/lib/gadget-widget-target";
import { osQueryKeys } from "@/lib/os-query-options";

type Opened = Awaited<ReturnType<typeof osApi.osCollaborators.open>>;

type PageState =
	| { status: "loading" }
	| { status: "ready"; opened: Opened }
	| { status: "denied" }
	| { status: "missing" };

/** Read and strip the `#share=` key so it never lingers in the address bar. */
export function takeShareKey(): string | undefined {
	const key = new URLSearchParams(window.location.hash.slice(1)).get("share");
	if (key !== null)
		window.history.replaceState(
			null,
			"",
			window.location.pathname + window.location.search,
		);
	return key ?? undefined;
}

function SharedApp({ app }: { app: Opened["apps"][number] }) {
	const target = gadgetWidgetTargetFromManifest(
		app.entry
			? ({ entry: app.entry, capabilities: [] } as OsGadgetManifest)
			: null,
	);
	return (
		<section className="grid gap-2" aria-label={app.name}>
			<div className="grid gap-0.5">
				<Text as="h2" role="section" className="m-0">
					{app.name}
				</Text>
				{app.description ? (
					<Text as="p" role="body" tone="secondary" className="m-0">
						{app.description}
					</Text>
				) : null}
			</div>
			{target ? (
				<WidgetFrame
					appSlug={target.appSlug}
					resourceUri={target.resourceUri}
					title={app.name}
				/>
			) : (
				<Text role="label" tone="secondary" className="m-0">
					This app has no view to show yet.
				</Text>
			)}
		</section>
	);
}

/**
 * A workspace someone shared with you. Opens it as yourself (redeeming a
 * share key from the URL fragment once), then shows only what your role
 * allows: a `use` collaborator sees the apps and nothing else.
 */
export function SharedWorkspacePage({ workspaceId }: { workspaceId: string }) {
	const [state, setState] = useState<PageState>({ status: "loading" });
	const queryClient = useQueryClient();
	// The key is redeemed once; a reconnect must never silently re-redeem it.
	const opening = useRef<Promise<Opened> | null>(null);

	useEffect(() => {
		let alive = true;
		const shareKey = takeShareKey();
		opening.current ??= osApi.osCollaborators.open({
			workspaceId,
			...(shareKey ? { shareKey } : {}),
		});
		opening.current.then(
			(opened) => {
				if (!alive) return;
				setState({ status: "ready", opened });
				void queryClient.invalidateQueries({
					queryKey: osQueryKeys.collaborators(),
				});
			},
			(error: unknown) => {
				if (!alive) return;
				const code =
					typeof error === "object" && error !== null && "code" in error
						? (error as { code: unknown }).code
						: null;
				setState({ status: code === "NOT_FOUND" ? "missing" : "denied" });
			},
		);
		return () => {
			alive = false;
		};
	}, [workspaceId, queryClient]);

	if (state.status === "loading") {
		return (
			<main className="grid min-h-dvh place-items-center p-4" aria-busy>
				<Text role="body" tone="secondary">
					Opening workspace…
				</Text>
			</main>
		);
	}
	if (state.status !== "ready") {
		return (
			<main className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center px-4">
				<Alert variant="destructive" data-access-denied>
					<AlertTitle>
						{state.status === "missing"
							? "This workspace doesn't exist"
							: "You don't have access"}
					</AlertTitle>
					<AlertDescription>
						{state.status === "missing"
							? "It may have been deleted."
							: "Ask the person who shared it to add you again."}
					</AlertDescription>
				</Alert>
			</main>
		);
	}
	const { opened } = state;
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
			<header className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<div className="grid min-w-0 flex-1 gap-0.5">
					<Text as="h1" role="title" className="m-0 truncate">
						{opened.workspace.title}
					</Text>
					<Text as="p" role="label" tone="secondary" className="m-0">
						{opened.workspace.ownerName
							? `Shared by ${opened.workspace.ownerName}`
							: "Shared with you"}{" "}
						· opened with your own Tedix sign-in
					</Text>
				</div>
				<Badge variant="secondary">
					<ShieldCheck size={13} /> {ROLE_LABEL[opened.role]}
				</Badge>
				{opened.role === "build" ? (
					<Button
						size="sm"
						onClick={() =>
							window.location.assign(
								`/workspace/${encodeURIComponent(opened.workspace.id)}`,
							)
						}
					>
						Open workspace <ArrowRight size={14} />
					</Button>
				) : null}
			</header>
			{opened.apps.length === 0 ? (
				<Text role="body" tone="secondary" className="m-0">
					No apps in this workspace yet.
				</Text>
			) : (
				opened.apps.map((app) => <SharedApp key={app.id} app={app} />)
			)}
		</main>
	);
}

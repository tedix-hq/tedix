import { useQueries, useQuery } from "@tanstack/react-query";
import { WorkspaceAppRenderer } from "@/components/workspace-app-renderer";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import {
	activeWorkspacesQueryOptions,
	canvasGadgetsQueryOptions,
	canvasGadgetDetailQueryOptions,
} from "@/lib/os-query-options";
import { OS_COPY } from "@/shared/os-copy";

/** Work selects installed apps through the viewer's ordinary workspace permissions. */
export function WorkHome({ view = "deck" }: { view?: "deck" | "feed" }) {
	const workspaces = useQuery(activeWorkspacesQueryOptions());
	const lists = useQueries({
		queries: (workspaces.data?.items ?? []).map((workspace) =>
			canvasGadgetsQueryOptions(workspace.id),
		),
	});
	const gadgets = lists
		.flatMap((list) => list.data?.items ?? [])
		.filter((gadget) => gadget.status === "active");
	const details = useQueries({
		queries: gadgets.map((gadget) =>
			canvasGadgetDetailQueryOptions(gadget.workspaceId, gadget.id),
		),
	});
	const apps = details.flatMap((detail) => {
		const manifest = detail.data?.currentRevision?.manifest;
		return manifest?.navigation?.work && detail.data
			? [{ manifest, gadget: detail.data.gadget }]
			: [];
	});
	const selected = apps.find((app) => app.manifest.navigation?.work === view);
	const pending =
		workspaces.isPending ||
		lists.some((list) => list.isPending) ||
		details.some((detail) => detail.isPending);
	const failed =
		workspaces.isError ||
		lists.some((list) => list.isError) ||
		details.some((detail) => detail.isError);
	return (
		<div className="grid min-w-0 gap-4 p-4 pb-24 sm:p-6">
			<nav
				aria-label={OS_COPY.decisionDeck.workViews}
				className="fixed inset-x-0 bottom-0 z-10 flex justify-center gap-8 border-t border-kumo-line bg-kumo-base px-4 py-3 sm:static sm:justify-start sm:border-0"
			>
				<Link href="/work" aria-current={view === "deck" ? "page" : undefined}>
					{OS_COPY.decisionDeck.deck}
				</Link>
				<Link
					href="/work?view=feed"
					aria-current={view === "feed" ? "page" : undefined}
				>
					{OS_COPY.decisionDeck.feed}
				</Link>
			</nav>
			{selected ? (
				<WorkspaceAppRenderer
					manifest={selected.manifest}
					workspaceId={selected.gadget.workspaceId}
				/>
			) : pending ? (
				<Text>{OS_COPY.decisionDeck.loadingApp}</Text>
			) : (
				<div className="grid gap-3">
					<Text>
						{failed
							? OS_COPY.decisionDeck.appUnavailable
							: OS_COPY.decisionDeck.installApp}
					</Text>
					{failed && (
						<Button
							variant="outline"
							onClick={() => {
								void workspaces.refetch();
								lists.forEach((list) => void list.refetch());
								details.forEach((detail) => void detail.refetch());
							}}
						>
							{OS_COPY.decisionDeck.retry}
						</Button>
					)}
					<Link href="/workspaces">{OS_COPY.decisionDeck.openWorkspaces}</Link>
					<Link href="/work/attention">
						{OS_COPY.decisionDeck.workOverview}
					</Link>
				</div>
			)}
		</div>
	);
}

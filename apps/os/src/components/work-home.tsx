import { DeckRemainingContext } from "@/components/deck-presentation-context";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	osQuery,
	workInteractionDetailQueryOptions,
} from "@/lib/os-query-options";
import { osApi } from "@/lib/api";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { WorkspaceAppRenderer } from "@/components/workspace-app-renderer";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Page } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { useWorkApps } from "@/lib/use-work-apps";
import { useDeckCount } from "@/lib/use-deck-count";
import {
	WORK_APP_ENTRIES,
	type WorkFeedFilter,
	type WorkHomeSearch,
} from "@/lib/work-home-search";
import { useDocumentTitle } from "@/lib/use-document-title";
import { OS_COPY } from "@/shared/os-copy";
import { useOsLocale } from "@/lib/use-os-locale";
import "./feed-deck.css";

/** Work is an entry to installed apps, using the same renderer as their workspace. */
export function WorkHome({
	search = {},
	onFilterChange,
}: {
	search?: WorkHomeSearch;
	onFilterChange?: (filter: WorkFeedFilter) => void;
}) {
	useOsLocale();
	const { apps, pending, failed, truncated, retry } = useWorkApps();
	const [remaining, setRemaining] = useState<number | null>(null);
	const defaultApp =
		apps.find((app) => app.role && app.manifest.navigation?.workDefault) ??
		(pending ? undefined : apps.find((app) => app.role === "feed"));
	const selected = search.app
		? apps.find((app) => app.manifest.entry === WORK_APP_ENTRIES[search.app!])
		: search.view
			? apps.find((app) => app.role === search.view)
			: defaultApp;
	const deck = apps.find((app) => app.role === "deck");
	const config = DecisionDeckConfigSchema.safeParse(deck?.manifest.config);
	const decisions = useDeckCount(
		config.success ? config.data : undefined,
		deck?.gadget.workspaceId,
	);
	const client = useQueryClient();
	const install = useMutation({
		mutationFn: () => osApi.osWorkspaces.gadgets.installWorkDefaults({}),
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: osQuery.osWorkspaces.key() });
		},
	});
	const prefetchIds = decisions.requests
		.slice(0, 1)
		.map((row) => row.request.id)
		.join(",");
	useEffect(() => {
		if (selected?.role !== "deck" || !prefetchIds) return;
		for (const id of prefetchIds.split(","))
			void client.prefetchQuery(workInteractionDetailQueryOptions(id));
	}, [client, selected?.role, prefetchIds]);
	const copy = OS_COPY.workHome;
	useDocumentTitle(
		`${selected?.role === "feed" ? copy.feed : selected?.role === "deck" ? copy.deck : (selected?.gadget.name ?? copy.feed)} · Work`,
	);
	const decide = (
		<Button
			variant="ghost"
			render={<a href="/work?view=deck" />}
			title={decisions.more ? copy.loadedCount : undefined}
		>
			{!config.success || decisions.failed
				? OS_COPY.feed.deck
				: decisions.pending
					? copy.deck
					: decisions.count === 0
						? OS_COPY.feed.deckClear
						: OS_COPY.feed.decisionsWaiting(String(decisions.count))}
		</Button>
	);
	const appLinks = (
		<nav
			aria-label={copy.apps}
			className="flex flex-wrap items-center gap-x-4 gap-y-2"
		>
			<Text weight="semibold">{copy.apps}</Text>
			{apps
				.filter((app) => !app.role)
				.map(({ gadget }) => (
					<Link
						key={gadget.id}
						href={`/workspace/${gadget.workspaceId}?workpiece=gadget:${gadget.id}&pane=workpiece`}
						variant="navigation"
					>
						{gadget.name}
					</Link>
				))}
			{(failed || truncated) && <Link href="/workspaces">{copy.moreApps}</Link>}
		</nav>
	);
	return (
		<Page width="full" className="fd-work-home">
			{selected?.role !== "feed" && (
				<nav aria-label={copy.views} className="fd-work-nav">
					<Link href="/work?view=feed" variant="navigation">
						{copy.feed}
					</Link>
					<Link
						href="/work?view=deck"
						variant="navigation"
						aria-current={selected?.role === "deck" ? "page" : undefined}
						title={decisions.more ? copy.loadedCount : undefined}
					>
						{copy.deck}{" "}
						<span>
							{!config.success || decisions.failed
								? "—"
								: decisions.pending
									? "…"
									: `${remaining ?? "…"}`}
						</span>
					</Link>
				</nav>
			)}
			{selected ? (
				<DeckRemainingContext.Provider value={setRemaining}>
					<WorkspaceAppRenderer
						key={selected.gadget.id}
						manifest={selected.manifest}
						workspaceId={selected.gadget.workspaceId}
						activityFeed={{
							filter: search.filter ?? "all",
							onFilterChange,
							decide,
							apps: appLinks,
						}}
					/>
				</DeckRemainingContext.Provider>
			) : pending ? (
				<Text>{copy.loading}</Text>
			) : (
				<div className="grid gap-3">
					<Text>
						{failed
							? copy.unavailable
							: search.app
								? copy.missing
								: copy.install}
					</Text>
					{failed && (
						<Button variant="outline" onClick={retry}>
							{copy.retry}
						</Button>
					)}
					{!failed && !search.app && (
						<Button
							onClick={() => install.mutate()}
							disabled={install.isPending}
						>
							{install.isPending ? copy.installing : copy.installDefaults}
						</Button>
					)}
					{install.isError && (
						<div role="alert">
							<Text>{copy.installFailed}</Text>
						</div>
					)}
					{failed && <Link href="/workspaces">{copy.workspaces}</Link>}
				</div>
			)}
			{selected && failed && (
				<Text aria-live="polite" tone="secondary">
					{copy.partial}
				</Text>
			)}
		</Page>
	);
}

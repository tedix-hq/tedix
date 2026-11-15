import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { osQuery } from "@/lib/os-query-options";
import { osApi } from "@/lib/api";
import { WorkspaceAppRenderer } from "@/components/workspace-app-renderer";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Page, PageTitle } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { Skeleton } from "@/components/kumo/skeleton";
import { useWorkApps } from "@/lib/use-work-apps";
import {
	selectedWorkApp,
	showsWorkOverview,
	workPortfolioLead,
	type WorkFeedFilter,
	type WorkHomeSearch,
} from "@/lib/work-home-search";
import { useDocumentTitle } from "@/lib/use-document-title";
import { OS_COPY } from "@/shared/os-copy";
import { useOsLocale } from "@/lib/use-os-locale";
import { WorkHomeOverview } from "@/components/work-home-overview";
import "./feed-deck.css";

const Portfolio = lazy(() =>
	import("./organization-portfolio-app").then((m) => ({
		default: m.OrganizationPortfolioApp,
	})),
);

/**
 * Work opens installed apps with the same renderer as their workspace. The
 * overview and the Goals and Projects pages read the organization's own Work
 * records, so they show without any app being installed.
 */
export function WorkHome({
	search = {},
	onFilterChange,
}: {
	search?: WorkHomeSearch;
	onFilterChange?: (filter: WorkFeedFilter) => void;
}) {
	useOsLocale();
	const { apps, pending, failed, truncated, retry } = useWorkApps();
	const defaultApp =
		apps.find((app) => app.role && app.manifest.navigation?.workDefault) ??
		(pending ? undefined : apps.find((app) => app.role === "feed"));
	const selected = search.app
		? selectedWorkApp(apps, search.app)
		: search.view
			? apps.find((app) => app.role === search.view)
			: defaultApp;
	const client = useQueryClient();
	const install = useMutation({
		mutationFn: () => osApi.osWorkspaces.gadgets.installWorkDefaults({}),
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: osQuery.osWorkspaces.key() });
		},
	});
	const copy = OS_COPY.workHome;
	const portfolioLead = workPortfolioLead(search);
	const overview = showsWorkOverview(search, {
		pending,
		role: selected?.role ?? null,
	});
	const title = portfolioLead
		? portfolioLead === "projects"
			? "Projects"
			: "Goals"
		: selected?.role === "feed"
			? copy.feed
			: selected?.role === "deck"
				? copy.deck
				: (selected?.gadget.name ?? copy.feed);
	useDocumentTitle(`${title} · Work`);
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
	if (portfolioLead)
		return (
			<Page width="full" className="fd-work-home">
				<Suspense fallback={<Skeleton className="h-24 w-full" />}>
					<Portfolio lead={portfolioLead} />
				</Suspense>
			</Page>
		);
	return (
		<Page width="full" className="fd-work-home">
			{overview && (selected || pending) && <WorkHomeOverview />}
			{(!selected || selected.role) && (
				<PageTitle className="sr-only">{title}</PageTitle>
			)}
			{selected ? (
				<WorkspaceAppRenderer
					key={selected.gadget.id}
					manifest={
						search.project && selected.role === "deck"
							? {
									...selected.manifest,
									config: {
										...selected.manifest.config,
										projectId: search.project,
									},
								}
							: selected.manifest
					}
					workspaceId={selected.gadget.workspaceId}
					activityFeed={{
						filter: search.filter ?? "all",
						projectId: search.project,
						day: search.day,
						onFilterChange,
						apps: appLinks,
						showRunningNow: !overview,
					}}
				/>
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
							loading={install.isPending}
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
			{/* With no Activity app the failure or setup line keeps the top. */}
			{overview && !selected && !pending && <WorkHomeOverview />}
			{selected && failed && (
				<Text aria-live="polite" tone="secondary">
					{copy.partial}
				</Text>
			)}
		</Page>
	);
}

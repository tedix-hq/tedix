import { LoadingArea } from "@/components/loading-area";
import { lazy, Suspense } from "react";
import { WorkspaceAppRenderer } from "@/components/workspace-app-renderer";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Page, PageTitle } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { defaultWorkApps, useWorkApps } from "@/lib/use-work-apps";
import {
	selectedWorkApp,
	showsWorkOverview,
	workPortfolioLead,
	type WorkFeedFilter,
	type WorkHomeSearch,
} from "@/lib/work-home-search";
import { useDocumentTitle } from "@/lib/use-document-title";
import { OS_COPY } from "@/shared/os-copy";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { useOsLocale } from "@/lib/use-os-locale";
import { InstallWorkAppearance, WorkAppearance } from "./work-appearance";
import { WorkGadgetPresentation } from "./work-gadget-presentation";
import { WorkHomeOverview } from "@/components/work-home-overview";
import "./feed-deck.css";

const Portfolio = lazy(() =>
	import("./organization-portfolio-app").then((m) => ({
		default: m.OrganizationPortfolioApp,
	})),
);

export function WorkHome({
	search = {},
	onFilterChange,
}: {
	search?: WorkHomeSearch;
	onFilterChange?: (filter: WorkFeedFilter) => void;
}) {
	useOsLocale();
	const authority = useOsOperationalContext().data?.authority.permissions;
	const canCustomize = authority?.some(
		(permission) =>
			permission === "os:author" || permission === "settings:manage",
	);
	const { apps, pending, failed, truncated, retry } = useWorkApps();
	const defaultApp =
		apps.find((app) => app.role && app.manifest.navigation?.workDefault) ??
		(pending ? undefined : apps.find((app) => app.role === "feed"));
	const selected = search.app
		? selectedWorkApp(apps, search.app)
		: search.view
			? apps.find((app) => app.role === search.view)
			: defaultApp;
	const role = selected?.role ?? (search.view === "deck" ? "deck" : "feed");
	const manifest =
		selected?.manifest ??
		(!search.app && !pending && !failed && !truncated
			? defaultWorkApps[role]
			: undefined);
	const copy = OS_COPY.workHome;
	const portfolioLead = workPortfolioLead(search);
	const overview = showsWorkOverview(search, {
		pending,
		role: selected?.role ?? null,
	});
	const title = portfolioLead
		? portfolioLead === "projects"
			? "Projects"
			: OS_COPY.work.objectives
		: selected && !selected.role
			? selected.gadget.name
			: copy[role];
	useDocumentTitle(`${title} · Work`);
	const appLinks = (apps.some((app) => !app.role) || failed || truncated) && (
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
				<Suspense fallback={<LoadingArea />}>
					<Portfolio lead={portfolioLead} />
				</Suspense>
			</Page>
		);
	const content = manifest ? (
		<WorkspaceAppRenderer
			key={selected?.gadget.id ?? role}
			manifest={
				search.project && role === "deck"
					? {
							...manifest,
							config: {
								...manifest.config,
								projectId: search.project,
							},
						}
					: manifest
			}
			workspaceId={selected?.gadget.workspaceId}
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
			<Text>{failed || truncated ? copy.unavailable : copy.missing}</Text>
			{(failed || truncated) && (
				<Button variant="outline" onClick={retry}>
					{copy.retry}
				</Button>
			)}
			{failed && <Link href="/workspaces">{copy.workspaces}</Link>}
		</div>
	);
	const standardView = overview ? (
		<WorkHomeOverview>{content}</WorkHomeOverview>
	) : (
		content
	);
	const presentationId = selected?.manifest.config?.presentationGadgetId;
	const usePresentation =
		selected?.role &&
		typeof presentationId === "string" &&
		!search.project &&
		(!search.filter || search.filter === "all") &&
		!search.day &&
		!search.source;
	return (
		<Page width="full" className="fd-work-home">
			{/* The page heading comes first, so overview sections sit under it. */}
			{(!selected || selected.role) && (
				<div className="flex items-center justify-between gap-3">
					<PageTitle>{title}</PageTitle>
					{canCustomize &&
						!selected &&
						!search.app &&
						!pending &&
						!failed &&
						!truncated && <InstallWorkAppearance />}
					{selected?.role &&
						selected.manifest.entry === defaultWorkApps[selected.role].entry &&
						canCustomize && (
							<WorkAppearance
								key={selected.gadget.id}
								role={selected.role}
								gadget={selected.gadget}
								revision={selected.revision}
							/>
						)}
				</div>
			)}
			{usePresentation ? (
				<WorkGadgetPresentation
					key={presentationId}
					workspaceId={selected.gadget.workspaceId}
					gadgetId={presentationId}
					standardView={standardView}
				/>
			) : (
				standardView
			)}
			{selected && failed && (
				<Text aria-live="polite" tone="secondary">
					{copy.partial}
				</Text>
			)}
		</Page>
	);
}

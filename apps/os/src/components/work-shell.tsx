import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Pulse, Stack } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import {
	DeckRemainingContext,
	WorkToolbarTargetContext,
} from "@/components/deck-presentation-context";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { useDeckCount } from "@/lib/use-deck-count";
import { WORK_COUNT_DEFINITIONS } from "@/lib/work-counts";
import { Link } from "@/components/kumo/link";
import { OS_COPY } from "@/shared/os-copy";
import { defaultWorkApps, useWorkApps } from "@/lib/use-work-apps";
import { todayShortcut } from "@/lib/today-digest";
import { WorkMoreViewsMenu } from "@/components/work-more-views-menu";
import { WorkAgentNavigation } from "@/components/work-agent-navigation";
import { TabBarContent } from "@/components/tab-bar-content";
import { workAgentNavigation } from "@/lib/work-agent-navigation";
// The shell's own bar (.fd-work-bar, .fd-work-navigation) is styled here. A
// Work page that loads no Feed or Deck component (Approvals, opened directly)
// otherwise rendered the bar unstyled: three stacked links over the content.
import "./feed-deck.css";

const WorkWebMcpTools = lazy(() =>
	import("@/components/work-webmcp-tools").then((module) => ({
		default: module.WorkWebMcpTools,
	})),
);

export function WorkShell() {
	const { apps, pending, failed, truncated } = useWorkApps();
	const navigate = useNavigate();
	const location = useRouterState({ select: ({ location }) => location });
	const agentNavigation = workAgentNavigation(
		apps,
		location.pathname,
		location.search as Record<string, unknown>,
	);
	const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
		null,
	);
	const [remaining, setRemaining] = useState<number | null>(null);
	const catalogReady = !pending && !failed && !truncated;
	const deckApp = apps.find((app) => app.role === "deck");
	const config = DecisionDeckConfigSchema.safeParse(
		deckApp
			? deckApp.manifest.config
			: catalogReady
				? defaultWorkApps.deck.config
				: undefined,
	);
	const decisions = useDeckCount(config.success ? config.data : undefined);
	const defaultView =
		(
			apps.find((app) => app.role && app.manifest.navigation?.workDefault) ??
			apps.find((app) => app.role === "feed")
		)?.role ?? (catalogReady ? "feed" : undefined);
	const view = useRouterState({
		select: (state) => {
			const search = state.location.search as {
				view?: "deck" | "feed" | "items";
				app?: unknown;
			};
			return state.location.pathname.replace(/\/$/, "") === "/work" &&
				!search.app
				? (search.view ?? defaultView)
				: undefined;
		},
	});
	const deck = view === "deck";
	const feed = view === "feed";
	const decisionCount =
		config.success &&
		((deck && remaining !== null) || (!decisions.pending && !decisions.failed))
			? ((deck ? remaining : null) ?? decisions.count)
			: null;
	const hasToday = apps.some(
		(app) => app.role === "feed" && app.manifest.config?.today,
	);
	useEffect(() => {
		const jump = (event: KeyboardEvent) => {
			if (!hasToday || feed || event.defaultPrevented || !todayShortcut(event))
				return;
			event.preventDefault();
			void navigate({
				to: "/work",
				search: { view: "feed" },
				hash: "today-heading",
			});
		};
		document.addEventListener("keydown", jump);
		return () => document.removeEventListener("keydown", jump);
	}, [hasToday, feed, navigate]);
	return (
		<WorkToolbarTargetContext.Provider value={toolbarTarget}>
			<div className="fd-work-shell flex min-h-0 flex-1 flex-col">
				<Suspense fallback={null}>
					<WorkWebMcpTools />
				</Suspense>
				{agentNavigation.active && (
					<WorkAgentNavigation tabs={agentNavigation.tabs} />
				)}
				<DeckRemainingContext.Provider value={setRemaining}>
					<Outlet />
				</DeckRemainingContext.Provider>
				<div className="fd-work-bar">
					<nav
						data-slot="bottom-nav"
						data-focus-ring="inset"
						data-tab-bar
						aria-label={OS_COPY.workHome.views}
						className="fd-work-navigation sticky bottom-0 max-sm:tab-bar"
					>
						<Link
							href="/work?view=feed"
							variant="navigation"
							aria-current={feed ? "page" : undefined}
							className="flex-1 justify-center sm:flex-none"
						>
							<TabBarContent
								icon={<Pulse size={24} weight={feed ? "bold" : "regular"} />}
								label={OS_COPY.workHome.feed}
							/>
						</Link>
						<Link
							href="/work?view=deck"
							variant="navigation"
							aria-current={deck ? "page" : undefined}
							className="flex-1 justify-center sm:flex-none"
						>
							<TabBarContent
								icon={<Stack size={24} weight={deck ? "fill" : "regular"} />}
								label={
									feed &&
									decisions.count > 0 &&
									!decisions.pending &&
									!decisions.failed ? (
										<>
											<span className="max-sm:hidden">Needs your answer</span>
											<span className="sm:hidden">{OS_COPY.workHome.deck}</span>
										</>
									) : (
										OS_COPY.workHome.deck
									)
								}
								count={decisionCount}
								more={decisions.more}
								countTitle={WORK_COUNT_DEFINITIONS.decisions}
								countClassName="type-tedix-label tabular-nums text-kumo-subtle"
							/>
						</Link>
						<WorkMoreViewsMenu apps={apps} agentNavigation={agentNavigation} />
					</nav>
					{(feed || deck) && (
						<div ref={setToolbarTarget} className="fd-work-toolbar-slot" />
					)}
				</div>
			</div>
		</WorkToolbarTargetContext.Provider>
	);
}

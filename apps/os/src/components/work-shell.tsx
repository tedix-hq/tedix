import {
	Link,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import {
	DeckRemainingContext,
	WorkToolbarTargetContext,
} from "@/components/deck-presentation-context";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { useDeckCount } from "@/lib/use-deck-count";
import { cn } from "@/lib/utils";
import { OS_COPY } from "@/shared/os-copy";
import { useWorkApps } from "@/lib/use-work-apps";
import { todayShortcut } from "@/lib/today-digest";
import { WorkMoreViewsMenu } from "@/components/work-more-views-menu";

const WorkWebMcpTools = lazy(() =>
	import("@/components/work-webmcp-tools").then((module) => ({
		default: module.WorkWebMcpTools,
	})),
);

export function WorkShell() {
	const { apps } = useWorkApps();
	const navigate = useNavigate();
	const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
		null,
	);
	const [remaining, setRemaining] = useState<number | null>(null);
	const deckApp = apps.find((app) => app.role === "deck");
	const config = DecisionDeckConfigSchema.safeParse(deckApp?.manifest.config);
	const decisions = useDeckCount(
		config.success ? config.data : undefined,
		deckApp?.gadget.workspaceId,
	);
	const defaultView = (
		apps.find((app) => app.role && app.manifest.navigation?.workDefault) ??
		apps.find((app) => app.role === "feed")
	)?.role;
	const view = useRouterState({
		select: (state) => {
			const search = state.location.search as {
				view?: "deck" | "feed";
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
				<DeckRemainingContext.Provider value={setRemaining}>
					<Outlet />
				</DeckRemainingContext.Provider>
				<div className="fd-work-bar">
					<nav
						data-slot="bottom-nav"
						data-focus-ring="inset"
						aria-label={OS_COPY.workHome.views}
						className="fd-work-navigation sticky bottom-0"
					>
						<Link
							to="/work"
							search={{ view: "feed" }}
							aria-current={feed ? "page" : undefined}
							className={cn(
								"flex min-h-12 flex-1 items-center justify-center gap-2 text-kumo-subtle no-underline sm:flex-none",
								feed &&
									"font-semibold border-b-2 border-current text-kumo-default",
							)}
						>
							{OS_COPY.workHome.feed}
						</Link>
						<Link
							to="/work"
							search={{ view: "deck" }}
							aria-current={deck ? "page" : undefined}
							className={cn(
								"flex min-h-12 flex-1 items-center justify-center gap-2 text-kumo-subtle no-underline sm:flex-none",
								deck &&
									"font-semibold border-b-2 border-current text-kumo-default",
							)}
						>
							{OS_COPY.workHome.deck}
							{config.success &&
								((deck && remaining !== null) ||
									(!decisions.pending && !decisions.failed)) && (
									<span className="type-tedix-label tabular-nums text-kumo-subtle">
										{(deck ? remaining : null) ?? decisions.count}
									</span>
								)}
						</Link>
						<WorkMoreViewsMenu />
					</nav>
					{(feed || deck) && (
						<div ref={setToolbarTarget} className="fd-work-toolbar-slot" />
					)}
				</div>
			</div>
		</WorkToolbarTargetContext.Provider>
	);
}

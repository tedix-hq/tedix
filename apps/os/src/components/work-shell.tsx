import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { OS_COPY } from "@/shared/os-copy";

const WorkWebMcpTools = lazy(() =>
	import("@/components/work-webmcp-tools").then((module) => ({
		default: module.WorkWebMcpTools,
	})),
);

export function WorkShell() {
	const deck = useRouterState({
		select: (state) =>
			state.location.pathname.replace(/\/$/, "") === "/work" &&
			(state.location.search as { view?: unknown }).view === "deck",
	});
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<Suspense fallback={null}>
				<WorkWebMcpTools />
			</Suspense>
			<Outlet />
			<nav
				data-slot="bottom-nav"
				aria-label={OS_COPY.workHome.views}
				className="sticky bottom-0 z-20 mt-auto flex shrink-0 border-kumo-line border-t bg-kumo-base pb-[env(safe-area-inset-bottom)] sm:hidden"
			>
				<Link
					to="/work"
					search={{ view: "feed" }}
					aria-current={!deck ? "page" : undefined}
					className={cn(
						"flex min-h-12 flex-1 items-center justify-center no-underline",
						!deck && "font-semibold text-kumo-brand",
					)}
				>
					{OS_COPY.workHome.feed}
				</Link>
				<Link
					to="/work"
					search={{ view: "deck" }}
					aria-current={deck ? "page" : undefined}
					className={cn(
						"flex min-h-12 flex-1 items-center justify-center no-underline",
						deck && "font-semibold text-kumo-brand",
					)}
				>
					{OS_COPY.workHome.deck}
				</Link>
			</nav>
		</div>
	);
}

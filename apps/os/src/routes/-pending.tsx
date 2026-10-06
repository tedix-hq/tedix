import { ListSkeleton } from "@/components/list-skeleton";
import { Skeleton } from "@/components/kumo/skeleton";
import { Page, PageHeader } from "@/components/kumo/page";

/**
 * The workspace route's pending state, in the WORKBENCH's own geometry: the
 * full-height chrome-free shell with its top bar, the chat pane at its default
 * width, and the stage. This used to render the content-lane `Page` shapes --
 * a small header bar and a floating block -- which belonged to the retired
 * canvas layout and read as debris on the dark shell while the route loaded.
 */
export function CanvasPending() {
	return (
		<main aria-busy className="canvas-route-shell">
			<div className="flex h-full min-h-0 w-full flex-1 flex-col">
				<div className="flex h-12 shrink-0 items-center gap-3 border-kumo-line border-b px-4">
					<Skeleton className="size-6 rounded-md" />
					<Skeleton className="h-4 w-48" />
					<div className="ml-auto flex items-center gap-2">
						<Skeleton className="h-6 w-24" />
						<Skeleton className="size-6 rounded-md" />
					</div>
				</div>
				<div className="flex min-h-0 flex-1">
					<aside className="flex w-[420px] shrink-0 flex-col gap-3 border-kumo-line border-r p-4">
						<Skeleton className="h-9 w-2/3" />
						<ListSkeleton rows={3} rowClassName="h-12" />
						<div className="mt-auto">
							<Skeleton className="h-24 rounded-2xl" />
						</div>
					</aside>
					<section className="min-w-0 flex-1 p-4">
						<Skeleton className="h-full min-h-64" />
					</section>
				</div>
			</div>
		</main>
	);
}

/**
 * The workbench STAGE only, for the tick a deferred stage panel's chunk takes
 * to arrive. The shell, chat pane and resource rail are already painted by
 * then, so this fills the workpiece area alone.
 */
export function CanvasStagePending() {
	return (
		<div aria-busy className="h-full min-h-0 w-full p-4">
			<Skeleton className="h-full min-h-64" />
		</div>
	);
}

export function DetailPending() {
	return (
		<Page aria-busy>
			<ListSkeleton rows={1} rowClassName="h-7" />
			<ListSkeleton rows={1} rowClassName="h-20" />
			<ListSkeleton rows={3} />
		</Page>
	);
}

/** List surfaces: a header line over a run of equal rows. */
export function ListPending() {
	return (
		<Page aria-busy>
			<PageHeader>
				<div className="w-full max-w-sm">
					<ListSkeleton rows={1} rowClassName="h-9" />
				</div>
			</PageHeader>
			<ListSkeleton rows={6} />
		</Page>
	);
}

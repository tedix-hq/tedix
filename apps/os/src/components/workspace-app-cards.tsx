import { AppWindow, Cards } from "@phosphor-icons/react";
import type { CardReviewConfig } from "@tedix/api-contract/schemas/os-card-review";
import type { OsGadget } from "@tedix/api-contract/schemas/os-workspaces";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	cardReviewConfigFromManifest,
	cardSheetsForSource,
	type SheetBody,
	sourceParts,
} from "@/lib/card-review";
import {
	canvasGadgetDetailQueryOptions,
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import { cn } from "@/lib/utils";
import {
	appKindLabel,
	appPurpose,
	cardReviewSummary,
	cardsWaitingLabel,
} from "@/lib/workspace-apps";

/**
 * The apps of a workspace, shown first in the Resources pane as large cards:
 * a small preview of what the app shows now, its name and purpose, a status
 * line and an Open button. Apps are the main thing a person works in, so they
 * read as places to go rather than as rows in a list.
 */
export function WorkspaceAppCards({
	workspaceId,
	gadgets,
	selectedGadgetId,
	onOpen,
}: {
	workspaceId: string;
	gadgets: readonly Pick<OsGadget, "id" | "name" | "description">[];
	selectedGadgetId: string | null;
	onOpen: (gadgetId: string) => void;
}) {
	return (
		<ul className="workspace-app-cards" data-count={gadgets.length}>
			{gadgets.map((gadget) => (
				<li key={gadget.id} className="min-w-0">
					<WorkspaceAppCard
						workspaceId={workspaceId}
						gadget={gadget}
						selected={selectedGadgetId === gadget.id}
						onOpen={() => onOpen(gadget.id)}
					/>
				</li>
			))}
		</ul>
	);
}

function WorkspaceAppCard({
	workspaceId,
	gadget,
	selected,
	onOpen,
}: {
	workspaceId: string;
	gadget: Pick<OsGadget, "id" | "name" | "description">;
	selected: boolean;
	onOpen: () => void;
}) {
	const detail = useQuery(
		canvasGadgetDetailQueryOptions(workspaceId, gadget.id),
	);
	const manifest = detail.data?.currentRevision?.manifest;
	const review = cardReviewConfigFromManifest(manifest);
	const config = review.kind === "ok" ? review.config : null;
	const summary = useCardReviewSummary(config);
	const purpose = appPurpose(gadget, manifest, config);
	const status = config
		? summary
			? cardsWaitingLabel(summary.waiting)
			: "Counting cards…"
		: detail.data
			? appKindLabel(manifest)
			: null;
	const titleId = `workspace-app-${gadget.id}`;

	return (
		<article
			aria-labelledby={titleId}
			className={cn("workspace-app-card", selected && "bg-kumo-control")}
			data-workspace-app={gadget.id}
		>
			<Button
				variant="ghost"
				multiline
				className="workspace-app-preview"
				onClick={onOpen}
				aria-label={`Open ${gadget.name}`}
				tabIndex={-1}
			>
				{config ? (
					summary === null ? (
						<Skeleton className="h-full w-full" />
					) : summary.next ? (
						<span className="workspace-app-preview-card" aria-hidden>
							<span className="flex min-w-0 items-center gap-2">
								<Badge variant="secondary">{summary.next.channel}</Badge>
								<Text
									as="span"
									role="label"
									tone="strong"
									weight="medium"
									className="min-w-0 truncate"
								>
									{summary.next.who ||
										sourceParts(summary.next.sourceText).label}
								</Text>
							</span>
							<Text
								as="span"
								role="label"
								tone="secondary"
								className="line-clamp-2"
							>
								{summary.next.why}
							</Text>
							<span className="workspace-app-preview-actions">
								<span>Useful</span>
								<span>Not useful</span>
								<span>Do it</span>
							</span>
						</span>
					) : (
						<span className="workspace-app-preview-empty" aria-hidden>
							<Cards size={28} />
							<Text as="span" role="label" tone="secondary">
								All caught up
							</Text>
						</span>
					)
				) : (
					<span className="workspace-app-preview-empty" aria-hidden>
						<AppWindow size={28} />
					</span>
				)}
			</Button>
			<div className="workspace-app-body">
				<Text
					as="h3"
					id={titleId}
					role="section"
					tone="strong"
					weight="semibold"
					className="m-0 truncate"
				>
					{gadget.name}
				</Text>
				{purpose && (
					<Text as="p" role="body" tone="secondary" className="m-0">
						{purpose}
					</Text>
				)}
				<div className="workspace-app-footer">
					{status ? (
						<Text
							as="p"
							role="label"
							tone={summary && summary.waiting > 0 ? "strong" : "secondary"}
							weight={summary && summary.waiting > 0 ? "medium" : "normal"}
							className="m-0"
							data-workspace-app-status
						>
							{status}
						</Text>
					) : (
						<span />
					)}
					<Button size="sm" variant="default" onClick={onOpen}>
						Open app
					</Button>
				</div>
			</div>
		</article>
	);
}

/**
 * Card review's current queue, read through the same queries the app itself
 * uses, so opening the app afterwards reuses this cache.
 */
function useCardReviewSummary(config: CardReviewConfig | null) {
	const sources = config?.sources ?? [];
	const lists = useQueries({
		queries: sources.map((source) =>
			canvasOutputsQueryOptions(source.workspaceId),
		),
	});
	const sheetIds = [
		...new Set(
			sources.flatMap((source, index) =>
				cardSheetsForSource(source, lists[index]?.data?.items ?? []).map(
					(sheet) => sheet.id,
				),
			),
		),
	];
	const details = useQueries({
		queries: sheetIds.map((id) => outputDetailQueryOptions(id)),
	});
	if (!config) return null;
	const sheets = new Map<string, SheetBody>();
	sheetIds.forEach((id, index) => {
		const content = details[index]?.data?.currentRevision.content;
		if (content?.kind === "sheet")
			sheets.set(id, { columns: content.columns, rows: content.rows });
	});
	return cardReviewSummary(
		config,
		lists.map((list) => list.data?.items),
		sheets,
	);
}

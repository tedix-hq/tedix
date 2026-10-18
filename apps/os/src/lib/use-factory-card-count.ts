import { cardIsDue } from "@/lib/card-schedule";
import { useCardSchedule } from "@/lib/use-card-schedule";
import { useQueries } from "@tanstack/react-query";
import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import { cardSheetsForSource, cardsFromSheet, isOpen } from "@/lib/card-review";
import {
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import { useVisibleCardSources } from "@/lib/use-visible-card-sources";

export function useFactoryCardCount(sources: readonly CardReviewSource[]) {
	const { now, timeZone } = useCardSchedule();
	const visible = useVisibleCardSources(
		sources,
		(source) => source.workspaceId,
	);
	const outputs = useQueries({
		queries: visible.sources.map((source) =>
			canvasOutputsQueryOptions(source.workspaceId),
		),
	});
	const sheets = visible.sources.flatMap((source, index) =>
		cardSheetsForSource(source, outputs[index]?.data?.items ?? []).map(
			(sheet) => ({ source, sheet }),
		),
	);
	const details = useQueries({
		queries: sheets.map(({ sheet }) => outputDetailQueryOptions(sheet.id)),
	});
	let count = 0;
	let invalid = false;
	for (const [index, { source, sheet }] of sheets.entries()) {
		const body = details[index]?.data?.currentRevision.content;
		if (!body) continue;
		if (body.kind !== "sheet") {
			invalid = true;
			continue;
		}
		const parsed = cardsFromSheet({
			source,
			sourceIndex: index,
			outputId: sheet.id,
			sheetTitle: sheet.title,
			runCreatedAt: sheet.createdAt,
			body,
		});
		if ("missing" in parsed) invalid = true;
		else
			count += parsed.cards.filter(
				(card) => isOpen(card) && cardIsDue(card, now, timeZone),
			).length;
	}
	return {
		count,
		pending:
			visible.pending ||
			[...outputs, ...details].some((query) => query.isPending),
		failed:
			invalid ||
			visible.failed ||
			[...outputs, ...details].some((query) => query.isError),
		more: outputs.some((query) => query.data?.truncated),
	};
}

import type { DecisionLearningModel } from "@tedix/api-contract/schemas/decision-learning";
import { workRefreshOptions } from "@/lib/work-refresh";
import type { ReviewCard } from "@tedix/api-contract/utils/card-review";
import type { DeckRoutingPolicy } from "@tedix/api-contract/schemas/os-decision-deck";
import { useDeckRoutingAudit } from "@/lib/use-deck-routing-audit";
import { cardIsDue } from "@tedix/api-contract/utils/card-schedule";
import { useCardSchedule } from "@/lib/use-card-schedule";
import { useQueries } from "@tanstack/react-query";
import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import {
	cardSheetsForSource,
	cardsFromSheet,
	isOpen,
	routeFactoryCard,
	scoredCards,
} from "@tedix/api-contract/utils/card-review";
import {
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import { useVisibleCardSources } from "@/lib/use-visible-card-sources";

export function useFactoryCardCount(
	sources: readonly CardReviewSource[],
	routing?: DeckRoutingPolicy,
	model?: DecisionLearningModel,
) {
	const { now, timeZone } = useCardSchedule();
	const visible = useVisibleCardSources(
		sources,
		(source) => source.workspaceId,
	);
	const outputs = useQueries({
		queries: visible.sources.map((source) => ({
			...canvasOutputsQueryOptions(source.workspaceId),
			...workRefreshOptions,
		})),
	});
	const sheets = visible.sources.flatMap((source, index) =>
		cardSheetsForSource(source, outputs[index]?.data?.items ?? []).map(
			(sheet) => ({ source, sheet }),
		),
	);
	const details = useQueries({
		queries: sheets.map(({ sheet }) => ({
			...outputDetailQueryOptions(sheet.id),
			...workRefreshOptions,
		})),
	});
	const loaded: ReviewCard[] = [];
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
			sourceIndex: sources.indexOf(source),
			outputId: sheet.id,
			sheetTitle: sheet.title,
			runCreatedAt: sheet.createdAt,
			body,
		});
		if ("missing" in parsed) invalid = true;
		else loaded.push(...parsed.cards);
	}
	const cards: ReviewCard[] = [];
	const routes: ReturnType<typeof routeFactoryCard>[] = [];
	for (const card of scoredCards(loaded, sources, now)) {
		if (!isOpen(card) || !cardIsDue(card, now, timeZone)) continue;
		const route = routeFactoryCard(card, routing, now, model);
		routes.push(route);
		if (route.destination === "deck") cards.push(card);
	}
	useDeckRoutingAudit(routes);
	return {
		cards,
		refetch: async () => {
			await visible.refetch();
			await Promise.all(
				[...outputs, ...details].map((query) => query.refetch()),
			);
		},
		count: cards.length,
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

import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type {
	ActivityFeedConfig,
	ActivityFeedItem,
} from "@tedix/api-contract/schemas/os-activity-feed";
import type { FeedSourceState } from "@/components/activity-feed-sources";
import {
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import { cardSheetsForSource, cardsFromSheet } from "@/lib/card-review";
import { sentence } from "@/lib/activity-feed";

/** Read existing factory sheets; decisions and provider actions remain with their owners. */
export function ActivityFeedFactorySource({
	binding,
	sourceKey,
	onUpdate,
}: {
	binding: ActivityFeedConfig["factorySources"][number];
	sourceKey: string;
	onUpdate: (key: string, state: FeedSourceState) => void;
}) {
	const outputs = useQuery(
		canvasOutputsQueryOptions(binding.source.workspaceId),
	);
	const sheets = useMemo(
		() => cardSheetsForSource(binding.source, outputs.data?.items ?? []),
		[binding.source, outputs.data],
	);
	const details = useQueries({
		queries: sheets.map((s) => outputDetailQueryOptions(s.id)),
	});
	const versionKey = details
		.map((d) => `${d.dataUpdatedAt}:${d.status}`)
		.join(":");
	const state = useMemo(() => {
		const items: ActivityFeedItem[] = [];
		let failed = outputs.isError || details.some((d) => d.isError);
		for (let index = 0; index < sheets.length; index++) {
			const sheet = sheets[index]!;
			const revision = details[index]?.data?.currentRevision;
			if (!revision) continue;
			const body = revision.content;
			if (body.kind !== "sheet") {
				failed = true;
				continue;
			}
			const result = cardsFromSheet({
				source: binding.source,
				sourceIndex: 0,
				outputId: sheet.id,
				sheetTitle: sheet.title,
				runCreatedAt: sheet.createdAt,
				body,
			});
			if ("missing" in result) {
				failed = true;
				continue;
			}
			for (const card of result.cards)
				items.push({
					id: `factory:${sheet.id}:${card.rowIndex}`,
					actor: binding.source.label,
					sentence: sentence(
						card.result ||
							`${card.who ? `${card.who}: ` : ""}${card.why || card.sourceText}`,
					),
					source: `/workspace/${binding.source.workspaceId}?workpiece=output:${sheet.id}&pane=workpiece`,
					projectId: binding.projectId,
					workItemId: null,
					tediId: null,
					kind: "result",
					classId:
						`factory:${binding.source.label}:${card.type || "card"}`.slice(
							0,
							100,
						),
					importance: "normal",
					at: sheet.createdAt,
					dueAt: null,
					needsAction: false,
					stalled: /^failed/i.test(card.result),
					done: !!card.result || card.done === "yes",
					explanation: `${card.why}\n${card.sourceText}\nOutput ${sheet.id}, revision ${revision.revision}, row ${card.rowIndex + 1}`,
					reactions: ["more", "why", "mute", "comment", "work"],
				});
		}
		return {
			items,
			failed,
			loading: outputs.isPending || details.some((d) => d.isPending),
			more: false,
		};
	}, [sheets, binding, outputs.isError, outputs.isPending, versionKey]);
	useEffect(() => onUpdate(sourceKey, state), [sourceKey, state, onUpdate]);
	return null;
}

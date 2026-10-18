import { useQuery } from "@tanstack/react-query";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { RichPreview } from "@/components/feed-deck-primitives";
import {
	osQuery,
	workEvidencePreviewQueryOptions,
} from "@/lib/os-query-options";

/** Only governed evidence is embedded; outside URLs remain source links. */
export function FeedOutcomePreview({ item }: { item: ActivityFeedItem }) {
	const evidence = useQuery({
		...osQuery.workItems.listEvidence.queryOptions({
			input: { id: item.workItemId ?? "", limit: 5 },
		}),
		enabled: Boolean(item.workItemId && item.kind === "result"),
	});
	const rows = (evidence.data?.data ?? []).filter(
		(row) => row.disposition !== "rejected" && row.disposition !== "superseded",
	);
	const image = rows.find(
		(row) =>
			row.reference.kind === "artifact" &&
			row.reference.status === "available" &&
			/^image\/(png|jpeg|webp)$/.test(row.mediaType ?? ""),
	);
	const preview = useQuery({
		...workEvidencePreviewQueryOptions(item.workItemId ?? "", image?.id ?? ""),
		enabled: Boolean(image),
	});
	const document = rows.find(
		(row) =>
			row.reference.kind === "output_revision" &&
			row.reference.status === "available",
	);
	const attachment = item.attachment;
	const title = image?.label ?? document?.label ?? attachment?.title;
	if (!title) return null;
	return (
		<RichPreview
			href={item.source}
			title={title}
			summary={attachment?.summary}
			image={
				preview.data?.status === "available"
					? preview.data.imageDataUrl
					: undefined
			}
			imageAlt={image?.label ?? title}
		/>
	);
}

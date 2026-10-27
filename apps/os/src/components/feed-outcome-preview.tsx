import { useQuery } from "@tanstack/react-query";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { plainFeedText } from "@tedix/api-contract/utils/activity-feed";
import { OS_COPY } from "@/shared/os-copy";
import { RichPreview } from "@/components/feed-deck-primitives";
import { Button } from "@/components/kumo/button";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import {
	osQuery,
	workEvidencePreviewQueryOptions,
} from "@/lib/os-query-options";

/** Only governed evidence is embedded; outside URLs remain source links. A compact preview shows only a verified thumbnail or a failure. */
export function FeedOutcomePreview({
	item,
	compact = false,
}: {
	item: ActivityFeedItem;
	compact?: boolean;
}) {
	const enabled = Boolean(item.workItemId && item.kind === "result");
	const evidence = useQuery({
		...osQuery.workItems.listEvidence.queryOptions({
			input: { id: item.workItemId ?? "", limit: 5 },
		}),
		enabled,
	});
	const rows = (enabled ? (evidence.data?.data ?? []) : []).filter(
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
	// Older stored titles can name records by id; the preview shows words.
	const attachment = item.attachment && {
		title:
			plainFeedText(item.attachment.title, OS_COPY.feed) ||
			item.attachment.title,
		summary:
			item.attachment.summary &&
			plainFeedText(item.attachment.summary, OS_COPY.feed),
	};
	const title = image?.label || document?.label || attachment?.title;
	if (!title && (compact || !enabled)) return null;

	const loading =
		enabled &&
		(evidence.isPending ||
			evidence.isFetching ||
			(image && (preview.isPending || preview.isFetching)));
	const failed =
		enabled &&
		(evidence.isError ? evidence : image && preview.isError ? preview : null);
	const unavailable = rows.some(
		(row) =>
			(row.reference.kind === "artifact" ||
				row.reference.kind === "output_revision") &&
			row.reference.status !== "available",
	);
	let message: string | null = null;
	if (enabled) {
		if (evidence.isPending || evidence.isFetching)
			message = "Loading evidence…";
		else if (evidence.isError) message = "Evidence could not be verified.";
		else if (image && (preview.isPending || preview.isFetching))
			message = "Loading image preview…";
		else if (image && preview.isError)
			message = "Image preview could not be verified.";
		else if (
			image &&
			(preview.data?.status !== "available" || !preview.data.imageDataUrl)
		)
			message = "Image preview unavailable. Open the source for details.";
		else if (!image && !document)
			message = unavailable
				? "Evidence content unavailable. Open the source for details."
				: "No preview in the first five evidence records. Open the source for the full record.";
	}
	return (
		<div className="min-w-0 space-y-2">
			<RichPreview
				href={item.source}
				title={title ?? "Open source"}
				summary={
					attachment?.summary === item.sentence
						? undefined
						: attachment?.summary
				}
				image={
					!evidence.isError &&
					!preview.isError &&
					preview.data?.status === "available"
						? preview.data.imageDataUrl
						: undefined
				}
				imageAlt={image?.label || title || "Evidence preview"}
			/>
			{message && (!compact || failed) && (
				<div
					className="flex flex-wrap items-center gap-2"
					role="status"
					aria-live="polite"
				>
					{loading && <Loader size={16} aria-hidden="true" />}
					<Text
						role="caption"
						tone={failed && !loading ? "error" : "secondary"}
						className="min-w-0 flex-1"
					>
						{message}
					</Text>
					{failed && (
						<Button
							size="sm"
							variant="outline"
							aria-label={
								evidence.isError ? "Retry evidence" : "Retry image preview"
							}
							disabled={Boolean(loading)}
							onClick={() => void failed.refetch()}
						>
							Retry
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

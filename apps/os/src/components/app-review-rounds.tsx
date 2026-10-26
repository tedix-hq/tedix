import { useQuery } from "@tanstack/react-query";
import { CreateReviewBatch } from "@/components/create-review-batch";
import { ReviewFeedbackSummary } from "@/components/review-feedback-summary";
import { Text } from "@/components/kumo/text";
import { shareStatus } from "@/components/share-controls";
import { osSharesQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

/**
 * Review rounds ride on an app's "use" link: the organization owner picks
 * items from a document, and signed-in members who open the link mark each
 * one. Lives in the app's Review tab; the share popover only links here.
 */
export function AppReviewRounds({ gadgetId }: { gadgetId: string }) {
	const context = useOsOperationalContext();
	// The API lets only the organization owner send a round.
	const isOwner = context.data?.authority.role === "owner";
	const shares = useQuery({
		...osSharesQueryOptions({ resourceType: "gadget", resourceId: gadgetId }),
		enabled: isOwner,
	});
	if (!isOwner) return null;
	const useLink = shares.data?.items.find(
		(share) => share.role === "use" && shareStatus(share) === "active",
	);
	return (
		<section
			aria-labelledby="app-review-rounds-title"
			className="grid gap-3 border-kumo-line border-t pt-4"
			data-app-review-rounds
		>
			<Text
				as="h3"
				id="app-review-rounds-title"
				role="label"
				tone="strong"
				className="m-0"
			>
				Ask people to review items
			</Text>
			<Text role="label" tone="secondary" className="m-0">
				Pick items from a document and send them to people in your organization
				who have this app's link. They mark each one ready, edit, skip or needs
				checking; their answers show here and never change your document.
			</Text>
			{shares.isPending ? null : useLink ? (
				<>
					<ReviewFeedbackSummary shareId={useLink.id} />
					<CreateReviewBatch shareId={useLink.id} gadgetId={gadgetId} />
				</>
			) : (
				<Text role="label" tone="secondary" className="m-0">
					First use Share to make a link where people can use the app, then come
					back here.
				</Text>
			)}
		</section>
	);
}

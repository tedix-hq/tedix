import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { UnreadList } from "@/components/unread-list";

/** Everything new for the person, in one place: `/unread`. */
export function UnreadPage() {
	return (
		<Page width="md">
			<div className="grid min-w-0 gap-4">
				<PageHeader>
					<PageHeading>
						<PageTitle>Unread</PageTitle>
						<PageDescription>
							New chat messages, agent results and file changes in your
							workspaces.
						</PageDescription>
					</PageHeading>
				</PageHeader>
				<div className="min-w-0 overflow-hidden rounded-lg border border-kumo-hairline bg-kumo-base">
					<UnreadList page />
				</div>
			</div>
		</Page>
	);
}

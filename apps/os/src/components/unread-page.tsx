import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { UnreadList } from "@/components/unread-list";

/** Everything new for the person, in one place: `/inbox`. */
export function UnreadPage() {
	return (
		<Page width="md">
			<div className="grid min-w-0 gap-4">
				<PageHeader>
					<PageHeading>
						<PageTitle>Inbox</PageTitle>
						<PageDescription>
							New chat messages, agent results and file changes in your
							workspaces.
						</PageDescription>
					</PageHeading>
				</PageHeader>
				<Surface tier="panel" className="min-w-0 overflow-hidden">
					<UnreadList page />
				</Surface>
			</div>
		</Page>
	);
}

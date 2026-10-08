import { createFileRoute } from "@tanstack/react-router";
import { startOfToday, WorkOfficePage } from "@/components/work-office-page";
import {
	notebookLessonsQueryOptions,
	replyDraftAcceptanceQueryOptions,
	workOfficeKnocksQueryOptions,
} from "@/lib/os-query-options";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/office")({
	loader: ({ context }) =>
		Promise.all([
			context.queryClient
				.ensureQueryData(workOfficeKnocksQueryOptions())
				.catch(() => undefined),
			context.queryClient
				.ensureQueryData(replyDraftAcceptanceQueryOptions(startOfToday()))
				.catch(() => undefined),
			context.queryClient
				.ensureQueryData(notebookLessonsQueryOptions())
				.catch(() => undefined),
		]),
	component: WorkOfficePage,
	pendingComponent: ListPending,
});

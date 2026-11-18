import { createFileRoute } from "@tanstack/react-router";
import { UnreadPage } from "@/components/unread-page";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/inbox")({
	component: UnreadPage,
	pendingComponent: ListPending,
});

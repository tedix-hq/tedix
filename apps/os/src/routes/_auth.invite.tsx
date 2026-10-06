import { createFileRoute } from "@tanstack/react-router";
import { InvitationAcceptancePage } from "@/account/invitation-acceptance-page";

export const Route = createFileRoute("/_auth/invite")({
	component: InvitationAcceptancePage,
});

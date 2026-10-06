import { createFileRoute } from "@tanstack/react-router";
import { AgentInstallPage } from "@/components/agent-install-page";

export const Route = createFileRoute("/_session/_tenant/install")({
	component: AgentInstallPage,
});

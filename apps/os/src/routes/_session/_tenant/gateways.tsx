import { createFileRoute } from "@tanstack/react-router";
import { GatewaysPage } from "@/components/gateways-page";

export const Route = createFileRoute("/_session/_tenant/gateways")({
	component: GatewaysPage,
});

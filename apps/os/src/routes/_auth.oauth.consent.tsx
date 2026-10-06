import { createFileRoute } from "@tanstack/react-router";
import { InboundConsentPage } from "@/account/inbound-consent-page";

export const Route = createFileRoute("/_auth/oauth/consent")({
	component: InboundConsentPage,
});

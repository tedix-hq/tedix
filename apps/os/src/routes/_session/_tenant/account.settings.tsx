import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/settings-page";
export const Route = createFileRoute("/_session/_tenant/account/settings")({
	component: SettingsPage,
});

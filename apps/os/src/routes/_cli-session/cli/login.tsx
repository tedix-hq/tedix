import { createFileRoute } from "@tanstack/react-router";
import { CliLoginPage } from "@/account/cli-login-page";

export const Route = createFileRoute("/_cli-session/cli/login")({
	component: CliLoginPage,
});

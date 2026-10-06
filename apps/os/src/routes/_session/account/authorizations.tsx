import { createFileRoute } from "@tanstack/react-router";
import { McpAuthorizationsPage } from "@/account/mcp-authorizations-page";
import { useDocumentTitle } from "@/lib/use-document-title";
export const Route = createFileRoute("/_session/account/authorizations")({
	component: AuthorizationsRoute,
});
function AuthorizationsRoute() {
	useDocumentTitle("Connected applications · Tedix OS");
	return <McpAuthorizationsPage />;
}

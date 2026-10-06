import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveOsTenant } from "@/shared/os-tenant";
import { CanvasPage } from "@/components/canvas-page";
import { validateWorkspaceSearch } from "@/lib/canvas-search";
import { shouldRenderOrganizationLauncher } from "@/lib/os-layout-routing";
import {
	prefetchCanvasRoute,
	requireUuidRouteParam,
} from "@/lib/os-route-loaders";
import { CanvasPending } from "@/routes/-pending";

declare const __LOCAL_FIRST_RUN_ENABLED__: boolean;

export const Route = createFileRoute(
	"/_session/_chrome-free/workspace_/$workspaceId",
)({
	validateSearch: validateWorkspaceSearch,
	beforeLoad: () => {
		const tenant = resolveOsTenant(window.location.hostname);
		if (shouldRenderOrganizationLauncher(tenant, __LOCAL_FIRST_RUN_ENABLED__)) {
			throw redirect({ to: "/account/organizations" });
		}
	},
	loader: ({ context, params }) =>
		prefetchCanvasRoute(
			context.queryClient,
			requireUuidRouteParam(params.workspaceId),
		),
	component: WorkspaceRoute,
	pendingComponent: CanvasPending,
});

function WorkspaceRoute() {
	const { workspaceId } = Route.useParams();
	return (
		<main className="canvas-route-shell">
			<CanvasPage workspaceId={workspaceId} />
		</main>
	);
}

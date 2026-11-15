import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { resolveOsTenant } from "@/shared/os-tenant";
import { WorkspaceAccessBoundary } from "@/components/workspace-access-boundary";
import { WorkActorDirectory } from "@/components/work-actor-directory";
import { PhoneWorkspaceChat } from "@/components/phone-workspace-chat";
import { validateWorkspaceSearch } from "@/lib/canvas-search";
import { shouldRenderOrganizationLauncher } from "@/lib/os-layout-routing";
import {
	prefetchCanvasRoute,
	requireUuidRouteParam,
} from "@/lib/os-route-loaders";
import { CanvasPending } from "@/routes/-pending";

declare const __LOCAL_FIRST_RUN_ENABLED__: boolean;

const CanvasPage = lazy(async () => ({
	default: (await import("@/components/canvas-page")).CanvasPage,
}));

export const Route = createFileRoute(
	"/_session/_chrome-free/workspace_/$workspaceId",
)({
	validateSearch: validateWorkspaceSearch,
	loaderDeps: ({ search }) => ({
		phoneChat:
			search.pane === "chat" &&
			search.workpiece === undefined &&
			window.matchMedia("(max-width: 959px)").matches,
	}),
	beforeLoad: () => {
		const tenant = resolveOsTenant(window.location.hostname);
		if (shouldRenderOrganizationLauncher(tenant, __LOCAL_FIRST_RUN_ENABLED__)) {
			throw redirect({ to: "/account/organizations" });
		}
	},
	loader: async ({ context, deps, params }) => {
		const workspaceId = requireUuidRouteParam(params.workspaceId);
		if (deps.phoneChat) return;
		return prefetchCanvasRoute(context.queryClient, workspaceId);
	},
	component: WorkspaceRoute,
	pendingComponent: CanvasPending,
});

function WorkspaceRoute() {
	const { workspaceId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const phoneChat =
		search.pane === "chat" &&
		search.workpiece === undefined &&
		window.matchMedia("(max-width: 959px)").matches;
	const updateConversation = (conversation: string | null) =>
		void navigate({
			search: (previous) => ({
				...previous,
				conversation: conversation ?? undefined,
				pane: "chat",
			}),
		});
	return (
		<main className="canvas-route-shell">
			<WorkspaceAccessBoundary workspaceId={workspaceId}>
				<WorkActorDirectory>
					{phoneChat ? (
						<PhoneWorkspaceChat
							conversationId={search.conversation ?? null}
							onConversationChange={updateConversation}
							onOpenWorkspace={() =>
								void navigate({
									search: (previous) => ({
										...previous,
										pane: "resources",
									}),
								})
							}
							workspaceId={workspaceId}
						/>
					) : (
						<Suspense fallback={<CanvasPending />}>
							<CanvasPage workspaceId={workspaceId} />
						</Suspense>
					)}
				</WorkActorDirectory>
			</WorkspaceAccessBoundary>
		</main>
	);
}

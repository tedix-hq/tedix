import { createFileRoute } from "@tanstack/react-router";
import { AppEvalDetailPage } from "@/components/app-eval-detail-page";
import { prefetchAppEvalDetailRoute } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute(
	"/_session/_tenant/apps_/$appId/evals/$evalId",
)({
	loader: ({ context, params }) =>
		prefetchAppEvalDetailRoute(context.queryClient, params.evalId),
	component: AppEvalDetailPage,
	pendingComponent: DetailPending,
});

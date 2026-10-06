import { createFileRoute } from "@tanstack/react-router";
import { ToolTelemetry } from "@/components/tool-telemetry";
import { prefetchTediTelemetryRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute(
	"/_session/_tenant/team_/$tediId/telemetry",
)({
	loader: ({ context, params }) =>
		prefetchTediTelemetryRoute(context.queryClient, params.tediId),
	component: TelemetryRoute,
});

function TelemetryRoute() {
	return <ToolTelemetry tediId={Route.useParams().tediId} />;
}

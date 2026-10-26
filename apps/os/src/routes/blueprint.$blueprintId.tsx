import { createFileRoute } from "@tanstack/react-router";
import { BlueprintLandingPage } from "@/components/blueprint-landing-page";

/** A shared gallery blueprint: outside every session layout, no login prompt. */
export const Route = createFileRoute("/blueprint/$blueprintId")({
	component: function BlueprintRoute() {
		const { blueprintId } = Route.useParams();
		return <BlueprintLandingPage blueprintId={blueprintId} />;
	},
});

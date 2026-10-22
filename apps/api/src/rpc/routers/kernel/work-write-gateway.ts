import type { KernelContext } from "./context-assembly";
import type { KernelRouteDecision } from "./route-schema";

/** Routing hints from this turn's org-scoped app rows; never authorization. */
export function workWriteGateway(
	route: KernelRouteDecision,
	apps: KernelContext["apps"],
): string | null {
	if (
		route.routeKind !== "propose_tool_write" ||
		route.toolIntent?.capability !== "work_items.create"
	)
		return null;
	const gateways = apps.filter(
		(app) =>
			app.codeMode === true && app.capabilities?.includes("work_items.create"),
	);
	const selected = gateways.find(
		(app) => app.slug === route.toolIntent?.appSlug,
	);
	return selected?.slug ?? (gateways.length === 1 ? gateways[0]!.slug : null);
}

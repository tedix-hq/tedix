import { createFileRoute } from "@tanstack/react-router";
import { AdminSectionLayout } from "@/components/admin-layout";
import { operationalContextQueryOptions } from "@/lib/os-query-options";

export const Route = createFileRoute("/_session/_tenant/admin")({
	// Warm the authority read the layout gate renders from. allSettled-style
	// tolerance is unnecessary: the gate itself handles a failed read by
	// refusing access, so a loader error page would be strictly worse.
	loader: ({ context }) =>
		context.queryClient
			.ensureQueryData(operationalContextQueryOptions())
			.catch(() => undefined),
	component: AdminSectionLayout,
});

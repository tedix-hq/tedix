import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "@/components/audit-page";
import { type AuditSearch, validateAuditSearch } from "@/lib/audit-search";
import { prefetchAuditRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

/**
 * Deliberately no client-side role gate. The server truth for this read is
 * `analytics:read` on `audit.search` (apps/api/src/rpc/routers/audit.ts), so
 * /audit stays readable to any credential the server admits. A component-body
 * owner/admin check would be a client-only veneer over the same server gate.
 */
export const Route = createFileRoute("/_session/_tenant/audit")({
	validateSearch: validateAuditSearch,
	loaderDeps: ({ search }) => ({
		resourceType: search.resourceType,
		action: search.action,
		page: search.page,
	}),
	loader: ({ context, deps }) => prefetchAuditRoute(context.queryClient, deps),
	component: AuditRoute,
	pendingComponent: ListPending,
});

function AuditRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<AuditPage
			search={search}
			onSearchChange={(next: Partial<AuditSearch>) =>
				void navigate({ search: (previous) => ({ ...previous, ...next }) })
			}
		/>
	);
}

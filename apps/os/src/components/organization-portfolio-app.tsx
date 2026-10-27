import { useQuery } from "@tanstack/react-query";
import { LoadError } from "@/components/kumo/alert";
import { Skeleton } from "@/components/kumo/skeleton";
import { PortfolioApp } from "@/components/work-portfolio-page";
import { OrganizationPortfolioForm } from "@/components/organization-portfolio-form";
import { organizationDetailQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { OS_COPY } from "@/shared/os-copy";

function OrganizationPortfolio({ settings = false }: { settings?: boolean }) {
	const context = useOsOperationalContext();
	const id = context.data?.organization.id ?? "";
	const detail = useQuery({
		...organizationDetailQueryOptions(id),
		enabled: Boolean(id),
	});
	if (context.isError || detail.isError)
		return (
			<LoadError
				title="Project sections unavailable"
				error={context.error ?? detail.error}
				onRetry={() => {
					void context.refetch();
					void detail.refetch();
				}}
				retrying={context.isFetching || detail.isFetching}
			/>
		);
	if (!context.data || !detail.data)
		return <Skeleton className="h-24 w-full" />;
	const isOwner = context.data.authority.role === "owner";
	const buckets =
		detail.data.metadata?.portfolioBuckets ?? OS_COPY.portfolio.defaults;
	if (settings)
		return isOwner ? (
			<OrganizationPortfolioForm
				key={id}
				organizationId={id}
				initialBuckets={buckets}
			/>
		) : (
			<p>Only the organization owner can edit project sections.</p>
		);
	return <PortfolioApp buckets={buckets} isOwner={isOwner} />;
}

export function OrganizationPortfolioApp() {
	return <OrganizationPortfolio />;
}
export function PortfolioSettingsApp() {
	return <OrganizationPortfolio settings />;
}

import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Skeleton } from "@/components/kumo/skeleton";
import { PortfolioApp } from "@/components/work-portfolio-page";
import { OrganizationPortfolioForm } from "@/components/organization-portfolio-form";
import { organizationDetailQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { OS_COPY } from "@/shared/os-copy";
import { errorMessage } from "@/lib/orpc-error";

function OrganizationPortfolio({ settings = false }: { settings?: boolean }) {
	const context = useOsOperationalContext();
	const id = context.data?.organization.id ?? "";
	const detail = useQuery({
		...organizationDetailQueryOptions(id),
		enabled: Boolean(id),
	});
	if (context.isError || detail.isError)
		return (
			<Alert variant="destructive">
				<AlertTitle>Portfolio settings unavailable</AlertTitle>
				<AlertDescription>
					{errorMessage(
						context.error ?? detail.error,
						"Organization settings could not be loaded.",
					)}
				</AlertDescription>
			</Alert>
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
			<p>Only the organization owner can edit portfolio sections.</p>
		);
	return <PortfolioApp buckets={buckets} isOwner={isOwner} />;
}

export function OrganizationPortfolioApp() {
	return <OrganizationPortfolio />;
}
export function PortfolioSettingsApp() {
	return <OrganizationPortfolio settings />;
}

import { AppWindow } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getOsSurface } from "@/lib/os-navigation";
import { CapabilityNavigation } from "@/components/capability-navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collection,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { appGatewayMembershipsQueryOptions } from "@/lib/os-query-options";
import { mcpEndpointUrl } from "@/components/app-detail";

export function GatewaysPage() {
	const surface = getOsSurface("gateways");
	const query = useQuery(appGatewayMembershipsQueryOptions());
	const gateways = query.data?.gateway ? [query.data.gateway] : [];
	return (
		<Page width="lg">
			<div className="grid min-w-0 gap-4">
				<PageHeader>
					<PageHeading>
						<PageTitle>{surface.label}</PageTitle>
						<PageDescription>{surface.description}</PageDescription>
					</PageHeading>
				</PageHeader>
				<CapabilityNavigation active="gateway" />
			</div>
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Shared connection</SectionTitle>
						<SectionDescription>
							Choose which apps and tools Tedix can use.
						</SectionDescription>
					</SectionHeading>
					{query.isSuccess ? (
						<Badge variant="outline">{gateways.length}</Badge>
					) : null}
				</SectionHeader>
				{query.isPending ? (
					<div role="status" aria-label="Loading shared connection">
						<ListSkeleton />
					</div>
				) : null}
				{query.isFetching && !query.isPending ? (
					<Text as="p" role="body" tone="secondary" aria-live="polite">
						Refreshing shared connection…
					</Text>
				) : null}
				{query.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Connections are unavailable</AlertTitle>
						<AlertDescription className="break-words [overflow-wrap:anywhere]">
							{(query.error as Error).message}
							<p className="mt-2">
								{gateways.length
									? "Showing the last loaded shared connection. Its details may be out of date."
									: "We couldn’t check whether a shared connection is set up. Try again."}
							</p>
						</AlertDescription>
						<div className="mt-3">
							<Button
								variant="outline"
								loading={query.isFetching}
								onClick={() => void query.refetch()}
							>
								Retry shared connection
							</Button>
						</div>
					</Alert>
				) : null}
				{query.isSuccess && !query.isFetching && gateways.length === 0 ? (
					<Text as="p" role="body" tone="secondary">
						No shared connection is set up for your organization.
					</Text>
				) : null}
				{gateways.length ? (
					<Collection>
						{gateways.map((gateway) => (
							<li key={gateway.id}>
								<Link
									to="/apps/$appId"
									params={{ appId: gateway.id }}
									className="flex min-h-16 min-w-0 flex-wrap items-center gap-3 px-4 py-3 text-inherit no-underline hover:bg-kumo-tint focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-focus"
								>
									<div className="grid size-9 shrink-0 place-items-center rounded-md border border-kumo-line bg-kumo-tint">
										<AppWindow size={18} />
									</div>
									<div className="min-w-0 flex-1">
										<Text role="body" className="m-0 font-medium">
											{gateway.name}
										</Text>
										<Text
											as="p"
											role="caption"
											tone="secondary"
											className="m-0 break-words [overflow-wrap:anywhere]"
										>
											{mcpEndpointUrl({ ...gateway, customMcpDomain: null })}
										</Text>
									</div>
									<Badge variant="outline">unified gateway</Badge>
								</Link>
							</li>
						))}
					</Collection>
				) : null}
			</PageSection>
		</Page>
	);
}

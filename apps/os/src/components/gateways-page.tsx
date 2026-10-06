import { AppWindow } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getOsSurface } from "@/lib/os-navigation";
import { CapabilityNavigation } from "@/components/capability-navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
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
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>
						{surface.description}. Gateways compose apps but are not themselves
						installed capabilities or sites.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<CapabilityNavigation active="gateway" />
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Organization gateways</SectionTitle>
						<SectionDescription>
							Open a gateway to manage its MCP configuration and membership.
						</SectionDescription>
					</SectionHeading>
					{query.data ? (
						<Badge variant="outline">{gateways.length}</Badge>
					) : null}
				</SectionHeader>
				{query.isPending ? <ListSkeleton /> : null}
				{query.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Gateways are unavailable</AlertTitle>
						<AlertDescription>
							{(query.error as Error).message}
						</AlertDescription>
					</Alert>
				) : null}
				{!query.isPending && gateways.length === 0 ? (
					<Text as="p" role="body" tone="secondary">
						No unified gateways belong to this organization.
					</Text>
				) : null}
				{gateways.length ? (
					<Collection>
						{gateways.map((gateway) => (
							<li key={gateway.id}>
								<Link
									to="/apps/$appId"
									params={{ appId: gateway.id }}
									className="flex min-h-16 items-center gap-3 px-3 py-2.5 text-inherit no-underline hover:bg-kumo-tint"
								>
									<div className="grid size-9 place-items-center rounded-md border border-kumo-line bg-kumo-tint">
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
											className="m-0"
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AppTabHeader } from "@/components/app-detail-tab-shared";
import { PageSection } from "@/components/kumo/page";
import { LoadError, Alert, AlertDescription } from "@/components/kumo/alert";

import { Switch } from "@/components/kumo/switch";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { APPS_MANAGE_DENIED_REASON } from "@/lib/app-permissions";
import {
	appGatewayMembershipQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

export function AppGatewayMembership({
	appId,
	canManage,
}: {
	appId: string;
	canManage: boolean;
}) {
	const client = useQueryClient();
	const membership = useQuery(appGatewayMembershipQueryOptions(appId));
	const mutation = useMutation({
		mutationFn: (enabled: boolean) =>
			osApi.apps.setGatewayMembership({ appId, enabled }),
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: osQueryKeys.apps() });
		},
	});
	const state = membership.data;
	const isGateway = state?.gateway?.id === appId;
	return (
		<PageSection>
			<AppTabHeader
				title="Unified gateway"
				description={
					isGateway
						? "This app is the unified gateway for your organization."
						: "Choose whether connected AI clients can discover this app through your organization’s gateway."
				}
			/>
			<div className="space-y-3">
				{membership.isPending ? (
					<Skeleton className="h-10 w-full" />
				) : membership.isError ? (
					<LoadError
						error={membership.error}
						onRetry={() => membership.refetch()}
						retrying={membership.isFetching}
					/>
				) : isGateway ? (
					<Text as="p" role="body" tone="secondary">
						Self-membership does not apply. Manage availability from each
						installed app. Client permissions and account access still apply.
					</Text>
				) : state ? (
					<>
						<div className="flex items-center justify-between gap-4">
							<Text as="span" role="body" weight="medium">
								Available in unified gateway
							</Text>
							<Switch
								aria-label="Available in unified gateway"
								checked={state.enabled}
								disabled={
									!canManage ||
									mutation.isPending ||
									!state.gateway ||
									(!state.enabled && !!state.unavailableReason) ||
									state.gateway.id === appId
								}
								onCheckedChange={(checked) => mutation.mutate(checked)}
							/>
						</div>
						<Text as="p" role="body" tone="secondary" aria-live="polite">
							{mutation.isPending
								? "Saving…"
								: state.enabled
									? "Included in the gateway. Client permissions and account access still apply."
									: "Not included. This app stays installed and its account connection is unchanged."}
						</Text>
						{state.gateway && (
							<Link
								to="/apps/$appId/settings"
								params={{ appId: state.gateway.id }}
								className="text-sm underline"
							>
								{state.gateway.name}
							</Link>
						)}
						{state.unavailableReason && (
							<Text as="p" role="body" tone="secondary">
								{state.unavailableReason}
							</Text>
						)}
						{!canManage && (
							<Text as="p" role="body" tone="secondary">
								{APPS_MANAGE_DENIED_REASON}
							</Text>
						)}
					</>
				) : null}
				{mutation.isError && (
					<Alert variant="destructive">
						<AlertDescription>{mutation.error.message}</AlertDescription>
					</Alert>
				)}
				<Text as="p" role="body" tone="secondary">
					This setting applies to the organization. It does not share personal
					credentials or grant new permissions. Clients may need to refresh
					their tools.
				</Text>
			</div>
		</PageSection>
	);
}

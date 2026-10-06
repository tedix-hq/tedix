import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
} from "@/components/kumo/card";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
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
	return (
		<Card>
			<CardHeader>
				<CardTitle>Unified gateway</CardTitle>
				<CardDescription>
					Choose whether connected AI clients can discover this app through your
					organization’s gateway.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{membership.isPending ? (
					<Skeleton className="h-10 w-full" />
				) : membership.isError ? (
					<Alert variant="destructive">
						<AlertDescription>
							Gateway availability could not be loaded.{" "}
							<Button variant="secondary" onClick={() => membership.refetch()}>
								Retry
							</Button>
						</AlertDescription>
					</Alert>
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
			</CardContent>
		</Card>
	);
}

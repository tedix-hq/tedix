import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import type { PersonalReadConsentConfigSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { Button } from "@/components/kumo/button";
import { Card, CardContent } from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	osQuery,
	workspaceResourcesQueryOptions,
	workspaceSchedulesQueryOptions,
} from "@/lib/os-query-options";

export function PersonalReadConsentApp({
	workspaceId,
	config,
}: {
	workspaceId: string;
	config: z.infer<typeof PersonalReadConsentConfigSchema>;
}) {
	const client = useQueryClient();
	const grants = useQuery({
		...osQuery.personalResourceDelegations.list.queryOptions({
			input: { limit: 100 },
		}),
		retry: false,
	});
	const now = new Date().toISOString();
	const allowed = new Set(
		(grants.data ?? [])
			.filter(
				(grant) =>
					grant.workspaceId === workspaceId &&
					grant.skillId === config.skillId &&
					!grant.revokedAt &&
					grant.expiresAt > now &&
					grant.operations.includes("read"),
			)
			.map((grant) => grant.providerId),
	);
	const missing = config.providers.filter(
		(provider) => !allowed.has(provider.id),
	);
	const names = config.providers.map((provider) => provider.name).join(" and ");
	const allow = useMutation({
		mutationFn: async () => {
			const disconnected: string[] = [];
			for (const provider of missing) {
				const result = await osApi.osWorkspaces.schedules.allowPersonalRead({
					workspaceId,
					resourceId: config.resourceId,
					providerId: provider.id,
				});
				if (result.status === "not_connected") disconnected.push(provider.name);
			}
			return disconnected;
		},
		onSettled: () =>
			Promise.all([
				client.invalidateQueries({
					queryKey: osQuery.personalResourceDelegations.list.key(),
				}),
				client.invalidateQueries({
					queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
				}),
				client.invalidateQueries({
					queryKey: workspaceSchedulesQueryOptions(workspaceId).queryKey,
				}),
			]),
	});
	return (
		<Card>
			<CardContent className="grid gap-3">
				<Text as="h3" weight="medium">
					Read-only access
				</Text>
				<Text>
					Allow {config.workerName} to read your connected {names} for this
					scheduled skill. This never permits sending, editing or deleting. You
					can revoke access in Resources.
				</Text>
				{missing.length === 0 && !grants.isPending ? (
					<Text role="label">Read-only access is allowed.</Text>
				) : (
					<Button
						disabled={grants.isPending || grants.isError || allow.isPending}
						onClick={() => allow.mutate()}
					>
						Let the {config.workerName} read my {names} (read-only)
					</Button>
				)}
				{allow.data && allow.data.length > 0 && (
					<Text>
						Connect your {allow.data.join(" and ")} in{" "}
						<a href="/account/connections">Settings → Connections</a>, then
						return here.
					</Text>
				)}
				{(allow.error || grants.error) && (
					<Text role="label" tone="error">
						{(allow.error || grants.error)?.message}
					</Text>
				)}
			</CardContent>
		</Card>
	);
}

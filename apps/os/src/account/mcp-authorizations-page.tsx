import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { osApi } from "@/lib/api";
import { allMyOrganizationsQueryOptions } from "./query-options";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";
import { ConsentPermissionGroups } from "./consent-permission-groups";
import { normalizeConsentPermissions } from "@/shared/consent-permissions";

type McpAuthorization = Awaited<
	ReturnType<typeof osApi.organizations.listMcpAuthorizations>
>["items"][number];

const accountQuery = createTanstackQueryUtils(osApi);
const PAGE_SIZE = 20;
export function authorizationStatus(item: McpAuthorization): string {
	if (item.status === "revoked") return "Access disabled";
	switch (item.providerStatus) {
		case "present":
			return "Permission recorded";
		case "missing":
			return "Reconnect needed";
		default:
			return "Connection not verified";
	}
}
export function McpAuthorizationCard({
	item,
	onDisable,
	pending,
	organizationNames = {},
}: {
	item: McpAuthorization;
	onDisable: () => void;
	pending: boolean;
	organizationNames?: Record<string, string>;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{item.clientName ?? "Unnamed application"}</CardTitle>
				<Text>{authorizationStatus(item)}</Text>
			</CardHeader>
			<CardContent className="grid gap-3">
				<Text>
					Organizations:{" "}
					{item.selectedTenantIds
						.map((id) => organizationNames[id] ?? id)
						.join(", ") || "None"}
				</Text>
				<ConsentPermissionGroups
					expandHighRisk={false}
					permissions={normalizeConsentPermissions(
						item.approvedScopes.map((name) => ({ name })),
					)}
				/>
				<details>
					<summary className="cursor-pointer text-kumo-subtle">
						Connection details
					</summary>
					<Text className="break-all">Application ID: {item.clientId}</Text>
					<Text className="break-all">MCP resource: {item.mcpServerId}</Text>
					<Text>Updated: {item.updatedAt}</Text>
					<Text tone="secondary">
						{item.status === "revoked"
							? "Tedix access is off. The sign-in provider may still store this connection."
							: "A recorded permission does not confirm that the application is currently connected."}
					</Text>
				</details>
				{item.status === "active" ? (
					<Button variant="secondary" disabled={pending} onClick={onDisable}>
						Disable Tedix access
					</Button>
				) : null}
			</CardContent>
		</Card>
	);
}
export function McpAuthorizationsPage() {
	const [offset, setOffset] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const options = accountQuery.organizations.listMcpAuthorizations.queryOptions(
		{ input: { limit: PAGE_SIZE, offset } },
	);
	const query = useQuery(options);
	const organizations = useQuery(allMyOrganizationsQueryOptions());
	const organizationNames = Object.fromEntries(
		(organizations.data?.data ?? [])
			.filter((org) => org.descopeTenantId)
			.map((org) => [org.descopeTenantId!, org.organizationName]),
	);
	const disable = useMutation({
		mutationFn: (item: McpAuthorization) =>
			osApi.organizations.disableMcpAuthorization({
				mcpServerId: item.mcpServerId,
				clientId: item.clientId,
				expectedRevision: item.revision,
			}),
		onSuccess: async () => {
			setError(null);
			await queryClient.invalidateQueries({
				queryKey: accountQuery.organizations.listMcpAuthorizations.key(),
			});
		},
		onError: () =>
			setError("Could not disable access. Refresh this list and try again."),
	});
	return (
		<main className="mx-auto grid max-w-170 gap-4 p-6">
			<Button render={<a href="/account/organizations" />} variant="ghost">
				Back to workspaces
			</Button>
			<Card>
				<CardHeader>
					<CardTitle>Connected applications</CardTitle>
				</CardHeader>
				<CardContent className="grid gap-3">
					<Text>
						Manage the access you gave to ChatGPT, the Tedix CLI, and other
						applications.
					</Text>
					<details>
						<summary className="cursor-pointer text-kumo-subtle">
							How to change access
						</summary>
						<Text>
							Reconnect in the original application to change permissions. For
							the CLI, run tedix login.
						</Text>
						<Text>
							Disabling blocks access through Tedix. It does not remove saved
							sign-in details from other services.
						</Text>
					</details>
					<Button variant="secondary" onClick={() => void query.refetch()}>
						Refresh
					</Button>
				</CardContent>
			</Card>
			{query.isPending ? <Text>Loading applications…</Text> : null}
			{query.isError ? (
				<Text tone="error">Could not load your applications.</Text>
			) : null}
			{error ? <Text tone="error">{error}</Text> : null}
			{query.data?.items.length === 0 ? (
				<Text>No applications have requested access yet.</Text>
			) : null}
			{query.data?.items.map((item) => (
				<McpAuthorizationCard
					key={`${item.mcpServerId}:${item.clientId}`}
					item={item}
					organizationNames={organizationNames}
					pending={disable.isPending}
					onDisable={() => disable.mutate(item)}
				/>
			))}
			<section className="flex gap-3">
				<Button
					disabled={offset === 0}
					onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
				>
					Previous
				</Button>
				<Button
					disabled={!query.data?.hasMore}
					onClick={() => setOffset(offset + PAGE_SIZE)}
				>
					Next
				</Button>
			</section>
		</main>
	);
}

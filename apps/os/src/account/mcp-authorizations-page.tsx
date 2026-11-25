import { LoadingArea } from "@/components/loading-area";
import { CaretRight } from "@phosphor-icons/react";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "@/components/kumo/collapsible";
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
type McpSignIn = Awaited<
	ReturnType<typeof osApi.organizations.listMcpSignIns>
>["items"][number];

const accountQuery = createTanstackQueryUtils(osApi);
const PAGE_SIZE = 20;

function signInDeviceLabel(device: string | null) {
	switch (device) {
		case "app":
			return "App";
		case "browser":
			return "Browser";
		default:
			return "Unknown device";
	}
}

function formatSignInDate(value: string | null) {
	if (!value) return "Never";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
}

export function McpSignInCard({
	item,
	onRevoke,
	pending,
	organizationNames = {},
}: {
	item: McpSignIn;
	onRevoke: () => void;
	pending: boolean;
	organizationNames?: Record<string, string>;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{item.clientName ?? "Unnamed agent"}</CardTitle>
				<Text>
					{signInDeviceLabel(item.device)} ·{" "}
					{item.serverSlug ?? item.mcpServerId}
				</Text>
			</CardHeader>
			<CardContent className="grid gap-3">
				<Text>
					Organizations:{" "}
					{item.selectedTenantIds
						.map((id) => organizationNames[id] ?? id)
						.join(", ") || "None"}
				</Text>
				<Text>
					Created {formatSignInDate(item.createdAt)} · Last used{" "}
					{formatSignInDate(item.lastUsedAt)}
				</Text>
				<Collapsible>
					<CollapsibleTrigger className="group/disclosure">
						<CaretRight
							size={14}
							aria-hidden
							className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
						/>
						Sign-in details
					</CollapsibleTrigger>
					<CollapsibleContent keepMounted>
						<Text className="break-all">Application ID: {item.clientId}</Text>
						<Text className="break-all">MCP resource: {item.mcpServerId}</Text>
					</CollapsibleContent>
				</Collapsible>
				<Button variant="secondary" disabled={pending} onClick={onRevoke}>
					End this sign-in
				</Button>
			</CardContent>
		</Card>
	);
}
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
				<Collapsible>
					<CollapsibleTrigger className="group/disclosure">
						<CaretRight
							size={14}
							aria-hidden
							className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
						/>
						Connection details
					</CollapsibleTrigger>
					<CollapsibleContent keepMounted>
						<Text className="break-all">Application ID: {item.clientId}</Text>
						<Text className="break-all">MCP resource: {item.mcpServerId}</Text>
						<Text>Updated: {item.updatedAt}</Text>
						<Text tone="secondary">
							{item.status === "revoked"
								? "Tedix access is off. The sign-in provider may still store this connection."
								: "A recorded permission does not confirm that the application is currently connected."}
						</Text>
					</CollapsibleContent>
				</Collapsible>
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
	const signInsQuery = useQuery(
		accountQuery.organizations.listMcpSignIns.queryOptions({
			input: { limit: 100, offset: 0 },
		}),
	);
	const revokeSignIn = useMutation({
		mutationFn: (item: McpSignIn) =>
			osApi.organizations.revokeMcpSignIn({
				mcpServerId: item.mcpServerId,
				clientId: item.clientId,
				revision: item.revision,
			}),
		onSuccess: async () => {
			setError(null);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: accountQuery.organizations.listMcpSignIns.key(),
				}),
				queryClient.invalidateQueries({
					queryKey: accountQuery.organizations.listMcpAuthorizations.key(),
				}),
			]);
		},
		onError: () =>
			setError("Could not end that sign-in. Refresh this list and try again."),
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
					<Collapsible>
						<CollapsibleTrigger className="group/disclosure">
							<CaretRight
								size={14}
								aria-hidden
								className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
							/>
							How to change access
						</CollapsibleTrigger>
						<CollapsibleContent keepMounted>
							<Text>
								Reconnect in the original application to change permissions. For
								the CLI, run tedix login.
							</Text>
							<Text>
								Disabling blocks access through Tedix. It does not remove saved
								sign-in details from other services.
							</Text>
						</CollapsibleContent>
					</Collapsible>
					<Button variant="secondary" onClick={() => void query.refetch()}>
						Refresh
					</Button>
				</CardContent>
			</Card>
			{query.isPending ? <LoadingArea label="Loading applications" /> : null}
			{query.isError ? (
				<Text tone="error">Could not load your applications.</Text>
			) : null}
			{error ? <Text tone="error">{error}</Text> : null}
			<Card>
				<CardHeader>
					<CardTitle>Your sign-ins</CardTitle>
				</CardHeader>
				<CardContent className="grid gap-3">
					<Text>
						Each sign-in is one installation of an agent. Ending one stops only
						that installation; your other sign-ins keep working. Sign-ins unused
						for about 90 days end on their own.
					</Text>
					{signInsQuery.data?.capWarning ? (
						<Text tone="secondary">
							One agent has many sign-ins. End the ones you no longer use.
						</Text>
					) : null}
					{signInsQuery.isPending ? (
						<LoadingArea label="Loading sign-ins" />
					) : null}
					{signInsQuery.isError ? (
						<Text tone="error">Could not load your sign-ins.</Text>
					) : null}
					{signInsQuery.data?.items.length === 0 ? (
						<Text>No sign-ins yet.</Text>
					) : null}
					{signInsQuery.data?.items.map((item) => (
						<McpSignInCard
							key={`${item.mcpServerId}:${item.clientId}:${item.revision}`}
							item={item}
							organizationNames={organizationNames}
							pending={revokeSignIn.isPending}
							onRevoke={() => revokeSignIn.mutate(item)}
						/>
					))}
				</CardContent>
			</Card>
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

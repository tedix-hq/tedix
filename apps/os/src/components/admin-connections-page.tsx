import { CapabilityNavigation } from "@/components/capability-navigation";
/**
 * Admin › Connections
 *
 * Organization-wide credential governance on the `connections` oRPC contract:
 * OAuth providers (Connect → session-broker handoff → Descope Vault), API-key
 * providers (Connect → key form → Descope AIH Token Vault), org vs personal
 * credential sections, and the Descope OutboundApplications widget preview.
 *
 * Section access is gated once by the /admin layout; the page itself is
 * readable with `apps:read`. Personal OAuth uses that same member permission,
 * because the API writes only the caller's own subject-bound token. Shared
 * credentials, tenant OAuth, and API keys still gate on `integrations:manage`.
 * Rendering an enabled control whose call the API refuses is the same class of
 * untruth as showing a permission no guard evaluates.
 *
 * The connect/disconnect flows live in `@/lib/connections-actions` and are
 * shared with the Apps page panel, so the two surfaces cannot drift.
 */

import type {
	ConnectionInventory,
	ConnectionProvider,
	ConnectionInventoryRow,
	UserConnection,
} from "@tedix/api-contract/schemas/connections";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Buildings, CaretDown, Info, Plugs, User } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isImeComposing } from "@/lib/keyboard";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import { SearchInput } from "@/components/kumo/search-input";
import { SensitiveInput } from "@/components/kumo/sensitive-input";
import {
	Collection,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	PageToolbar,
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";

import { KumoTabs } from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import { ConnectionListItem } from "@/components/connection-list-item";
import {
	PersonalProviderAccounts,
	friendlyPersonalProviderName,
} from "@/components/personal-provider-accounts";
import {
	DisconnectConnectionDialog,
	type DisconnectConnectionTarget,
} from "@/components/connections-disconnect-dialog";
import { ListSkeleton } from "@/components/list-skeleton";
import type {
	AdminConnectionsSearch,
	ConnectionStatusFilter,
} from "@/lib/admin-connections-search";
import {
	effectiveConnectionScope,
	startOauthConnect,
	startNamedOauthConnect,
	useCanManageConnections,
	useCanBindPersonalAccounts,
	useCanManagePersonalOauthConnections,
	useConnectionCompleteListener,
	useDisconnectConnection,
} from "@/lib/connections-actions";
import { osApi, osDirectReadApi } from "@/lib/api";
import {
	connectionsOverviewQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";
import { buildConnectionsWebMcpTools } from "@/components/connections-webmcp-tools";

export function connectionInventoryCountLabel(
	shown: number,
	loaded: number,
	hasMore: boolean,
) {
	return `${shown} of ${hasMore ? `first ${loaded}` : loaded} shown`;
}

export function filterPersonalAccountRows(
	rows: ConnectionInventoryRow[],
	q: string,
	status: ConnectionStatusFilter,
) {
	const query = q.trim().toLowerCase();
	return rows.filter((row) => {
		if (row.provider.connectionType !== "oauth") return false;
		if (
			query &&
			!`${row.provider.name} ${friendlyPersonalProviderName(row.provider)} ${row.instanceLabel ?? ""}`
				.toLowerCase()
				.includes(query)
		)
			return false;
		const connected =
			row.accountState === "present" && row.connection?.status === "connected";
		if (status === "attention") return !connected;
		if (status === "connected") return connected;
		if (status === "not_connected")
			return (
				row.accountState === "missing" || row.connection?.status === "revoked"
			);
		if (status === "used") return row.references.length > 0;
		if (status === "unused")
			return row.referencesComplete && row.references.length === 0;
		return true;
	});
}

export function ConnectionVerificationNotice({
	issues,
}: {
	issues: ConnectionInventory["issues"];
}) {
	if (issues.length === 0) return null;
	return (
		<Alert>
			<Info aria-hidden />
			<AlertTitle>Verification incomplete</AlertTitle>
			<AlertDescription>
				Some accounts could not be checked. Your existing connections have not
				changed.
			</AlertDescription>
			<Collapsible>
				<CollapsibleTrigger className="mt-2">
					View {issues.length} verification{" "}
					{issues.length === 1 ? "issue" : "issues"}
					<CaretDown size={14} aria-hidden />
				</CollapsibleTrigger>
				<CollapsibleContent>
					<ul className="space-y-2 pt-2 text-kumo-subtle type-tedix-body">
						{issues.map((issue) => (
							<li key={issue.source}>
								<strong className="text-kumo-default">
									{issue.source === "credentials"
										? "Credentials"
										: "App references"}
									:
								</strong>{" "}
								{issue.message}
							</li>
						))}
					</ul>
				</CollapsibleContent>
			</Collapsible>
		</Alert>
	);
}

export function AdminConnectionsPage({
	search,
	onSearchChange,
	scope = "organization",
}: {
	scope?: "organization" | "personal";
	search: AdminConnectionsSearch;
	onSearchChange: (next: Partial<AdminConnectionsSearch>) => void;
}) {
	const canManageConnections = useCanManageConnections();
	const canBindPersonalAccounts = useCanBindPersonalAccounts();
	const canManagePersonalOauthConnections =
		useCanManagePersonalOauthConnections();
	const queryClient = useQueryClient();
	const { q, status: statusFilter, connect: autoConnectAppId } = search;

	const providersQuery = useQuery(
		connectionsOverviewQueryOptions({
			scope,
			q: "",
			status: "all",
			limit: 100,
			offset: 0,
			...(autoConnectAppId ? { providerId: autoConnectAppId } : {}),
		}),
	);
	const connectionsQuery = providersQuery;
	const inventory = providersQuery.data?.rows ?? [];
	const defaultInventory = inventory.filter((row) => !row.connectionInstanceId);
	const namedInventory = inventory.filter((row) => row.connectionInstanceId);
	const providers = defaultInventory.map((row) => row.provider);
	const connections = defaultInventory.flatMap((row) =>
		row.connection ? [row.connection] : [],
	);
	const inventoryByProvider = new Map(
		defaultInventory.map((row) => [row.provider.appId, row]),
	);

	// ---------------------------------------------------------------------------
	// Connection / disconnect state
	// ---------------------------------------------------------------------------
	const [connectingAppId, setConnectingAppId] = useState<string | null>(null);
	const [apiKeyFlowAppId, setApiKeyFlowAppId] = useState<string | null>(null);
	const [apiKeyFlowScope, setApiKeyFlowScope] = useState<"tenant" | "user">(
		"tenant",
	);
	const [apiKeyValue, setApiKeyValue] = useState("");
	const [apiKeyFields, setApiKeyFields] = useState<Record<string, string>>({});
	const [disconnectingKey, setDisconnectingKey] = useState<{
		appId: string;
	} | null>(null);
	const [disconnectTarget, setDisconnectTarget] =
		useState<DisconnectConnectionTarget | null>(null);
	/** OS mounts no global toaster; action failures render as an inline alert. */
	const [reviewedProvider, setReviewedProvider] =
		useState<ConnectionProvider | null>(null);
	const [pendingConnect, setPendingConnect] =
		useState<ConnectionInventoryRow | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [accountEditor, setAccountEditor] = useState<{
		providerId: string;
		id: string;
	} | null>(null);
	const [accountLabel, setAccountLabel] = useState("");
	const accountMutation = useMutation({
		mutationFn: async () => {
			if (!accountEditor) return;
			await osApi.connections.renameConnectionInstance({
				id: accountEditor.id,
				label: accountLabel.trim(),
				scope: scope === "organization" ? "tenant" : "user",
			});
		},
		onSuccess: () => {
			setAccountEditor(null);
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.connections(),
			});
		},
		onError: (error) =>
			setActionError(errorMessage(error, "Could not save personal account")),
	});
	const bindMutation = useMutation({
		mutationFn: (input: {
			appId: string;
			providerId: string;
			connectionInstanceId: string;
		}) =>
			osApi.connections.bindConnectionInstance({
				...input,
				scope: scope === "organization" ? "tenant" : "user",
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.connections(),
			});
		},
		onError: (error) =>
			setActionError(errorMessage(error, "Could not bind personal account")),
	});
	const [serviceHealthByProvider, setServiceHealthByProvider] = useState<
		Record<
			string,
			{
				status: "checking" | "healthy" | "unhealthy" | "error";
				detail: string;
				appSlug: string;
				toolCount: number | null;
				checkedAt?: string;
			}
		>
	>({});

	// ---------------------------------------------------------------------------
	// Group connections by provider, split by scope
	// ---------------------------------------------------------------------------
	const { orgConnectionsByProvider, personalConnectionsByProvider } =
		useMemo(() => {
			const org = new Map<string, UserConnection[]>();
			const personal = new Map<string, UserConnection[]>();
			for (const c of connections) {
				if (c.tokenScope === "user") {
					const existing = personal.get(c.appId) ?? [];
					existing.push(c);
					personal.set(c.appId, existing);
				} else {
					const existing = org.get(c.appId) ?? [];
					existing.push(c);
					org.set(c.appId, existing);
				}
			}
			return {
				orgConnectionsByProvider: org,
				personalConnectionsByProvider: personal,
			};
		}, [connections]);

	// ---------------------------------------------------------------------------
	// Filter providers
	// ---------------------------------------------------------------------------
	const filterProviders = (
		list: ConnectionProvider[],
		scopedConnections: Map<string, UserConnection[]>,
	) => {
		return list.filter((p) => {
			if (q && !p.name.toLowerCase().includes(q.toLowerCase())) {
				return false;
			}
			const hasConnection = (scopedConnections.get(p.appId)?.length ?? 0) > 0;
			// "used" — only providers actually referenced by this org's apps OR
			// already connected. Default view; cuts the project-wide noise of 13+
			// providers down to the ones that matter for this tenant.
			if (statusFilter === "used" && !p.referencedByOrg) {
				return false;
			}
			const row = inventoryByProvider.get(p.appId);
			if (
				statusFilter === "unused" &&
				(!row?.referencesComplete || row.references.length > 0)
			)
				return false;
			if (statusFilter === "attention" && row?.accountState === "present")
				return false;
			if (statusFilter === "connected" && !hasConnection) return false;
			if (statusFilter === "not_connected" && hasConnection) return false;
			return true;
		});
	};

	const orgEligibleProviders = providers.filter((p) => {
		const hasOrgConnection =
			(orgConnectionsByProvider.get(p.appId)?.length ?? 0) > 0;
		return (
			scope === "organization" &&
			p.connectionType !== "oauth" &&
			(p.supportedScopes?.includes("tenant") || hasOrgConnection)
		);
	});
	const personalEligibleProviders = providers.filter(
		(p) =>
			scope === "personal" &&
			p.supportedScopes?.includes("user") &&
			p.connectionType !== "oauth",
	);
	const filteredOrgProviders = filterProviders(
		orgEligibleProviders,
		orgConnectionsByProvider,
	);
	const filteredPersonalProviders = filterProviders(
		personalEligibleProviders,
		personalConnectionsByProvider,
	);
	const accountScope = scope === "organization" ? "tenant" : "user";
	const canManageAccounts =
		accountScope === "tenant"
			? canManageConnections
			: canManagePersonalOauthConnections;
	const filteredPersonalAccounts = filterPersonalAccountRows(
		inventory,
		q,
		statusFilter,
	);
	const personalAccountGroups = new Map<string, ConnectionInventoryRow[]>();
	for (const row of filteredPersonalAccounts) {
		const group = personalAccountGroups.get(row.provider.appId) ?? [];
		group.push(row);
		personalAccountGroups.set(row.provider.appId, group);
	}
	const totalFiltered =
		filteredOrgProviders.length +
		filteredPersonalProviders.length +
		filteredPersonalAccounts.length;

	// ---------------------------------------------------------------------------
	// Auto-connect when ?connect= query param is present
	// ---------------------------------------------------------------------------
	const autoConnectTriggered = useRef(false);
	useEffect(() => {
		if (
			!autoConnectAppId ||
			autoConnectTriggered.current ||
			providers.length === 0
		)
			return;
		const provider = providers.find((p) => p.appId === autoConnectAppId);
		if (!provider) return;
		const connection = connections.find((c) => c.appId === autoConnectAppId);
		if (connection?.status === "connected") return;
		autoConnectTriggered.current = true;
		handleConnect(
			provider.appId,
			provider.connectionType,
			provider.recommendedScope,
		);
	}, [autoConnectAppId, providers, connections]);

	// Listen for OAuth popup completion message
	useConnectionCompleteListener();

	// ---------------------------------------------------------------------------
	// Mutations
	// ---------------------------------------------------------------------------
	const disconnectMutation = useDisconnectConnection({
		onSuccess: () => {
			setDisconnectingKey(null);
			setDisconnectTarget(null);
			setActionError(null);
		},
	});
	useEffect(() => {
		if (disconnectMutation.isError) {
			setDisconnectingKey(null);
			setActionError(
				errorMessage(
					disconnectMutation.error,
					"Failed to disconnect credential",
				),
			);
		}
	}, [disconnectMutation.isError, disconnectMutation.error]);

	const storeApiKeyMutation = useMutation({
		mutationFn: (input: {
			providerId: string;
			apiKey?: string;
			credentialFields?: Record<string, string>;
			tokenScope: "tenant" | "user";
		}) => osApi.connections.storeApiKey(input),
		onSuccess: () => {
			setApiKeyFlowAppId(null);
			setApiKeyValue("");
			setApiKeyFields({});
			setActionError(null);
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.connections(),
			});
		},
		onError: (error) => {
			setActionError(errorMessage(error, "Failed to save credential"));
		},
	});

	// ---------------------------------------------------------------------------
	// Connect handler
	// ---------------------------------------------------------------------------
	const handleAddPersonalAccount = (provider: ConnectionProvider) => {
		if (
			!canManageAccounts ||
			connectingAppId ||
			provider.connectionType !== "oauth" ||
			provider.registrationMode === "cimd" ||
			!provider.referencedByOrg
		)
			return;
		setConnectingAppId(provider.appId);
		setActionError(null);
		void startNamedOauthConnect({
			appId: provider.appId,
			effectiveScope: accountScope,
		})
			.catch((error: unknown) => {
				setActionError(
					errorMessage(error, "Could not connect another account"),
				);
			})
			.finally(() => {
				setConnectingAppId(null);
				void queryClient.invalidateQueries({
					queryKey: osQueryKeys.connections(),
				});
			});
	};
	const handleConnect = (
		appId: string,
		connectionType: "oauth" | "api_key",
		tokenScope?: "tenant" | "user",
		connectionInstanceId?: string,
	) => {
		const provider =
			inventory.find((row) => row.provider.appId === appId)?.provider ??
			(reviewedProvider?.appId === appId ? reviewedProvider : null);
		const isPersonalOauth = connectionType === "oauth" && tokenScope === "user";
		if (
			isPersonalOauth
				? !canManagePersonalOauthConnections
				: !canManageConnections
		)
			return;
		if (connectionType === "api_key") {
			const defaultFields = Object.fromEntries(
				(provider?.credentialProfile?.inputFields ?? []).map((field) => [
					field.name,
					field.defaultValue ?? "",
				]),
			);
			setApiKeyFlowAppId(appId);
			setApiKeyFlowScope(tokenScope ?? "tenant");
			setApiKeyValue("");
			setApiKeyFields(defaultFields);
			return;
		}

		setConnectingAppId(appId);
		void startOauthConnect({
			appId,
			effectiveScope: effectiveConnectionScope(
				provider ?? undefined,
				tokenScope,
			),
			registrationMode: provider?.registrationMode,
			connectionInstanceId,
		})
			.then(() => {
				setConnectingAppId(null);
				setActionError(null);
			})
			.catch((error: unknown) => {
				setConnectingAppId(null);
				setActionError(
					errorMessage(error, "Could not open the connection window"),
				);
			})
			.finally(() => {
				void queryClient.invalidateQueries({
					queryKey: osQueryKeys.connections(),
				});
			});
	};

	// ---------------------------------------------------------------------------
	// API key submit
	// ---------------------------------------------------------------------------
	const handleApiKeySubmit = () => {
		if (!apiKeyFlowAppId || storeApiKeyMutation.isPending) return;
		const inputFields =
			apiKeyFlowProvider?.credentialProfile?.inputFields ?? [];
		const hasStructuredFields = inputFields.length > 0;
		const hasCredential = hasStructuredFields
			? inputFields.every(
					(field) =>
						field.required === false || apiKeyFields[field.name]?.trim(),
				)
			: !!apiKeyValue.trim();
		if (!hasCredential) return;
		storeApiKeyMutation.mutate({
			providerId: apiKeyFlowAppId,
			...(hasStructuredFields
				? { credentialFields: apiKeyFields }
				: { apiKey: apiKeyValue.trim() }),
			tokenScope: apiKeyFlowScope,
		});
	};

	// ---------------------------------------------------------------------------
	// Disconnect callbacks for list items
	// ---------------------------------------------------------------------------
	const handleDisconnect = (appId: string, tokenScope: "tenant" | "user") => {
		setDisconnectTarget({
			appId,
			providerName:
				providers.find((provider) => provider.appId === appId)?.name ??
				"service",
			tokenScope,
		});
	};
	const handleCheckService = async (providerId: string, appSlug: string) => {
		setServiceHealthByProvider((current) => ({
			...current,
			[providerId]: {
				status: "checking",
				detail: `Checking ${appSlug}'s MCP protocol service…`,
				appSlug,
				toolCount: current[providerId]?.toolCount ?? null,
			},
		}));
		try {
			const result = await osDirectReadApi.mcpHealth.run({
				appSlug,
				authStrategy: "auto",
				tasksExtension: "ignore",
			});
			setServiceHealthByProvider((current) => ({
				...current,
				[providerId]: {
					status: result.allPassed ? "healthy" : "unhealthy",
					detail: result.allPassed
						? `${appSlug}'s MCP protocol service passed ${result.passCount} checks. Provider API tools and credential usability were not tested.`
						: `${appSlug}'s MCP protocol service failed ${result.failCount} of ${result.passCount + result.failCount} checks. Provider API health remains unknown.`,
					appSlug,
					toolCount: result.toolCount,
					checkedAt: new Date().toISOString(),
				},
			}));
		} catch (error) {
			setServiceHealthByProvider((current) => ({
				...current,
				[providerId]: {
					status: "error",
					detail: errorMessage(error, "The app service check could not run."),
					appSlug,
					toolCount: null,
					checkedAt: new Date().toISOString(),
				},
			}));
		}
	};

	const apiKeyFlowProvider = apiKeyFlowAppId
		? (providers.find((p) => p.appId === apiKeyFlowAppId) ??
			(reviewedProvider?.appId === apiKeyFlowAppId ? reviewedProvider : null))
		: null;

	const webMcpContext = useRef({
		openReview: (
			_action: "connect" | "disconnect",
			_row: ConnectionInventoryRow,
		): boolean => false,
	});
	webMcpContext.current = {
		openReview: (action, row) => {
			if (
				pendingConnect ||
				disconnectTarget ||
				apiKeyFlowAppId ||
				connectingAppId ||
				disconnectMutation.isPending
			)
				return false;
			const permitted =
				row.scope === "user" && row.provider.connectionType === "oauth"
					? canManagePersonalOauthConnections
					: canManageConnections;
			if (!permitted) return false;
			if (action === "connect") {
				setReviewedProvider(row.provider);
				setPendingConnect(row);
			} else
				setDisconnectTarget({
					appId: row.provider.appId,
					providerName: row.provider.name,
					tokenScope: row.scope,
					connectionInstanceId: row.connectionInstanceId,
				});
			return true;
		},
	};
	useWebMcpTools(
		"connections",
		() =>
			buildConnectionsWebMcpTools({
				scope,
				prepare: (action, row) => webMcpContext.current.openReview(action, row),
			}),
		[scope],
	);

	// ---------------------------------------------------------------------------
	// Render
	// ---------------------------------------------------------------------------
	const isPending = providersQuery.isPending || connectionsQuery.isPending;

	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>
						{scope === "organization"
							? "Organization connections"
							: "My accounts"}
					</PageTitle>
					<PageDescription>
						{scope === "organization"
							? "Accounts shared with this organization."
							: "Accounts only you can use, across workspaces."}
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<CapabilityNavigation active={scope} />

			{canManageConnections ? null : (
				<Alert>
					<Info aria-hidden />
					<AlertTitle>
						{canManagePersonalOauthConnections
							? "You can manage your personal OAuth connections"
							: "You have read-only access to connections"}
					</AlertTitle>
					<AlertDescription>
						{canManagePersonalOauthConnections
							? "Organization connections and API keys remain read-only. Ask an organization admin to manage shared credentials."
							: "Connecting and disconnecting requires workspace access. Ask an organization admin to make the change, or to grant it."}
					</AlertDescription>
				</Alert>
			)}

			{actionError && (
				<Alert variant="destructive">
					<AlertTitle>The last action failed</AlertTitle>
					<AlertDescription>{actionError}</AlertDescription>
				</Alert>
			)}

			{providersQuery.isError && (
				<Alert variant="destructive">
					<AlertTitle>Connection providers are unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(
							providersQuery.error,
							"The provider read failed. Your connections were not changed.",
						)}
					</AlertDescription>
					<AlertAction>
						<Button
							variant="outline"
							size="sm"
							onClick={() => void providersQuery.refetch()}
						>
							Retry
						</Button>
					</AlertAction>
				</Alert>
			)}

			<ConnectionVerificationNotice
				issues={providersQuery.data?.issues ?? []}
			/>
			<Dialog
				open={accountEditor !== null}
				onOpenChange={(open) => {
					if (!open && !accountMutation.isPending) setAccountEditor(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Rename personal account</DialogTitle>
						<DialogDescription>
							Use a label such as Work or Personal. Renaming does not change the
							signed-in account or share it with your organization.
						</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="Account label"
						value={accountLabel}
						maxLength={100}
						onChange={(event) => setAccountLabel(event.target.value)}
					/>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setAccountEditor(null)}
							disabled={accountMutation.isPending}
						>
							Cancel
						</Button>
						<Button
							onClick={() => accountMutation.mutate()}
							disabled={!accountLabel.trim() || accountMutation.isPending}
						>
							Save account
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{providersQuery.data?.hasMore && (
				<Alert>
					<AlertDescription>
						Showing the first {inventory.length} of {providersQuery.data.total}{" "}
						account rows. Search and status filters apply only to these loaded
						rows; omitted rows are not evaluated here.
					</AlertDescription>
				</Alert>
			)}
			{isPending ? (
				<ListSkeleton rows={4} />
			) : providersQuery.isError ? null : providers.length === 0 &&
			  namedInventory.length === 0 ? (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Plugs aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>No connections in this view</EmptyTitle>
						<EmptyDescription>
							No accounts or app requirements were found in this view. Personal
							accounts are managed separately.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					{/* Filter toolbar */}
					<PageToolbar aria-label="Connection inventory controls">
						<div className="min-w-0 flex-1">
							<KumoTabs
								className="min-w-0 max-sm:[&_[role=tab]]:!h-11 max-sm:[&_[role=tablist]]:!h-11"
								value={statusFilter}
								onValueChange={(value) =>
									onSearchChange({
										status: value as ConnectionStatusFilter,
									})
								}
								aria-label="Connection status"
								size="sm"
								tabs={[
									{ value: "all", label: "All", className: "text-xs" },
									{
										value: "attention",
										label: "Needs attention",
										className: "text-xs",
									},
									{ value: "used", label: "Referenced", className: "text-xs" },
									{ value: "unused", label: "Unused", className: "text-xs" },
								]}
							/>
						</div>

						<SearchInput
							containerClassName="w-full max-sm:min-h-11 lg:w-72 lg:shrink-0"
							aria-label="Search connections"
							placeholder="Search connections..."
							value={q}
							onChange={(e) => onSearchChange({ q: e.target.value })}
							trailing={
								<span className="whitespace-nowrap text-kumo-subtle type-tedix-label">
									{connectionInventoryCountLabel(
										totalFiltered,
										inventory.length,
										Boolean(providersQuery.data?.hasMore),
									)}
								</span>
							}
						/>
					</PageToolbar>

					{/* No results after filtering */}
					{totalFiltered === 0 && (
						<Empty appearance="quiet">
							<EmptyDescription>
								No connections match your filters
							</EmptyDescription>
						</Empty>
					)}

					{/* Organization connections */}
					{filteredOrgProviders.length > 0 && (
						<ProviderSection
							icon={<Buildings className="h-4 w-4 text-kumo-subtle" />}
							title="Organization connections"
							description="Organization-owned credentials. App references do not prove permission to use them or provider health."
							count={filteredOrgProviders.length}
							providers={filteredOrgProviders}
							inventoryByProvider={inventoryByProvider}
							connectionsByProvider={orgConnectionsByProvider}
							connectingAppId={connectingAppId}
							disconnectingKey={disconnectingKey}
							isDisconnecting={disconnectMutation.isPending}
							onConnect={handleConnect}
							onDisconnect={handleDisconnect}
							canManageOrganizationConnections={canManageConnections}
							canManagePersonalOauthConnections={
								canManagePersonalOauthConnections
							}
							serviceHealthByProvider={serviceHealthByProvider}
							onCheckService={handleCheckService}
							sectionScope="tenant"
						/>
					)}

					{/* Personal connections */}
					{[...personalAccountGroups.entries()].map(([providerId, rows]) => (
						<PersonalProviderAccounts
							key={providerId}
							provider={rows[0]!.provider}
							rows={rows}
							canManage={canManageAccounts}
							canBind={
								canBindPersonalAccounts &&
								(accountScope === "user" || canManageConnections)
							}
							canAdd={
								canManageAccounts &&
								rows[0]!.provider.registrationMode !== "cimd" &&
								rows[0]!.provider.referencedByOrg
							}
							isConnecting={connectingAppId !== null}
							isDisconnecting={disconnectMutation.isPending}
							isBinding={bindMutation.isPending}
							onAdd={handleAddPersonalAccount}
							onConnect={(row) =>
								handleConnect(
									row.provider.appId,
									"oauth",
									accountScope,
									row.connectionInstanceId,
								)
							}
							onRename={(row) => {
								if (!row.connectionInstanceId || !canManageAccounts) return;
								setAccountEditor({
									providerId: row.provider.appId,
									id: row.connectionInstanceId,
								});
								setAccountLabel(row.instanceLabel ?? "");
							}}
							onDisconnect={(row) =>
								setDisconnectTarget({
									appId: row.provider.appId,
									providerName: `${friendlyPersonalProviderName(row.provider)} · ${row.instanceLabel ?? "Default account"}`,
									tokenScope: row.scope,
									connectionInstanceId: row.connectionInstanceId,
								})
							}
							onBind={(row, reference) => {
								if (!row.connectionInstanceId || !canBindPersonalAccounts)
									return;
								bindMutation.mutate({
									appId: reference.appId,
									providerId: row.provider.appId,
									connectionInstanceId: row.connectionInstanceId,
								});
							}}
							serviceHealth={serviceHealthByProvider[providerId]}
							onCheckService={handleCheckService}
						/>
					))}
					{filteredPersonalProviders.length > 0 && (
						<ProviderSection
							icon={<User className="h-4 w-4 text-kumo-subtle" />}
							title="My accounts"
							description="Your credentials, not organization-owned accounts. App references do not prove that this workspace can use your account."
							count={filteredPersonalProviders.length}
							providers={filteredPersonalProviders}
							inventoryByProvider={inventoryByProvider}
							connectionsByProvider={personalConnectionsByProvider}
							connectingAppId={connectingAppId}
							disconnectingKey={disconnectingKey}
							isDisconnecting={disconnectMutation.isPending}
							onConnect={handleConnect}
							onDisconnect={handleDisconnect}
							canManageOrganizationConnections={canManageConnections}
							canManagePersonalOauthConnections={
								canManagePersonalOauthConnections
							}
							serviceHealthByProvider={serviceHealthByProvider}
							onCheckService={handleCheckService}
							sectionScope="user"
						/>
					)}
				</>
			)}

			<Dialog
				open={pendingConnect !== null}
				onOpenChange={(open) => {
					if (!open) setPendingConnect(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Connect {pendingConnect?.provider.name}</DialogTitle>
						<DialogDescription>
							{pendingConnect?.scope === "tenant"
								? "This will create or replace an organization credential."
								: "This will connect your personal account."}{" "}
							Continue to review the provider's permissions. Nothing has changed
							yet.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setPendingConnect(null)}>
							Cancel
						</Button>
						<Button
							onClick={() => {
								const target = pendingConnect;
								if (!target) return;
								setPendingConnect(null);
								handleConnect(
									target.provider.appId,
									target.provider.connectionType,
									target.scope,
									target.connectionInstanceId,
								);
							}}
						>
							Continue
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{/* API Key Dialog */}
			<Dialog
				open={!!apiKeyFlowAppId}
				onOpenChange={(open) => {
					if (!open && !storeApiKeyMutation.isPending) {
						setApiKeyFlowAppId(null);
						setApiKeyValue("");
						setApiKeyFields({});
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{`Connect ${apiKeyFlowProvider?.name ?? "Service"}`}
						</DialogTitle>
						<DialogDescription>
							The key is encrypted and stored for the selected credential scope.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="space-y-2">
							{apiKeyFlowProvider?.credentialProfile?.inputFields?.length ? (
								apiKeyFlowProvider.credentialProfile.inputFields.map(
									(field, index) => (
										<div key={field.name} className="min-w-0">
											{field.type === "text" ? (
												<Input
													label={field.label}
													description={field.helpText}
													type="text"
													placeholder={field.placeholder}
													value={apiKeyFields[field.name] ?? ""}
													onChange={(e) =>
														setApiKeyFields((current) => ({
															...current,
															[field.name]: e.target.value,
														}))
													}
													onKeyDown={(e) =>
														e.key === "Enter" &&
														!isImeComposing(e) &&
														handleApiKeySubmit()
													}
													autoComplete="off"
													autoFocus={index === 0}
												/>
											) : (
												<SensitiveInput
													label={field.label}
													description={field.helpText}
													placeholder={field.placeholder}
													value={apiKeyFields[field.name] ?? ""}
													onValueChange={(value) =>
														setApiKeyFields((current) => ({
															...current,
															[field.name]: value,
														}))
													}
													onKeyDown={(e) =>
														e.key === "Enter" &&
														!isImeComposing(e) &&
														handleApiKeySubmit()
													}
													autoComplete="off"
													autoFocus={index === 0}
												/>
											)}
										</div>
									),
								)
							) : (
								<div className="min-w-0">
									<SensitiveInput
										label="API key"
										description={
											apiKeyFlowProvider?.credentialProfile?.helpText ??
											"To use multiple project keys, create a separate connection for each project."
										}
										placeholder="Enter your API key..."
										value={apiKeyValue}
										onValueChange={setApiKeyValue}
										onKeyDown={(e) =>
											e.key === "Enter" &&
											!isImeComposing(e) &&
											handleApiKeySubmit()
										}
										autoComplete="off"
										autoFocus
									/>
								</div>
							)}
							{apiKeyFlowProvider?.credentialProfile?.inputFields?.length ? (
								<Text role="body" tone="secondary">
									{apiKeyFlowProvider.credentialProfile.helpText ??
										"To use multiple project keys, create a separate connection for each project."}
								</Text>
							) : null}
						</div>
						<DialogFooter>
							<Button
								className="w-full sm:w-auto"
								loading={storeApiKeyMutation.isPending}
								onClick={handleApiKeySubmit}
								disabled={
									storeApiKeyMutation.isPending ||
									(apiKeyFlowProvider?.credentialProfile?.inputFields?.length
										? !apiKeyFlowProvider.credentialProfile.inputFields.every(
												(field) =>
													field.required === false ||
													apiKeyFields[field.name]?.trim(),
											)
										: !apiKeyValue.trim())
								}
							>
								Save key
							</Button>
						</DialogFooter>
					</div>
				</DialogContent>
			</Dialog>

			<DisconnectConnectionDialog
				target={disconnectTarget}
				isPending={disconnectMutation.isPending}
				onCancel={() => setDisconnectTarget(null)}
				onConfirm={(target) => {
					setDisconnectingKey({ appId: target.appId });
					disconnectMutation.mutate({
						appId: target.appId,
						tokenScope: target.tokenScope,
						connectionInstanceId: target.connectionInstanceId,
					});
				}}
			/>
		</Page>
	);
}

/**
 * The Descope OutboundApplications widget preview, mounted lazily behind a
 * collapsible like the identity widgets on /admin/organization. It needs the
 * org's Descope tenant id, which lives on the organization detail read.
 */
// =============================================================================
// Provider Section (collapsible group)
// =============================================================================

function ProviderSection({
	icon,
	title,
	description,
	count,
	providers,
	inventoryByProvider,
	connectionsByProvider,
	connectingAppId,
	disconnectingKey,
	isDisconnecting,
	onConnect,
	onDisconnect,
	sectionScope,
	canManageOrganizationConnections,
	canManagePersonalOauthConnections,
	serviceHealthByProvider,
	onCheckService,
}: {
	icon: React.ReactNode;
	title: string;
	description?: string;
	count: number;
	providers: ConnectionProvider[];
	inventoryByProvider: Map<string, ConnectionInventoryRow>;
	connectionsByProvider: Map<string, UserConnection[]>;
	connectingAppId: string | null;
	disconnectingKey: { appId: string } | null;
	isDisconnecting: boolean;
	onConnect: (
		appId: string,
		connectionType: "oauth" | "api_key",
		tokenScope?: "tenant" | "user",
	) => void;
	onDisconnect: (appId: string, tokenScope: "tenant" | "user") => void;
	canManageOrganizationConnections: boolean;
	canManagePersonalOauthConnections: boolean;
	serviceHealthByProvider: Record<
		string,
		{
			status: "checking" | "healthy" | "unhealthy" | "error";
			detail: string;
			appSlug: string;
			toolCount: number | null;
			checkedAt?: string;
		}
	>;
	onCheckService: (providerId: string, appSlug: string) => void;
	sectionScope?: "tenant" | "user";
}) {
	const titleId = `${sectionScope ?? "connection"}-connections-title`;

	return (
		<PageSection aria-labelledby={titleId}>
			<SectionHeader>
				<SectionHeading>
					<div className="flex items-center gap-2">
						<span className="text-kumo-subtle" aria-hidden="true">
							{icon}
						</span>
						<SectionTitle id={titleId}>{title}</SectionTitle>
					</div>
					{description && (
						<SectionDescription>{description}</SectionDescription>
					)}
				</SectionHeading>
				<SectionActions>
					<Badge variant="secondary">{count} shown</Badge>
				</SectionActions>
			</SectionHeader>
			<Collection aria-label={title}>
				{providers.map((provider) => {
					const isPersonalOauth =
						sectionScope === "user" && provider.connectionType === "oauth";
					const canManage = isPersonalOauth
						? canManagePersonalOauthConnections
						: canManageOrganizationConnections;
					const manageDeniedReason = isPersonalOauth
						? "Managing your personal OAuth connection requires workspace access."
						: "Organization connections and API keys require the Manage integrations permission.";
					return (
						<li key={provider.appId}>
							<ConnectionListItem
								provider={provider}
								inventory={inventoryByProvider.get(provider.appId)}
								connections={connectionsByProvider.get(provider.appId) ?? []}
								onConnect={onConnect}
								isConnecting={connectingAppId === provider.appId}
								onDisconnect={onDisconnect}
								isDisconnecting={isDisconnecting}
								disconnectingKey={disconnectingKey}
								sectionScope={sectionScope}
								canManage={canManage}
								manageDeniedReason={manageDeniedReason}
								serviceHealth={serviceHealthByProvider[provider.appId]}
								onCheckService={onCheckService}
							/>
						</li>
					);
				})}
			</Collection>
		</PageSection>
	);
}

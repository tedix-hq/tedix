import { CapabilityNavigation } from "@/components/capability-navigation";
/**
 * Admin › Connections
 *
 * Organization connections and My accounts on the `connections` oRPC
 * contract. Both scopes render the same `AccountList`: OAuth providers
 * (Connect → session-broker handoff → Descope Vault) and API-key providers
 * (Connect → key form → Descope AIH Token Vault) share one row anatomy and one
 * status vocabulary; only the owner differs.
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
	ConnectionProvider,
	ConnectionInventoryRow,
} from "@tedix/api-contract/schemas/connections";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Plugs } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { isImeComposing } from "@/lib/keyboard";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
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
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
	PageToolbar,
} from "@/components/kumo/page";

import { KumoTabs } from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import {
	AccountList,
	accountLabel as accountDisplayLabel,
	accountStatus,
	friendlyProviderName,
	groupAccounts,
	type ServiceHealth,
} from "@/components/account-list";
import { ConnectionResourceLimitsEditor } from "@/components/connection-resource-limits";
import { ConnectionConsumerGrantsEditor } from "@/components/connection-consumer-grants";
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
import { connectionAccountMode } from "@tedix/api-contract/utils/connection-account-mode";
import { osApi, osDirectReadApi } from "@/lib/api";
import {
	connectionsOverviewQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";
import { buildConnectionsWebMcpTools } from "@/components/connections-webmcp-tools";
import { ConnectionToolSummary } from "@/components/connection-tool-summary";

export function connectionInventoryCountLabel(
	shown: number,
	loaded: number,
	hasMore: boolean,
) {
	return `${shown} of ${hasMore ? `first ${loaded}` : loaded} shown`;
}

/** Search and status tabs over exact account rows, in either owner scope. */
export function filterAccountRows(
	rows: ConnectionInventoryRow[],
	q: string,
	status: ConnectionStatusFilter,
) {
	const query = q.trim().toLowerCase();
	return rows.filter((row) => {
		if (
			query &&
			!`${row.provider.name} ${friendlyProviderName(row.provider)} ${row.instanceLabel ?? ""}`
				.toLowerCase()
				.includes(query)
		)
			return false;
		const kind = accountStatus(row).kind;
		if (status === "attention") return kind === "attention";
		if (status === "connected") return kind === "connected";
		if (status === "not_connected") return kind === "available";
		if (status === "used") return row.references.length > 0;
		if (status === "unused")
			return row.referencesComplete && row.references.length === 0;
		return true;
	});
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
	const inventory = providersQuery.data?.rows ?? [];
	const providers = [
		...new Map(
			inventory.map((row) => [row.provider.appId, row.provider]),
		).values(),
	];

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
	const [disconnectTarget, setDisconnectTarget] =
		useState<DisconnectConnectionTarget | null>(null);
	/** OS mounts no global toaster; action failures render as an inline alert. */
	const [reviewedProvider, setReviewedProvider] =
		useState<ConnectionProvider | null>(null);
	const [pendingConnect, setPendingConnect] = useState<
		| (ConnectionInventoryRow & {
				requestedScopes?: string[];
				/** Replaces a working credential, so the dialog states the consequence. */
				reconnect?: boolean;
		  })
		| null
	>(null);
	const canConfirmConnect =
		pendingConnect?.scope === "user" &&
		pendingConnect.provider.connectionType === "oauth"
			? canManagePersonalOauthConnections
			: canManageConnections;
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
	const accessCheckMutation = useMutation({
		mutationFn: (input: {
			id: string;
			checkEachPersonsAccess: boolean | null;
		}) => osApi.connections.setConnectionAccessCheck(input),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.connections(),
			});
		},
		onError: (error) =>
			setActionError(errorMessage(error, "Could not change the access check")),
	});
	const accountModeMutation = useMutation({
		mutationFn: (input: {
			appId: string;
			accountMode: "single" | "multiple";
		}) => osApi.connections.setProviderAccountMode(input),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.connections(),
			});
		},
		onError: (error) =>
			setActionError(errorMessage(error, "Could not change account policy")),
	});
	const [serviceHealthByProvider, setServiceHealthByProvider] = useState<
		Record<string, ServiceHealth | undefined>
	>({});

	// ---------------------------------------------------------------------------
	// One list for both owners: filter exact rows, then group by provider.
	// ---------------------------------------------------------------------------
	const accountScope = scope === "organization" ? "tenant" : "user";
	const canManageAccounts =
		accountScope === "tenant"
			? canManageConnections
			: canManagePersonalOauthConnections;
	const canManageRow = (row: ConnectionInventoryRow) =>
		row.scope === "user" && row.provider.connectionType === "oauth"
			? canManagePersonalOauthConnections
			: canManageConnections;
	const deniedReason = (row: ConnectionInventoryRow) =>
		row.scope === "user" && row.provider.connectionType === "oauth"
			? "Managing your own account requires workspace access."
			: "Only an organization admin can change shared accounts and API keys.";
	const filteredAccounts = filterAccountRows(inventory, q, statusFilter);
	const accountGroups = groupAccounts(filteredAccounts);
	const totalFiltered = filteredAccounts.length;

	// ---------------------------------------------------------------------------
	// Review a setup deep link before opening consent or replacing a credential.
	// ---------------------------------------------------------------------------
	const autoConnectTriggered = useRef<string | null>(null);
	useEffect(() => {
		if (!autoConnectAppId) return;
		const key = `${autoConnectAppId}:${search.connectionInstanceId ?? ""}:${search.capability ?? ""}:${search.scopes ?? ""}`;
		if (autoConnectTriggered.current === key) return;
		const target = inventory.find(
			(row) =>
				row.provider.appId === autoConnectAppId &&
				row.connectionInstanceId === search.connectionInstanceId,
		);
		if (!target) return;
		const capability = target.capabilities?.find(
			(item) => item.id === search.capability,
		);
		if (
			search.capability &&
			(!capability ||
				capability.state === "connected" ||
				capability.state === "not_supported")
		)
			return;
		const requiredScopes =
			capability?.requiredScopes ??
			search.scopes
				?.split(",")
				.map((item) => item.trim())
				.filter(Boolean) ??
			[];
		if (
			!search.capability &&
			target.connection?.status === "connected" &&
			requiredScopes.every((item) => target.connection?.scopes.includes(item))
		)
			return;
		autoConnectTriggered.current = key;
		if (
			requiredScopes.length > 100 ||
			requiredScopes.some((item) => item.length > 500)
		) {
			setActionError(
				"The setup link contains too many or invalid permissions. Open the connection and reconnect from its capability list.",
			);
			return;
		}
		setReviewedProvider(target.provider);
		setPendingConnect({
			...target,
			requestedScopes: requiredScopes.length
				? [
						...new Set([
							...(target.connection?.scopes ?? []),
							...requiredScopes,
						]),
					]
				: undefined,
		});
	}, [
		autoConnectAppId,
		inventory,
		search.connectionInstanceId,
		search.capability,
		search.scopes,
	]);

	// Listen for OAuth popup completion message
	useConnectionCompleteListener();

	// ---------------------------------------------------------------------------
	// Mutations
	// ---------------------------------------------------------------------------
	const disconnectMutation = useDisconnectConnection({
		onSuccess: () => {
			setDisconnectTarget(null);
			setActionError(null);
		},
	});
	useEffect(() => {
		if (disconnectMutation.isError) {
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
	const canAddAccount = (provider: ConnectionProvider) =>
		canManageAccounts &&
		provider.referencedByOrg &&
		connectionAccountMode(provider).mode === "multiple";
	const handleAddPersonalAccount = (provider: ConnectionProvider) => {
		if (!canAddAccount(provider) || connectingAppId) return;
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
		requestedScopes?: string[],
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
			...(requestedScopes?.length ? { scopes: requestedScopes } : {}),
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
	const isPending = providersQuery.isPending;

	return (
		<Page width="lg">
			<div className="grid min-w-0 gap-4">
				<PageHeader>
					<PageHeading>
						<PageTitle>Accounts</PageTitle>
						<PageDescription>
							{scope === "organization"
								? "Accounts this organization's apps share."
								: "Accounts only you can use, in every workspace."}
						</PageDescription>
					</PageHeading>
				</PageHeader>
				<CapabilityNavigation active={scope} />
			</div>

			{inventory.some((row) => !canManageRow(row)) && (
				<Alert>
					<Info aria-hidden />
					<AlertTitle>
						{inventory.some(canManageRow)
							? "Some accounts are view-only for you"
							: "You can view these accounts but not change them"}
					</AlertTitle>
					<AlertDescription>
						Ask an organization admin to make the change, or to give you access.
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
				<LoadError
					title="Connection providers are unavailable"
					error={providersQuery.error}
					onRetry={() => void providersQuery.refetch()}
					retrying={providersQuery.isFetching}
				/>
			)}

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
			) : providersQuery.isError ? null : inventory.length === 0 ? (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Plugs aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>No accounts yet</EmptyTitle>
						<EmptyDescription>
							{scope === "organization"
								? "When an app in this organization needs an account, it appears here to connect."
								: "When an app you use needs your own account, it appears here to connect."}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<PageToolbar aria-label="Account list controls" appearance="inline">
						<div className="min-w-0 flex-1">
							<KumoTabs
								className="min-w-0"
								value={statusFilter}
								onValueChange={(value) =>
									onSearchChange({
										status: value as ConnectionStatusFilter,
									})
								}
								aria-label="Account status"
								size="sm"
								tabs={[
									{ value: "all", label: "All", className: "text-xs" },
									{
										value: "attention",
										label: "Needs attention",
										className: "text-xs",
									},
									{ value: "used", label: "In use", className: "text-xs" },
									{ value: "unused", label: "Unused", className: "text-xs" },
								]}
							/>
						</div>

						<SearchInput
							containerClassName="w-full max-sm:min-h-11 lg:w-72 lg:shrink-0"
							aria-label="Search accounts"
							placeholder="Search accounts..."
							value={q}
							onChange={(e) => onSearchChange({ q: e.target.value })}
							trailing={
								<span className="hidden whitespace-nowrap text-kumo-subtle type-tedix-label sm:inline">
									{connectionInventoryCountLabel(
										totalFiltered,
										inventory.length,
										Boolean(providersQuery.data?.hasMore),
									)}
								</span>
							}
						/>
					</PageToolbar>

					{totalFiltered === 0 ? (
						<Empty appearance="quiet">
							<EmptyDescription>
								No accounts match your filters
							</EmptyDescription>
						</Empty>
					) : (
						<AccountList
							owner={scope}
							groups={accountGroups}
							checkedAt={providersQuery.data?.observedAt}
							isChecking={providersQuery.isFetching === true}
							onCheck={() => void providersQuery.refetch()}
							canManage={canManageRow}
							deniedReason={deniedReason}
							canAdd={canAddAccount}
							canBind={
								canBindPersonalAccounts &&
								(accountScope === "user" || canManageConnections)
							}
							isConnecting={connectingAppId !== null}
							isDisconnecting={disconnectMutation.isPending}
							isBinding={bindMutation.isPending}
							isAccountModePending={accountModeMutation.isPending}
							availableOpen={Boolean(q.trim()) || statusFilter !== "all"}
							onConnect={(row) => {
								if (!canManageRow(row)) return;
								setReviewedProvider(row.provider);
								setPendingConnect(row);
							}}
							onReconnect={(row) => {
								if (!canManageRow(row)) return;
								setReviewedProvider(row.provider);
								setPendingConnect({ ...row, reconnect: true });
							}}
							onAdd={handleAddPersonalAccount}
							onAccountModeChange={
								scope === "organization" && canManageConnections
									? (provider, accountMode) =>
											accountModeMutation.mutate({
												appId: provider.appId,
												accountMode,
											})
									: undefined
							}
							onRename={(row) => {
								if (!row.connectionInstanceId || !canManageRow(row)) return;
								setAccountEditor({
									providerId: row.provider.appId,
									id: row.connectionInstanceId,
								});
								setAccountLabel(row.instanceLabel ?? "");
							}}
							onDisconnect={(row) => {
								if (!canManageRow(row)) return;
								setDisconnectTarget({
									appId: row.provider.appId,
									providerName: row.connectionInstanceId
										? `${friendlyProviderName(row.provider)} · ${accountDisplayLabel(row)}`
										: friendlyProviderName(row.provider),
									tokenScope: row.scope,
									connectionInstanceId: row.connectionInstanceId,
								});
							}}
							onBind={(row, reference) => {
								if (!row.connectionInstanceId || !canBindPersonalAccounts)
									return;
								bindMutation.mutate({
									appId: reference.appId,
									providerId: row.provider.appId,
									connectionInstanceId: row.connectionInstanceId,
								});
							}}
							onSetAccessCheck={(row, checkEachPersonsAccess) => {
								if (!row.connectionInstanceId || !canManageRow(row)) return;
								accessCheckMutation.mutate({
									id: row.connectionInstanceId,
									checkEachPersonsAccess,
								});
							}}
							isSettingAccessCheck={accessCheckMutation.isPending}
							renderConsumerGrants={
								scope === "organization"
									? (row) => (
											<div className="grid gap-4">
												<ConnectionConsumerGrantsEditor
													providerId={row.provider.appId}
													connectionInstanceId={row.connectionInstanceId}
													accountLabel={accountDisplayLabel(row)}
													canManage={canManageConnections}
												/>
												<ConnectionResourceLimitsEditor
													row={row}
													canManage={canManageConnections}
												/>
											</div>
										)
									: undefined
							}
							serviceHealth={serviceHealthByProvider}
							onCheckService={handleCheckService}
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
						<DialogTitle>
							{pendingConnect?.reconnect ? "Reconnect" : "Connect"}{" "}
							{pendingConnect
								? friendlyProviderName(pendingConnect.provider)
								: null}
							{pendingConnect?.reconnect ? "?" : null}
						</DialogTitle>
						<DialogDescription>
							{pendingConnect?.reconnect
								? pendingConnect.provider.connectionType === "api_key"
									? "You will enter a new key. It replaces the current key right away, and every app that uses it switches to the new key."
									: "You will sign in again. The new sign-in replaces the current one right away. If you sign in as a different account, apps use that account from then on."
								: pendingConnect?.scope === "tenant"
									? "Apps in this organization will use this account."
									: "Only you will be able to use this account."}{" "}
							{pendingConnect?.provider.connectionType === "api_key"
								? "Nothing changes until you save the key."
								: "Nothing changes until you finish with the provider."}
						</DialogDescription>
					</DialogHeader>
					{pendingConnect && (
						<ConnectionToolSummary
							providerName={friendlyProviderName(pendingConnect.provider)}
							capabilities={pendingConnect.toolCapabilities}
							safetyNote
						/>
					)}
					{pendingConnect?.requestedScopes?.length ? (
						<Collapsible>
							<CollapsibleDefaultTrigger className="w-fit">
								Details
							</CollapsibleDefaultTrigger>
							<CollapsibleDefaultContent>
								<Text role="label" tone="secondary" className="pt-2">
									OAuth scopes: {pendingConnect.requestedScopes.join(", ")}
								</Text>
							</CollapsibleDefaultContent>
						</Collapsible>
					) : null}
					{!canConfirmConnect && (
						<Alert>
							<AlertTitle>Setup requires permission</AlertTitle>
							<AlertDescription>
								Ask an organization admin to manage this connection or grant you
								access. Your connection has not changed.
							</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setPendingConnect(null)}>
							Cancel
						</Button>
						<Button
							disabled={!canConfirmConnect}
							onClick={() => {
								const target = pendingConnect;
								if (!target) return;
								setPendingConnect(null);
								handleConnect(
									target.provider.appId,
									target.provider.connectionType,
									target.scope,
									target.connectionInstanceId,
									target.requestedScopes,
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
				error={disconnectMutation.error}
				onCancel={() => setDisconnectTarget(null)}
				onConfirm={(target) => {
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

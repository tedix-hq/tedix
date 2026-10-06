/**
 * One provider row on /admin/connections: status, scope badges, and the
 * connect/disconnect affordances.
 */

import type {
	ConnectionProvider,
	ConnectionInventoryRow,
	UserConnection,
} from "@tedix/api-contract/schemas/connections";
import { CaretDown, Key, Plugs, Pulse } from "@phosphor-icons/react";
import { useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { cn } from "@/components/kumo/cn";
import { Text } from "@/components/kumo/text";
import {
	groupConsentPermissions,
	normalizeConsentPermissions,
	type ConsentPermission,
} from "@/shared/consent-permissions";

function GrantedPermissionSummary({
	permissions,
}: {
	permissions: readonly ConsentPermission[];
}) {
	return (
		<span className="flex flex-wrap gap-1" aria-label="Granted permissions">
			{groupConsentPermissions(permissions).map((group) => (
				<Badge
					key={group.name}
					variant={group.highRisk ? "destructive" : "outline"}
					title={group.permissions
						.map((permission) => permission.name)
						.join(", ")}
				>
					{group.name} · {group.permissions.length}
				</Badge>
			))}
		</span>
	);
}

export function usableLogoUrl(logoUrl: string | null): string | null {
	if (!logoUrl) return null;
	const trimmed = logoUrl.trim();
	if (trimmed.startsWith("data:image/")) return trimmed;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? parsed.toString()
			: null;
	} catch {
		return null;
	}
}

export interface ConnectionListItemProps {
	provider: ConnectionProvider;
	inventory?: ConnectionInventoryRow;
	connections: UserConnection[];
	onConnect: (
		appId: string,
		connectionType: "oauth" | "api_key",
		tokenScope?: "tenant" | "user",
	) => void;
	isConnecting: boolean;
	onDisconnect: (appId: string, tokenScope: "tenant" | "user") => void;
	isDisconnecting: boolean;
	disconnectingKey: { appId: string } | null;
	/** Which scope section this item is rendered in */
	sectionScope?: "tenant" | "user";
	/**
	 * Whether the caller may actually connect or disconnect.
	 *
	 * Connecting and disconnecting call `storeApiKey` and `disconnectProvider`,
	 * both guarded on `integrations:manage`, while the page itself only needs
	 * `apps:read`. Members and viewers can therefore open this list and could
	 * previously click controls the API refuses. Required, not defaulted, so a
	 * new call site has to answer the question.
	 */
	canManage: boolean;
	/** Why this specific provider and scope cannot be changed by the caller. */
	manageDeniedReason: string;
	serviceHealth?: {
		status: "checking" | "healthy" | "unhealthy" | "error";
		detail: string;
		appSlug: string;
		toolCount: number | null;
		checkedAt?: string;
	};
	onCheckService: (providerId: string, appSlug: string) => void;
}

export function connectionServiceSummary(
	serviceHealth: ConnectionListItemProps["serviceHealth"],
): string {
	if (!serviceHealth) return "MCP service not checked";
	if (serviceHealth.status === "checking") return "Checking MCP service…";
	if (serviceHealth.status === "error") {
		return `MCP check unavailable${serviceHealth.checkedAt ? ` · Checked ${new Date(serviceHealth.checkedAt).toLocaleString()}` : ""}`;
	}
	const status =
		serviceHealth.status === "healthy" ? "MCP healthy" : "MCP service issue";
	const inventory =
		serviceHealth.toolCount == null
			? "tool inventory unavailable"
			: `${serviceHealth.toolCount.toLocaleString()} live ${serviceHealth.toolCount === 1 ? "tool" : "tools"}`;
	return `${status} · ${inventory}${serviceHealth.checkedAt ? ` · Checked ${new Date(serviceHealth.checkedAt).toLocaleString()}` : ""}`;
}

export function ConnectionListItem({
	provider,
	inventory,
	connections,
	onConnect,
	isConnecting,
	onDisconnect,
	isDisconnecting,
	disconnectingKey,
	sectionScope,
	canManage,
	manageDeniedReason,
	serviceHealth,
	onCheckService,
}: ConnectionListItemProps) {
	const [expanded, setExpanded] = useState(false);

	const hasConnections = connections.length > 0;
	const isApiKey = provider.connectionType === "api_key";
	const logoUrl = usableLogoUrl(provider.logoUrl);
	const hasExpired = connections.some((c) => c.status === "expired");
	const accountUnknown = inventory?.accountState === "unknown";
	const accountRestricted = inventory?.accountState === "restricted";
	const primaryStatus =
		accountUnknown || accountRestricted
			? "unknown"
			: hasConnections
				? hasExpired
					? "expired"
					: "connected"
				: "none";
	const scopeGroups = provider.credentialProfile?.scopeGroups ?? [];
	const serviceSlugs = [
		...new Set(
			inventory?.references.map((reference) => reference.appSlug) ?? [],
		),
	].sort();

	const handleRowClick = () => {
		if (hasConnections) {
			setExpanded((prev) => !prev);
		}
	};

	const handleActionClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (hasConnections) {
			setExpanded((prev) => !prev);
		} else {
			onConnect(provider.appId, provider.connectionType, sectionScope);
		}
	};

	return (
		<Collapsible open={expanded} onOpenChange={setExpanded}>
			{/* Collapsed row */}
			<CollapsibleTrigger
				render={<div />}
				nativeButton={false}
				className={cn(
					"grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-3 py-3 sm:flex sm:flex-nowrap sm:gap-3 sm:px-4",
					hasConnections && "cursor-pointer hover:bg-kumo-tint",
				)}
				onClick={handleRowClick}
			>
				<div
					data-slot="connection-provider-summary"
					className="col-span-2 flex min-w-0 items-center gap-3 sm:col-span-1 sm:flex-1"
				>
					{/* Logo */}
					{logoUrl ? (
						<img
							src={logoUrl}
							alt={provider.name}
							className="h-8 w-8 shrink-0 rounded"
						/>
					) : (
						<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-kumo-fill">
							{isApiKey ? (
								<Key className="h-4 w-4 text-kumo-subtle" />
							) : (
								<Plugs className="h-4 w-4 text-kumo-subtle" />
							)}
						</div>
					)}

					{/* Name + description */}
					<div className="min-w-0 flex-1">
						<Text role="body" weight="medium" truncate>
							{provider.name}
						</Text>
						{inventory && (
							<Text role="label" tone="secondary">
								{inventory.references.length
									? `Referenced by ${[...new Set(inventory.references.map((ref) => ref.appSlug))].join(", ")}`
									: inventory.referencesComplete
										? "No app references in this organization"
										: "App references unknown"}{" "}
								· {connectionServiceSummary(serviceHealth)}
							</Text>
						)}
						{provider.description && (
							<Text role="label" tone="secondary" truncate>
								{provider.description}
							</Text>
						)}
					</div>
				</div>

				<div
					data-slot="connection-row-badges"
					className="col-start-1 flex min-w-0 flex-wrap gap-2 pl-11 sm:order-none sm:basis-auto sm:pl-0"
				>
					{/* Cross-org marker: a personal credential is not owned by the
				    workspace it happens to be rendered in — it follows the user
				    into every org. Without this badge it reads as a connection
				    belonging to the tenant. */}
					{sectionScope === "user" && hasConnections && (
						<Badge
							variant="outline"
							className="shrink-0"
							title="This credential belongs to you, not to this workspace. It is visible in every organization you view."
						>
							Personal · all workspaces
						</Badge>
					)}

					{/* Type badge */}
					<Badge variant="outline" className="shrink-0">
						{isApiKey ? "API key" : "OAuth"}
					</Badge>

					{/* Status indicator */}
					<Badge
						className="shrink-0"
						variant={
							primaryStatus === "connected"
								? "success"
								: primaryStatus === "expired"
									? "destructive"
									: "secondary"
						}
					>
						{primaryStatus === "connected" && "Connected"}
						{primaryStatus === "expired" && "Expired"}
						{primaryStatus === "none" && "Not connected"}
						{primaryStatus === "unknown" && "Could not verify"}
					</Badge>

					{/* Key count */}
					{connections.length > 1 && (
						<Text as="span" role="label" tone="secondary" className="shrink-0">
							{connections.length} keys
						</Text>
					)}
				</div>

				<div
					data-slot="connection-row-actions"
					className="col-start-2 row-start-2 flex shrink-0 items-center justify-end gap-2"
					role="group"
					aria-label={`Actions for ${provider.name}`}
				>
					{/* Action button */}
					<Button
						size="sm"
						variant={hasConnections ? "outline" : "default"}
						onClick={handleActionClick}
						disabled={
							accountUnknown || isConnecting || (!canManage && !hasConnections)
						}
						loading={isConnecting}
						title={
							!canManage && !hasConnections ? manageDeniedReason : undefined
						}
						className="shrink-0 max-sm:min-h-11"
					>
						{hasConnections
							? "Manage"
							: accountRestricted
								? "Reconnect"
								: "Connect"}
					</Button>

					{/* Chevron */}
					{hasConnections && (
						<CaretDown
							aria-hidden="true"
							className={cn(
								"h-4 w-4 shrink-0 text-kumo-subtle transition-transform",
								expanded && "rotate-180",
							)}
						/>
					)}
				</div>
			</CollapsibleTrigger>

			{/* Expanded details */}
			<CollapsibleContent>
				<div className="mx-3 rounded-lg bg-kumo-tint p-3 sm:ml-12">
					<div className="space-y-2">
						{connections.map((connection, idx) => {
							const isExpired = connection.status === "expired";
							const isThisDisconnecting =
								isDisconnecting && disconnectingKey?.appId === provider.appId;

							return (
								<div
									key={`${connection.tokenScope ?? "tenant"}-${idx}`}
									className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="flex items-center gap-2">
										<Text as="span" role="label" tone="secondary">
											{connection.tokenScope === "user"
												? "Personal credential"
												: "Organization credential"}
										</Text>
										{connection.tokenScope === "user" &&
											connection.connectedByEmail && (
												<Text as="span" role="label" tone="secondary">
													{connection.connectedByEmail}
												</Text>
											)}
										{connection.scopes.length > 0 && (
											<GrantedPermissionSummary
												permissions={normalizeConsentPermissions(
													connection.scopes,
													scopeGroups,
												)}
											/>
										)}
										{isExpired && <Badge variant="destructive">Expired</Badge>}
									</div>
									<Button
										size="xs"
										variant="ghost"
										className="self-start text-kumo-danger max-sm:min-h-11 sm:self-auto"
										onClick={() => {
											onDisconnect(provider.appId, connection.tokenScope);
										}}
										disabled={isThisDisconnecting || !canManage}
										loading={isThisDisconnecting}
										title={canManage ? undefined : manageDeniedReason}
									>
										Disconnect
									</Button>
								</div>
							);
						})}
					</div>

					{/* Add/Reconnect action */}
					<div className="mt-3 flex flex-wrap items-center gap-2 border-t border-kumo-line pt-3">
						<Button
							size="sm"
							variant="outline"
							className="max-sm:min-h-11"
							onClick={(e) => {
								e.stopPropagation();
								onConnect(
									provider.appId,
									provider.connectionType,
									sectionScope,
								);
							}}
							disabled={isConnecting || !canManage}
							loading={isConnecting}
							title={canManage ? undefined : manageDeniedReason}
						>
							Reconnect
						</Button>
						{serviceSlugs.map((appSlug) => (
							<Button
								key={appSlug}
								size="sm"
								variant="outline"
								className="max-sm:min-h-11"
								onClick={() => onCheckService(provider.appId, appSlug)}
								loading={
									serviceHealth?.status === "checking" &&
									serviceHealth.appSlug === appSlug
								}
								disabled={serviceHealth?.status === "checking"}
							>
								<Pulse aria-hidden className="size-4" />
								{serviceSlugs.length === 1
									? "Check app service"
									: `Check ${appSlug}`}
							</Button>
						))}
						{isApiKey && (
							<Text as="span" role="label" tone="secondary">
								Use a separate connection for each additional project key.
							</Text>
						)}
						<Text as="span" role="label" tone="secondary">
							Completing reconnect replaces the live credential immediately.
							Tedix does not stage a second credential before cutover.
						</Text>
					</div>
					{serviceSlugs.length > 0 && (
						<div className="mt-2">
							{serviceHealth && serviceHealth.status !== "checking" && (
								<Badge
									variant={
										serviceHealth.status === "healthy"
											? "success"
											: "destructive"
									}
								>
									{serviceHealth.status === "healthy"
										? "App service available"
										: "App service issue"}
								</Badge>
							)}
							<Text role="label" tone="secondary">
								{serviceHealth?.detail ??
									"Checks the referenced app's MCP protocol service. It does not execute a provider API tool or prove credential usability, provider API health or effective access."}
							</Text>
							{serviceHealth?.checkedAt && (
								<Text role="label" tone="secondary">
									Checked {new Date(serviceHealth.checkedAt).toLocaleString()}
								</Text>
							)}
							{serviceHealth && serviceHealth.status !== "checking" && (
								<Text role="label" tone="secondary">
									{serviceHealth.toolCount == null
										? "Live tool inventory unavailable"
										: `${serviceHealth.toolCount.toLocaleString()} live ${serviceHealth.toolCount === 1 ? "tool" : "tools"} discovered`}
								</Text>
							)}
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

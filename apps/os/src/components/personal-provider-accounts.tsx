import type {
	ConnectionInventoryRow,
	ConnectionProvider,
} from "@tedix/api-contract/schemas/connections";
import { DotsThree, Plugs, Plus } from "@phosphor-icons/react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import {
	Collection,
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	usableLogoUrl,
	connectionServiceSummary,
	type ConnectionListItemProps,
} from "@/components/connection-list-item";
import { normalizeConsentPermissions } from "@/shared/consent-permissions";

/** Presentation names only: providers remain separate authorization boundaries. */
export function friendlyPersonalProviderName(
	provider: Pick<ConnectionProvider, "appId" | "name">,
): string {
	if (/^Microsoft Graph Calendar(?: OAuth)?$/i.test(provider.name))
		return "Outlook Calendar";
	if (/^Microsoft Graph Mail(?: OAuth)?$/i.test(provider.name))
		return "Outlook Mail";
	return provider.name.replace(/ OAuth$/i, "");
}

type ConnectionReference = ConnectionInventoryRow["references"][number];

export interface PersonalProviderAccountsProps {
	provider: ConnectionProvider;
	rows: ConnectionInventoryRow[];
	canManage: boolean;
	canBind: boolean;
	canAdd: boolean;
	isConnecting: boolean;
	isDisconnecting: boolean;
	isBinding: boolean;
	onConnect: (row: ConnectionInventoryRow) => void;
	onRename: (row: ConnectionInventoryRow) => void;
	onDisconnect: (row: ConnectionInventoryRow) => void;
	onAdd: (provider: ConnectionProvider) => void;
	onBind: (row: ConnectionInventoryRow, reference: ConnectionReference) => void;
	serviceHealth?: ConnectionListItemProps["serviceHealth"];
	onCheckService: (providerId: string, appSlug: string) => void;
}

function accountStatus(row: ConnectionInventoryRow): string {
	if (row.accountState === "unknown") return "Could not verify";
	if (row.accountState === "restricted") return "Verification unavailable";
	if (row.accountState === "expired" || row.connection?.status === "expired")
		return "Reconnect needed";
	if (row.connection?.status === "revoked") return "Disconnected";
	return row.accountState === "present" && row.connection
		? "Connected"
		: "Not connected";
}

export function PersonalProviderAccounts({
	provider,
	rows,
	canManage,
	canBind,
	canAdd,
	isConnecting,
	isDisconnecting,
	isBinding,
	onConnect,
	onRename,
	onDisconnect,
	onAdd,
	onBind,
	serviceHealth,
	onCheckService,
}: PersonalProviderAccountsProps) {
	const name = friendlyPersonalProviderName(provider);
	const logo = usableLogoUrl(provider.logoUrl);
	const personalRows = rows.filter(
		(row) => row.provider.appId === provider.appId,
	);
	return (
		<PageSection aria-label={`${name} accounts`}>
			<SectionHeader>
				<SectionHeading>
					<div className="flex items-center gap-3">
						{logo ? (
							<img src={logo} alt="" className="size-8 shrink-0 rounded" />
						) : (
							<Plugs aria-hidden className="size-8 shrink-0 text-kumo-subtle" />
						)}
						<SectionTitle>{name}</SectionTitle>
					</div>
				</SectionHeading>
			</SectionHeader>
			<Collection aria-label={`${name} connected accounts`}>
				{personalRows.map((row) => {
					const label = row.instanceLabel?.trim() || "Default account";
					const status = accountStatus(row);
					const uncertain =
						row.accountState === "unknown" || row.accountState === "restricted";
					const reconnect =
						Boolean(row.connection) ||
						uncertain ||
						row.accountState === "expired";
					const canReconnect =
						canManage &&
						!isConnecting &&
						(row.accountState !== "unknown" ||
							Boolean(row.connectionInstanceId));
					const canDisconnect =
						canManage &&
						!isDisconnecting &&
						Boolean(row.connection || row.connectionInstanceId);
					const permissions = normalizeConsentPermissions(
						row.connection?.scopes ?? [],
						provider.credentialProfile?.scopeGroups ?? [],
					);
					const slugs = [
						...new Set(row.references.map((reference) => reference.appSlug)),
					].sort();
					return (
						<li
							key={row.connectionInstanceId ?? "default"}
							className="px-4 py-3"
						>
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<Text weight="medium" className="break-words">
										{label}
									</Text>
									<Text role="label" tone="secondary">
										{row.scope === "tenant"
											? "Organization account"
											: "Personal account"}
									</Text>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<Badge
										variant={
											status === "Connected"
												? "success"
												: status === "Reconnect needed"
													? "destructive"
													: "secondary"
										}
									>
										{status}
									</Badge>
									{!row.connection && !reconnect && (
										<Button
											size="sm"
											className="max-sm:min-h-11"
											onClick={() => onConnect(row)}
											disabled={!canReconnect}
											loading={isConnecting}
										>
											Connect
										</Button>
									)}
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													size="icon"
													className="min-h-11 min-w-11"
													aria-label={`Manage ${name} ${label}`}
												/>
											}
										>
											<DotsThree aria-hidden className="size-5" />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											{row.connectionInstanceId && (
												<DropdownMenuItem
													disabled={!canManage}
													onClick={() => onRename(row)}
												>
													Rename
												</DropdownMenuItem>
											)}
											<DropdownMenuItem
												disabled={!canReconnect}
												onClick={() => onConnect(row)}
											>
												{reconnect ? "Reconnect" : "Connect"}
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												disabled={!canDisconnect}
												onClick={() => onDisconnect(row)}
											>
												Disconnect
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>
							{uncertain && (
								<Text role="label" tone="secondary" className="mt-2">
									Account verification is unavailable. This does not mean the
									provider is down.
								</Text>
							)}
							<Collapsible>
								<CollapsibleTrigger className="mt-2 min-h-11 text-kumo-subtle">
									Advanced details
								</CollapsibleTrigger>
								<CollapsibleContent>
									<div className="space-y-3 pt-2">
										<Text role="label" tone="secondary">
											{row.scope === "tenant"
												? "Shared with this organization."
												: "Only you can use this account."}
										</Text>
										{row.connection?.connectedByEmail && (
											<Text role="label" tone="secondary">
												Connected by {row.connection.connectedByEmail} (Tedix
												user)
											</Text>
										)}
										{permissions.length > 0 && (
											<Text role="label" tone="secondary">
												Granted permissions:{" "}
												{permissions
													.map((permission) => permission.name)
													.join(", ")}
											</Text>
										)}
										<Text role="label" tone="secondary">
											{slugs.length
												? `Referenced by ${slugs.join(", ")}`
												: row.referencesComplete
													? "No app references in this organization"
													: "App references could not be verified"}
										</Text>
										{row.connectionInstanceId &&
											canBind &&
											(row.bindingTargets ?? []).map((reference) => {
												const selected = row.references.some(
													(bound) => bound.appId === reference.appId,
												);
												return (
													<Button
														key={reference.appId}
														size="sm"
														variant="outline"
														className="max-sm:min-h-11"
														disabled={
															isBinding ||
															row.accountState !== "present" ||
															selected
														}
														onClick={() => onBind(row, reference)}
													>
														{selected ? "Selected for" : "Use for"}{" "}
														{reference.appSlug}
													</Button>
												);
											})}
										<Text role="label" tone="secondary">
											{connectionServiceSummary(serviceHealth)}
										</Text>
										<div className="flex flex-wrap gap-2">
											{slugs.map((slug) => (
												<Button
													key={slug}
													size="sm"
													variant="outline"
													className="max-sm:min-h-11"
													disabled={serviceHealth?.status === "checking"}
													onClick={() => onCheckService(provider.appId, slug)}
												>
													Check {slug}
												</Button>
											))}
										</div>
										<Text role="label" tone="secondary">
											{serviceHealth?.detail ??
												"Checks the app's MCP service, not provider API access or account usability."}
										</Text>
										<Text role="label" tone="secondary">
											Reconnect replaces this account's credential immediately.
											Use a new account for a different sign-in.
										</Text>
									</div>
								</CollapsibleContent>
							</Collapsible>
						</li>
					);
				})}
				{canAdd && (
					<li className="px-4 py-2">
						<Button
							variant="ghost"
							className="min-h-11"
							disabled={!canManage || isConnecting}
							onClick={() => onAdd(provider)}
						>
							<Plus aria-hidden className="size-4" />
							Connect another account
						</Button>
					</li>
				)}
			</Collection>
		</PageSection>
	);
}

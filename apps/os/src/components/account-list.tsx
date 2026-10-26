/**
 * The one account list behind Organization connections (/admin/connections)
 * and My accounts (/account/connections). Both pages render the same row
 * anatomy and status words; only the owner differs.
 *
 * A row is one app's accounts. Closed, it shows the app and one status.
 * Opened, it says who can use it and lists each account with Reconnect and
 * Disconnect. Which apps use it, when it was last checked, permissions and
 * identifiers stay behind one "Details" disclosure.
 */

import type {
	ConnectionInventoryRow,
	ConnectionProvider,
} from "@tedix/api-contract/schemas/connections";
import { connectionAccountMode } from "@tedix/api-contract/utils/connection-account-mode";
import { CaretDown, Key, Plugs, Plus } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/kumo/button";
import { cn } from "@/components/kumo/cn";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import { Collection, PageSection } from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { normalizeConsentPermissions } from "@/shared/consent-permissions";
import { ConnectionToolSummary } from "@/components/connection-tool-summary";

type Reference = ConnectionInventoryRow["references"][number];
export type AccountOwner = "organization" | "personal";

export type ServiceHealth = {
	status: "checking" | "healthy" | "unhealthy" | "error";
	detail: string;
	appSlug: string;
	toolCount: number | null;
	checkedAt?: string;
};

export type AccountStatus =
	| { kind: "connected"; label: string }
	| {
			kind: "attention";
			label: string;
			reason: string;
			action: "connect" | "reconnect";
	  }
	| { kind: "available"; label: string; action: "connect" };

/** Presentation names only: providers remain separate authorization boundaries. */
export function friendlyProviderName(
	provider: Pick<ConnectionProvider, "appId" | "name">,
): string {
	if (/^Microsoft Graph Calendar(?: OAuth)?$/i.test(provider.name))
		return "Outlook Calendar";
	if (/^Microsoft Graph Mail(?: OAuth)?$/i.test(provider.name))
		return "Outlook Mail";
	if (/^Google Gmail(?: OAuth)?$/i.test(provider.name)) return "Gmail";
	return provider.name.replace(/ OAuth$/i, "");
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

/** A readable fallback when the API sent no app name: never the raw slug. */
export function humanizeAppSlug(slug: string): string {
	const words = slug
		.replace(/-[0-9a-f]{8,}$/i, "")
		.replace(/-tedix$/i, "")
		.split(/[-_]+/)
		.filter(Boolean);
	const text = words.join(" ");
	return text ? text[0]!.toUpperCase() + text.slice(1) : slug;
}

/** Distinct apps by id, with human names. */
export function appNames(references: readonly Reference[]): string[] {
	const byId = new Map<string, string>();
	for (const reference of references)
		if (!byId.has(reference.appId))
			byId.set(
				reference.appId,
				reference.appName?.trim() || humanizeAppSlug(reference.appSlug),
			);
	return [...new Set(byId.values())].sort((a, b) => a.localeCompare(b));
}

function missingPermissions(row: ConnectionInventoryRow) {
	return (row.capabilities ?? []).filter(
		(capability) =>
			capability.verified &&
			(capability.state === "not_configured" ||
				capability.state === "needs_reauth"),
	);
}

/**
 * One status per account. A failed status read is "Needs attention", never
 * "Not connected": a provider that refused the read is not proof of absence.
 */
export function accountStatus(row: ConnectionInventoryRow): AccountStatus {
	const attention = (
		reason: string,
		action: "connect" | "reconnect" = "reconnect",
	): AccountStatus => ({
		kind: "attention",
		label: `Needs attention: ${reason}`,
		reason,
		action,
	});
	const isApiKey = row.provider.connectionType === "api_key";
	if (row.accountState === "unknown")
		return attention("Couldn't check this account");
	if (row.accountState === "restricted")
		return attention("Provider didn't allow a status check");
	if (row.accountState === "expired" || row.connection?.status === "expired")
		return attention(isApiKey ? "Key stopped working" : "Sign-in expired");
	if (row.connection?.status === "reconnect_needed")
		return attention("Sign in again to keep it working");
	if (row.connection?.status === "revoked")
		return attention("Access removed at the provider");
	if (row.accountState === "present" && row.connection) {
		const missing = missingPermissions(row);
		if (missing.length)
			return attention(
				missing.length === 1 && missing[0]!.id === "access"
					? "Some permissions missing"
					: `Missing permission for ${missing.map((item) => item.label).join(", ")}`,
			);
		return { kind: "connected", label: "Connected" };
	}
	// A named slot whose sign-in was never finished is an account the person
	// started; it belongs with the accounts, not with the catalog.
	if (row.connectionInstanceId)
		return attention("Sign-in not finished", "connect");
	return { kind: "available", label: "Not connected", action: "connect" };
}

export type AccountGroup = {
	provider: ConnectionProvider;
	accounts: ConnectionInventoryRow[];
	status: AccountStatus;
};

export function accountLabel(row: ConnectionInventoryRow): string {
	return row.instanceLabel?.trim() || "Default account";
}

/** Group by provider, attention first, then connected; unconnected apps last. */
export function groupAccounts(
	rows: readonly ConnectionInventoryRow[],
): AccountGroup[] {
	const byProvider = new Map<string, ConnectionInventoryRow[]>();
	for (const row of rows) {
		const list = byProvider.get(row.provider.appId) ?? [];
		list.push(row);
		byProvider.set(row.provider.appId, list);
	}
	const rank = { attention: 0, connected: 1, available: 2 } as const;
	return [...byProvider.values()]
		.map((list) => {
			const used = list.filter(
				(row) => accountStatus(row).kind !== "available",
			);
			const accounts = used.length ? used : list.slice(0, 1);
			const statuses = accounts.map(accountStatus);
			const needing = statuses.filter((status) => status.kind === "attention");
			const status: AccountStatus =
				needing.length === 0
					? statuses.some((status) => status.kind === "connected")
						? { kind: "connected", label: "Connected" }
						: statuses[0]!
					: accounts.length === 1
						? needing[0]!
						: needing.length === 1 && needing[0]!.kind === "attention"
							? {
									...needing[0]!,
									label: `Needs attention: ${accountLabel(accounts[statuses.indexOf(needing[0]!)]!)}: ${needing[0]!.reason}`,
								}
							: {
									kind: "attention",
									reason: `${needing.length} of ${accounts.length} accounts`,
									label: `Needs attention: ${needing.length} of ${accounts.length} accounts`,
									action: "reconnect",
								};
			return { provider: list[0]!.provider, accounts, status };
		})
		.sort(
			(a, b) =>
				rank[a.status.kind] - rank[b.status.kind] ||
				friendlyProviderName(a.provider).localeCompare(
					friendlyProviderName(b.provider),
				),
		);
}

export function connectionServiceSummary(
	serviceHealth: ServiceHealth | undefined,
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

function formatChecked(iso: string | undefined): string | null {
	if (!iso) return null;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function listNames(names: readonly string[], max = 3): string {
	if (names.length <= max) return names.join(", ");
	return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export interface AccountListProps {
	owner: AccountOwner;
	groups: AccountGroup[];
	/** When the inventory was read; the result of each row's last check. */
	checkedAt?: string;
	isChecking: boolean;
	onCheck: () => void;
	canManage: (row: ConnectionInventoryRow) => boolean;
	deniedReason: (row: ConnectionInventoryRow) => string;
	canAdd: (provider: ConnectionProvider) => boolean;
	canBind: boolean;
	isConnecting: boolean;
	isDisconnecting: boolean;
	isBinding: boolean;
	onConnect: (row: ConnectionInventoryRow) => void;
	onReconnect: (row: ConnectionInventoryRow) => void;
	onDisconnect: (row: ConnectionInventoryRow) => void;
	onRename: (row: ConnectionInventoryRow) => void;
	onAdd: (provider: ConnectionProvider) => void;
	onAccountModeChange?: (
		provider: ConnectionProvider,
		accountMode: "single" | "multiple",
	) => void;
	isAccountModePending?: boolean;
	onBind: (row: ConnectionInventoryRow, reference: Reference) => void;
	/** Org admin override; null returns the account to its provider default. */
	onSetAccessCheck?: (
		row: ConnectionInventoryRow,
		checkEachPersonsAccess: boolean | null,
	) => void;
	isSettingAccessCheck?: boolean;
	serviceHealth: Record<string, ServiceHealth | undefined>;
	onCheckService: (providerId: string, appSlug: string) => void;
	/** Open "Available to connect" without a click (search, filters, empty list). */
	availableOpen?: boolean;
}

export function AccountList(props: AccountListProps) {
	const active = props.groups.filter(
		(group) => group.status.kind !== "available",
	);
	const available = props.groups.filter(
		(group) => group.status.kind === "available",
	);
	const [showAvailable, setShowAvailable] = useState(false);
	const availableOpen =
		showAvailable || props.availableOpen || active.length === 0;
	return (
		<>
			{active.length > 0 && (
				<PageSection aria-label="Connected accounts">
					<Collection aria-label="Connected accounts">
						{active.map((group) => (
							<AccountGroupRow
								key={group.provider.appId}
								{...props}
								group={group}
							/>
						))}
					</Collection>
				</PageSection>
			)}
			{available.length > 0 && (
				<PageSection aria-label="Available to connect">
					<Collapsible open={availableOpen} onOpenChange={setShowAvailable}>
						<CollapsibleTrigger className="-ms-2">
							<CaretDown
								aria-hidden
								className={cn(
									"size-3.5 transition-transform motion-reduce:transition-none",
									!availableOpen && "-rotate-90",
								)}
							/>
							Available to connect
							<span className="text-kumo-subtle tabular-nums">
								{available.length}
							</span>
						</CollapsibleTrigger>
						<CollapsibleContent>
							<Collection aria-label="Available to connect" className="mt-2">
								{available.map((group) => (
									<AvailableRow
										key={group.provider.appId}
										{...props}
										group={group}
									/>
								))}
							</Collection>
						</CollapsibleContent>
					</Collapsible>
				</PageSection>
			)}
		</>
	);
}

function ProviderLogo({ provider }: { provider: ConnectionProvider }) {
	const logo = usableLogoUrl(provider.logoUrl);
	return logo ? (
		<img
			src={logo}
			alt=""
			className="size-8 shrink-0 rounded-md border border-kumo-hairline bg-kumo-base object-contain p-1"
		/>
	) : (
		<span
			aria-hidden
			className="flex size-8 shrink-0 items-center justify-center rounded-md bg-kumo-fill text-kumo-subtle"
		>
			{provider.connectionType === "api_key" ? (
				<Key className="size-4" />
			) : (
				<Plugs className="size-4" />
			)}
		</span>
	);
}

export function StatusLine({ status }: { status: AccountStatus }) {
	return (
		<span
			data-account-status={status.kind}
			className="flex min-w-0 items-start gap-1.5 text-kumo-default type-tedix-label"
		>
			<span
				aria-hidden
				className={cn(
					"mt-[0.4em] size-1.75 shrink-0 rounded-full",
					status.kind === "connected"
						? "bg-kumo-success"
						: status.kind === "attention"
							? "bg-kumo-badge-orange"
							: "bg-kumo-fill ring-1 ring-kumo-line",
				)}
			/>
			<span className="min-w-0 break-words">{status.label}</span>
		</span>
	);
}

function usedByLine(group: AccountGroup): string {
	const references = group.accounts.flatMap((row) => row.references);
	const names = appNames(references);
	if (names.length) return `Used by ${listNames(names)}`;
	return group.accounts.every((row) => row.referencesComplete)
		? "Not used by any app yet"
		: "Apps using it could not be loaded";
}

function PrimaryAction({
	row,
	status,
	props,
}: {
	row: ConnectionInventoryRow;
	status: AccountStatus;
	props: AccountListProps;
}) {
	if (status.kind === "connected") return null;
	const allowed = props.canManage(row);
	const label = status.action === "connect" ? "Connect" : "Reconnect";
	return (
		<Button
			size="sm"
			variant={status.kind === "available" ? "outline" : "default"}
			className="shrink-0 max-sm:min-h-11"
			disabled={!allowed || props.isConnecting}
			title={allowed ? undefined : props.deniedReason(row)}
			onClick={() =>
				status.action === "connect"
					? props.onConnect(row)
					: props.onReconnect(row)
			}
		>
			{label}
		</Button>
	);
}

function AvailableRow({
	group,
	...props
}: AccountListProps & { group: AccountGroup }) {
	const name = friendlyProviderName(group.provider);
	const row = group.accounts[0]!;
	return (
		<li
			data-account-group={group.provider.appId}
			className="flex items-center gap-3 px-4 py-2.5"
		>
			<ProviderLogo provider={group.provider} />
			<div className="min-w-0 flex-1">
				<Text weight="medium" className="break-words">
					{name}
				</Text>
				<Text role="label" tone="secondary" className="break-words">
					{usedByLine(group)}
				</Text>
			</div>
			<PrimaryAction row={row} status={group.status} props={props} />
		</li>
	);
}

function AccountGroupRow({
	group,
	...props
}: AccountListProps & { group: AccountGroup }) {
	const [open, setOpen] = useState(false);
	const { provider, accounts, status } = group;
	const name = friendlyProviderName(provider);
	const single = accounts.length === 1 ? accounts[0]! : null;
	return (
		<li data-account-group={provider.appId}>
			<Collapsible open={open} onOpenChange={setOpen}>
				<div className="flex items-center gap-2 pe-4">
					<CollapsibleTrigger
						className="flex min-w-0 flex-1 items-center gap-3 rounded-none py-3 ps-4 pe-2 text-kumo-default hover:bg-transparent hover:text-kumo-default"
						aria-label={`${name} details`}
					>
						<ProviderLogo provider={provider} />
						<span className="grid min-w-0 flex-1 gap-0.5">
							<Text as="span" weight="medium" className="break-words">
								{name}
							</Text>
							<StatusLine status={status} />
						</span>
						<CaretDown
							aria-hidden
							className={cn(
								"size-4 shrink-0 text-kumo-subtle transition-transform motion-reduce:transition-none",
								open && "rotate-180",
							)}
						/>
					</CollapsibleTrigger>
					{single && !open && (
						<PrimaryAction row={single} status={status} props={props} />
					)}
				</div>
				<CollapsibleContent>
					<AccountDetails group={group} props={props} />
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

function AccountLine({
	row,
	name,
	props,
}: {
	row: ConnectionInventoryRow;
	name: string;
	props: AccountListProps;
}) {
	const status = accountStatus(row);
	const label = accountLabel(row);
	const allowed = props.canManage(row);
	const reconnect =
		status.kind === "connected" ||
		(status.kind === "attention" && status.action === "reconnect");
	const connectedBy =
		props.owner === "organization" ? row.connection?.connectedByEmail : null;
	return (
		<li
			data-account-row={row.connectionInstanceId ?? "default"}
			className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2"
		>
			<div className="min-w-0 flex-1 basis-40">
				<Text weight="medium" className="break-words">
					{label}
				</Text>
				{status.kind !== "connected" ? (
					<StatusLine status={status} />
				) : connectedBy ? (
					<Text role="label" tone="secondary" className="break-words">
						Connected by {connectedBy}
					</Text>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button
					size="sm"
					variant={status.kind === "connected" ? "outline" : "default"}
					className="max-sm:min-h-11"
					aria-label={`${reconnect ? "Reconnect" : "Connect"} ${name} ${label}`}
					disabled={!allowed || props.isConnecting}
					title={allowed ? undefined : props.deniedReason(row)}
					onClick={() =>
						reconnect ? props.onReconnect(row) : props.onConnect(row)
					}
				>
					{reconnect ? "Reconnect" : "Connect"}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="text-kumo-danger max-sm:min-h-11"
					aria-label={`Disconnect ${name} ${label}`}
					disabled={
						!allowed ||
						props.isDisconnecting ||
						!(row.connection || row.connectionInstanceId)
					}
					title={allowed ? undefined : props.deniedReason(row)}
					onClick={() => props.onDisconnect(row)}
				>
					Disconnect
				</Button>
			</div>
		</li>
	);
}

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
	return (
		<div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
			<dt className="text-kumo-subtle type-tedix-label">{term}</dt>
			<dd className="m-0 min-w-0 break-words text-kumo-default type-tedix-body">
				{children}
			</dd>
		</div>
	);
}

function permissionState(
	capability: ConnectionInventoryRow["capabilities"][number],
): string {
	if (!capability.verified) return "Couldn't check";
	if (capability.state === "connected") return "Granted";
	if (capability.state === "needs_reauth") return "Sign in again";
	if (capability.state === "not_supported") return "Not available here";
	return "Not granted";
}

/**
 * The opened row: who can use it, each account with Reconnect and Disconnect,
 * and Add account. Everything else waits behind one "Details" disclosure.
 */
function AccountDetails({
	group,
	props,
}: {
	group: AccountGroup;
	props: AccountListProps;
}) {
	const { provider, accounts } = group;
	const name = friendlyProviderName(provider);
	const mode = connectionAccountMode(provider);
	return (
		<div className="grid gap-2 px-4 pb-4 sm:ps-15">
			<Text role="label" tone="secondary">
				{props.owner === "organization"
					? "Everyone in this organization can use it through its apps."
					: "Only you can use it."}
			</Text>
			<ul aria-label={`${name} accounts`} className="m-0 grid list-none p-0">
				{accounts.map((row) => (
					<AccountLine
						key={row.connectionInstanceId ?? "default"}
						row={row}
						name={name}
						props={props}
					/>
				))}
			</ul>
			{mode.mode === "multiple" && props.canAdd(provider) && (
				<Button
					variant="ghost"
					size="sm"
					// Pull the ghost padding back so the icon sits on the text edge.
					className="-ms-2 w-fit max-sm:min-h-11"
					disabled={props.isConnecting}
					onClick={() => props.onAdd(provider)}
				>
					<Plus aria-hidden className="size-4" />
					Add account
				</Button>
			)}
			{hasMissingPermissions(accounts) && (
				<dl className="m-0 grid">
					<DetailRow term="Permissions">
						<PermissionList capabilities={accounts[0]!.capabilities ?? []} />
					</DetailRow>
				</dl>
			)}
			<MoreDetails group={group} props={props} />
		</div>
	);
}

/** Missing permissions are the row's fix, so they stay out of Details. */
function hasMissingPermissions(accounts: readonly ConnectionInventoryRow[]) {
	return accounts.length === 1 && missingPermissions(accounts[0]!).length > 0;
}

function PermissionList({
	capabilities,
}: {
	capabilities: ConnectionInventoryRow["capabilities"];
}) {
	return (
		<ul className="m-0 grid list-none gap-1 p-0">
			{capabilities.map((capability) => (
				<li
					key={capability.id}
					data-connection-capability={capability.id}
					className="flex flex-wrap items-center gap-x-2"
				>
					<span>{capability.label}</span>
					<span className="text-kumo-subtle">
						{permissionState(capability)}
					</span>
					{(capability.state === "not_configured" ||
						capability.state === "needs_reauth") && (
						<Link
							href={capability.setupUrl}
							aria-label={`Set up ${capability.label}`}
							className="inline-flex min-h-8 items-center max-sm:min-h-11"
						>
							Grant access
						</Link>
					)}
				</li>
			))}
		</ul>
	);
}

function MoreDetails({
	group,
	props,
}: {
	group: AccountGroup;
	props: AccountListProps;
}) {
	const [open, setOpen] = useState(false);
	const { provider, accounts, status } = group;
	const name = friendlyProviderName(provider);
	const mode = connectionAccountMode(provider);
	const multiple = accounts.length > 1;
	const single = accounts[0]!;
	const names = appNames(accounts.flatMap((row) => row.references));
	const capabilities = multiple ? [] : (single.capabilities ?? []);
	const showPermissions =
		capabilities.length > 1 ||
		(capabilities.length === 1 && capabilities[0]!.id !== "access");
	const allowed = props.canManage(single);
	const checked = formatChecked(props.checkedAt);
	const bindable = props.canBind
		? accounts.filter(
				(row) => row.connectionInstanceId && row.bindingTargets?.length,
			)
		: [];
	const renamable = accounts.filter((row) => row.connectionInstanceId);
	const accessChecked = accounts.filter((row) => row.accessCheck);
	const health = props.serviceHealth[provider.appId];
	const slugs = [
		...new Set(
			accounts.flatMap((row) => row.references.map((ref) => ref.appSlug)),
		),
	].sort();
	const permissions = [
		...new Set(
			accounts.flatMap((row) =>
				normalizeConsentPermissions(
					row.connection?.scopes ?? [],
					provider.credentialProfile?.scopeGroups ?? [],
				).map((permission) => permission.name),
			),
		),
	];
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="-ms-2 w-fit">
				<CaretDown
					aria-hidden
					className={cn(
						"size-3.5 transition-transform motion-reduce:transition-none",
						!open && "-rotate-90",
					)}
				/>
				Details
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="grid gap-4 pt-2">
					<ConnectionToolSummary
						providerName={name}
						capabilities={accounts.flatMap((row) => row.toolCapabilities ?? [])}
					/>
					<dl className="m-0 grid gap-3">
						<DetailRow term="Last checked">
							<div className="flex flex-wrap items-center gap-2">
								<span>
									{checked
										? `${checked} · ${status.kind === "attention" ? status.reason : "Working"}`
										: "Not checked yet"}
								</span>
								<Button
									size="sm"
									variant="outline"
									className="max-sm:min-h-11"
									loading={props.isChecking}
									disabled={props.isChecking}
									onClick={props.onCheck}
								>
									Check now
								</Button>
							</div>
						</DetailRow>
						<DetailRow term="Used by">
							{names.length ? names.join(", ") : usedByLine(group)}
						</DetailRow>
						<DetailRow term="Accounts">
							{props.owner === "organization" &&
							props.onAccountModeChange &&
							provider.availableAccountModes.length > 1 ? (
								<div className="grid gap-1.5">
									<Select
										disabled={!allowed || props.isAccountModePending}
										value={mode.mode}
										onValueChange={(value) => {
											if (!value || value === mode.mode) return;
											props.onAccountModeChange?.(
												provider,
												value as "single" | "multiple",
											);
										}}
									>
										<SelectTrigger aria-label={`Accounts allowed for ${name}`}>
											<SelectValue>
												{mode.mode === "single"
													? "One account"
													: "Several accounts"}
											</SelectValue>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="single">One account</SelectItem>
											<SelectItem value="multiple">Several accounts</SelectItem>
										</SelectContent>
									</Select>
									<span>{mode.reason}</span>
								</div>
							) : (
								<>
									{mode.mode === "single"
										? "One account. "
										: "Multiple accounts. "}
									{mode.reason}
								</>
							)}
						</DetailRow>
						{renamable.length > 0 && (
							<DetailRow term="Account names">
								<div className="flex flex-wrap gap-2">
									{renamable.map((row) => (
										<Button
											key={row.connectionInstanceId}
											size="sm"
											variant="outline"
											className="max-sm:min-h-11"
											disabled={!props.canManage(row)}
											onClick={() => props.onRename(row)}
										>
											Rename {accountLabel(row)}
										</Button>
									))}
								</div>
							</DetailRow>
						)}
						{showPermissions && !hasMissingPermissions(accounts) && (
							<DetailRow term="Permissions">
								<PermissionList capabilities={capabilities} />
							</DetailRow>
						)}
						{accessChecked.length > 0 && (
							<DetailRow term="Check each person's access">
								<div className="grid gap-2">
									<span className="text-kumo-subtle">
										When on, an app shows something read through this account
										only if the reader's own {name} account can open it too.
									</span>
									{accessChecked.map((row) => {
										const check = row.accessCheck!;
										const manageable = props.canManage(row);
										return (
											<div
												key={row.connectionInstanceId}
												className="flex flex-wrap items-center gap-2"
												data-access-check={
													check.checkEachPersonsAccess ? "on" : "off"
												}
											>
												<span>
													{multiple ? `${accountLabel(row)}: ` : ""}
													{check.checkEachPersonsAccess ? "On" : "Off"}
													<span className="text-kumo-subtle">
														{check.source === "admin"
															? " · set by an admin"
															: ` · default for ${name}`}
													</span>
												</span>
												<Button
													size="sm"
													variant="outline"
													className="max-sm:min-h-11"
													disabled={!manageable || props.isSettingAccessCheck}
													title={
														manageable ? undefined : props.deniedReason(row)
													}
													onClick={() =>
														props.onSetAccessCheck?.(
															row,
															!check.checkEachPersonsAccess,
														)
													}
												>
													{check.checkEachPersonsAccess
														? "Turn off"
														: "Turn on"}
												</Button>
												{check.source === "admin" && (
													<Button
														size="sm"
														variant="ghost"
														className="max-sm:min-h-11"
														disabled={!manageable || props.isSettingAccessCheck}
														onClick={() => props.onSetAccessCheck?.(row, null)}
													>
														Use default
													</Button>
												)}
											</div>
										);
									})}
								</div>
							</DetailRow>
						)}
						{bindable.length > 0 && (
							<DetailRow term="Which account apps use">
								<div className="grid gap-2">
									{bindable.map((row) => (
										<div
											key={row.connectionInstanceId}
											className="flex flex-wrap items-center gap-2"
										>
											<span>{accountLabel(row)}:</span>
											{(row.bindingTargets ?? []).map((reference) => {
												const selected = row.references.some(
													(bound) => bound.appId === reference.appId,
												);
												const appName = appNames([reference])[0];
												return (
													<Button
														key={reference.appId}
														size="sm"
														variant="outline"
														className="max-sm:min-h-11"
														disabled={
															props.isBinding ||
															row.accountState !== "present" ||
															selected
														}
														onClick={() => props.onBind(row, reference)}
													>
														{selected ? "Used for" : "Use for"} {appName}
													</Button>
												);
											})}
										</div>
									))}
								</div>
							</DetailRow>
						)}
						<DetailRow term="Sign-in method">
							{provider.connectionType === "api_key"
								? "API key"
								: `OAuth${provider.registrationMode ? ` (${provider.registrationMode})` : ""}`}
						</DetailRow>
						{provider.description && (
							<DetailRow term="Provider note">{provider.description}</DetailRow>
						)}
						{permissions.length > 0 && (
							<DetailRow term="Granted scopes">
								{permissions.join(", ")}
							</DetailRow>
						)}
						<DetailRow term="Provider ID">
							<code className="type-tedix-label">{provider.appId}</code>
						</DetailRow>
						{renamable.length > 0 && (
							<DetailRow term="Account IDs">
								{renamable
									.map(
										(row) =>
											`${accountLabel(row)}: ${row.connectionInstanceId}`,
									)
									.join(", ")}
							</DetailRow>
						)}
						{slugs.length > 0 && (
							<DetailRow term="App identifiers">
								<span
									data-connection-app-identifiers
									className="block min-w-0 [overflow-wrap:anywhere]"
								>
									{slugs.join(", ")}
								</span>
							</DetailRow>
						)}
						{slugs.length > 0 && (
							<DetailRow term="App service">
								<div
									data-connection-service-health
									className="grid min-w-0 gap-2 [overflow-wrap:anywhere]"
								>
									<span>{connectionServiceSummary(health)}</span>
									<div className="flex flex-wrap gap-2">
										{slugs.map((slug) => (
											<Button
												key={slug}
												size="sm"
												variant="outline"
												className="max-w-full whitespace-normal [overflow-wrap:anywhere] max-sm:min-h-11"
												loading={
													health?.status === "checking" &&
													health.appSlug === slug
												}
												disabled={health?.status === "checking"}
												onClick={() =>
													props.onCheckService(provider.appId, slug)
												}
											>
												{slugs.length === 1
													? "Check app service"
													: `Check ${slug}`}
											</Button>
										))}
									</div>
									<span className="text-kumo-subtle type-tedix-label">
										{health?.detail ??
											"Checks the app's MCP service. It does not test the account or the provider's API."}
									</span>
								</div>
							</DetailRow>
						)}
					</dl>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

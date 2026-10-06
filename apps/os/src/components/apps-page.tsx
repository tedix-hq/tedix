import { CapabilityNavigation } from "@/components/capability-navigation";
import type {
	EligibilityBadge,
	EligibilityResult,
} from "@tedix/api-contract/schemas/app-gating";
import type { AppListItem } from "@tedix/api-contract/schemas/app";
import type { UserConnection } from "@tedix/api-contract/schemas/connections";
import type { ConnectionInventoryRow } from "@tedix/api-contract/schemas/connections";
import {
	AppWindow,
	MagnifyingGlass,
	Plugs,
	Pulse,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getOsSurface } from "@/lib/os-navigation";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { IconFrame } from "@/components/kumo/icon-frame";
import {
	Collection,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	PageToolbar,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { SearchInput } from "@/components/kumo/search-input";
import {
	DisconnectConnectionDialog,
	type DisconnectConnectionTarget,
} from "@/components/connections-disconnect-dialog";
import { ListSkeleton } from "@/components/list-skeleton";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Text } from "@/components/kumo/text";
import {
	CONNECTIONS_MANAGE_DENIED_REASON,
	effectiveConnectionScope,
	PERSONAL_OAUTH_MANAGE_DENIED_REASON,
	startOauthConnect,
	useCanManageConnections,
	useCanManagePersonalOauthConnections,
	useConnectionCompleteListener,
	useDisconnectConnection,
} from "@/lib/connections-actions";
import {
	appListQueryOptions,
	appGatewayMembershipsQueryOptions,
	connectionProvidersQueryOptions,
	connectionsOverviewQueryOptions,
	installedAppEligibilityQueryOptions,
	userConnectionsQueryOptions,
} from "@/lib/os-query-options";
import { formatCount, sentenceCase } from "@/lib/format";
import type { AppsSearch } from "@/lib/apps-search";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type ChipTone = "neutral" | "active" | "blocked" | "done" | "warn";

export type AppServiceCheck = {
	status: "checking" | "passed" | "failed" | "error";
	checkedAt?: string;
	toolCount: number | null;
	detail: string;
};

export function completedServiceCheck(result: {
	allPassed: boolean;
	passCount: number;
	failCount: number;
	toolCount: number | null;
}): AppServiceCheck {
	return {
		status: result.allPassed ? "passed" : "failed",
		checkedAt: new Date().toISOString(),
		toolCount: result.toolCount,
		detail: result.allPassed
			? `${result.passCount} protocol checks passed.`
			: `${result.failCount} of ${result.passCount + result.failCount} protocol checks failed.`,
	};
}

/** Apps have no enabled boolean — visibility "disabled" is the off state. */
export function visibilityTone(
	visibility: AppListItem["visibility"],
): ChipTone {
	switch (visibility) {
		case "public":
			return "done";
		case "private":
			return "active";
		case "disabled":
			return "blocked";
		default:
			return "neutral";
	}
}

export function visibilityLabel(visibility: AppListItem["visibility"]): string {
	return visibility ?? "unknown";
}

export const BADGE_LABELS: Record<EligibilityBadge, string> = {
	ready: "governance ready",
	setup_needed: "setup needed",
	plan_upgrade: "plan upgrade",
};

export function badgeTone(badge: EligibilityBadge): ChipTone {
	return badge === "ready" ? "done" : "warn";
}

/**
 * No contract field carries the MCP URL on list rows; the platform convention
 * is `{slug}.mcp.tedix.dev`, with customMcpDomain overriding when set.
 */
export function appMcpHost(app: AppListItem): string {
	return app.customMcpDomain ?? `${app.slug}.mcp.tedix.dev`;
}

export function filterInstalledApps(
	apps: readonly AppListItem[],
	query: string,
): AppListItem[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [...apps];
	return apps.filter((app) => {
		const text = [
			app.name,
			app.slug,
			app.domain,
			app.description,
			appMcpHost(app),
		]
			.filter(Boolean)
			.join(" ")
			.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	});
}

/**
 * Tool counts from the batch eligibility read (one call for every installed
 * app) — availableTools plus gated unavailableTools is the honest total.
 */
export function toolCountLabel(result: EligibilityResult): string {
	const available = result.availableTools.length;
	const gated = result.unavailableTools.length;
	const total = available + gated;
	if (total === 0) return "tool count unavailable";
	const label = `${total} ${total === 1 ? "tool" : "tools"}`;
	return gated > 0 ? `${label} · ${gated} gated` : label;
}

export function connectionTone(status: UserConnection["status"]): ChipTone {
	switch (status) {
		case "connected":
			return "done";
		case "expired":
			return "warn";
		case "revoked":
			return "blocked";
	}
}

export function grantedScopesLabel(connection: UserConnection): string {
	const count = connection.scopes.length;
	return `${count} granted ${count === 1 ? "scope" : "scopes"}`;
}

export function connectionFailureMessage(localEvaluation: boolean): string {
	return localEvaluation
		? "Production OAuth connections and grants are intentionally absent from this isolated local environment."
		: "Connection grants are unavailable right now. Apps remain governed by their grants; this view simply cannot display them.";
}

export type AppStatus = { label: string; tone: ChipTone };

export function appConnectionStatus(
	rows: readonly ConnectionInventoryRow[],
	loaded: boolean,
): AppStatus {
	if (!loaded) return { label: "Unavailable", tone: "neutral" };
	if (
		rows.some(
			(row) =>
				["missing", "expired", "restricted"].includes(row.accountState) ||
				row.connection?.status === "expired" ||
				row.connection?.status === "revoked",
		)
	)
		return { label: "Needs setup", tone: "warn" };
	if (
		rows.some(
			(row) =>
				row.accountState === "present" &&
				row.connection?.status === "connected",
		)
	)
		return { label: "Connected", tone: "done" };
	return {
		label: rows.length > 0 ? "Not evaluated" : "Not listed",
		tone: "neutral",
	};
}

export function appGatewayStatus(
	state?: "gateway" | "enabled" | "disabled" | "unavailable",
): AppStatus {
	switch (state) {
		case "gateway":
			return { label: "Unified gateway", tone: "active" };
		case "enabled":
			return { label: "Included", tone: "done" };
		case "disabled":
			return { label: "Not included", tone: "neutral" };
		case "unavailable":
			return { label: "No gateway", tone: "neutral" };
		default:
			return { label: "Unavailable", tone: "neutral" };
	}
}

export function appServiceStatus(check?: AppServiceCheck): AppStatus {
	switch (check?.status) {
		case "checking":
			return { label: "Checking", tone: "active" };
		case "passed":
			return { label: "Passed", tone: "done" };
		case "failed":
			return { label: "Issue found", tone: "warn" };
		case "error":
			return { label: "Check unavailable", tone: "neutral" };
		default:
			return { label: "Not checked", tone: "neutral" };
	}
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Governance-chip tones as tinted Kumo Badge variants — intent stays in the
 * tint, not solid brand color, per the design brief's accent discipline.
 */
const CHIP_VARIANTS: Record<ChipTone, BadgeVariant> = {
	neutral: "outline",
	active: "info",
	blocked: "destructive",
	done: "success",
	warn: "warning",
};

export function AppChip({
	tone,
	children,
}: {
	tone: ChipTone;
	children: ReactNode;
}) {
	// Sentence-case is applied by callers (string labels run through
	// sentenceCase) — no CSS `capitalize`, which title-cases every word.
	return (
		<Badge variant={CHIP_VARIANTS[tone]} data-tone={tone}>
			{children}
		</Badge>
	);
}

export function AppRowMain({
	app,
	eligibility,
}: {
	app: AppListItem;
	eligibility?: { badge: EligibilityBadge; result: EligibilityResult };
}) {
	return (
		<span className="grid min-w-0 gap-1">
			<span className="flex flex-wrap items-center gap-1.5">
				<Text
					as="strong"
					weight="medium"
					truncate
					className="tracking-[-0.2px]"
				>
					{app.name}
				</Text>
				<AppChip tone={visibilityTone(app.visibility)}>
					{sentenceCase(visibilityLabel(app.visibility))}
				</AppChip>
				{eligibility ? (
					<AppChip tone={badgeTone(eligibility.badge)}>
						{sentenceCase(BADGE_LABELS[eligibility.badge])}
					</AppChip>
				) : null}
			</span>
			<Text as="span" role="caption" tone="secondary" truncate>
				{app.slug} · {appMcpHost(app)}
			</Text>
			{eligibility ? (
				<Text as="span" role="caption" tone="secondary">
					{toolCountLabel(eligibility.result)} in governance inventory
				</Text>
			) : null}
			{app.description ? (
				<Text
					as="span"
					role="label"
					tone="secondary"
					truncate
					className="tracking-[-0.1px] max-sm:hidden"
				>
					{app.description}
				</Text>
			) : null}
		</span>
	);
}

function AppStatusField({
	label,
	status,
}: {
	label: string;
	status: AppStatus;
}) {
	return (
		<div className="grid gap-1">
			<Text as="span" role="caption" tone="secondary">
				{label}
			</Text>
			<AppChip tone={status.tone}>{status.label}</AppChip>
		</div>
	);
}

function AppServiceDetail({ check }: { check?: AppServiceCheck }) {
	if (!check) return null;
	return (
		<Text
			as="p"
			role="caption"
			tone="secondary"
			className="m-0 max-w-56 whitespace-normal"
		>
			{check.detail} Provider API health and credential usability were not
			tested.
			{check.toolCount != null
				? ` ${check.toolCount} live ${check.toolCount === 1 ? "tool" : "tools"}.`
				: ""}
		</Text>
	);
}

function AppActions({
	app,
	check,
	onCheck,
}: {
	app: AppListItem;
	check?: AppServiceCheck;
	onCheck: () => void;
}) {
	const checking = check?.status === "checking";
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				size="sm"
				variant="outline"
				aria-label={`${checking ? "Checking" : "Check"} MCP service for ${app.name}`}
				disabled={checking}
				onClick={onCheck}
			>
				<Pulse size={15} aria-hidden /> {checking ? "Checking…" : "Check MCP"}
			</Button>
			<Button
				size="sm"
				variant="secondary"
				aria-label={`Open ${app.name}`}
				render={<Link to="/apps/$appId" params={{ appId: app.id }} />}
			>
				Open
			</Button>
		</div>
	);
}

export function AppsEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<AppWindow size={20} />
				</EmptyMedia>
				<EmptyTitle>No apps yet</EmptyTitle>
				<EmptyDescription>
					MCP apps are provisioned through the Tedix CLI, a tedi, or the App
					Store — the same config-driven apps render here.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function ConnectionRow({
	connection,
	action,
}: {
	connection: UserConnection;
	/** Optional trailing affordances (reconnect/disconnect) on manage surfaces. */
	action?: ReactNode;
}) {
	return (
		<li className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-2.5">
			<IconFrame>
				<Plugs size={18} />
			</IconFrame>
			<span className="grid min-w-0 flex-1 gap-1">
				<span className="flex flex-wrap items-center gap-1.5">
					<AppChip tone={connectionTone(connection.status)}>
						{sentenceCase(connection.status)}
					</AppChip>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="tracking-[-0.1px]"
					>
						{connection.tokenScope === "tenant"
							? "org-shared credential"
							: "personal credential"}
					</Text>
				</span>
				<Text
					as="strong"
					weight="medium"
					truncate
					className="tracking-[-0.2px]"
				>
					{connection.providerName}
				</Text>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="tracking-[-0.1px]"
				>
					{grantedScopesLabel(connection)}
					{connection.connectedByEmail
						? ` · connected by ${connection.connectedByEmail}`
						: ""}
				</Text>
			</span>
			{action ? (
				<span className="flex shrink-0 items-center gap-1.5">{action}</span>
			) : null}
		</li>
	);
}

export function ConnectionsEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Plugs size={20} />
				</EmptyMedia>
				<EmptyTitle>No connections granted yet</EmptyTitle>
				<EmptyDescription>
					Apps that need an OAuth provider will show as setup needed until one
					is connected.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const APPS_LIMIT = 50;
const APPS_VISIBLE_PAGE_SIZE = 15;
const CONNECTIONS_LIMIT = 20;

export function ConnectionsPanel({
	catalogAction = false,
	contextNote,
	manage = false,
}: {
	/**
	 * Offer the canonical provider catalog from a contextual surface such as a
	 * Workspace. The catalog owns consent and credential scope; this panel never
	 * fabricates a resource binding or copies a token into the current document.
	 */
	catalogAction?: boolean;
	contextNote?: string;
	/**
	 * Render the connect/disconnect affordances (Apps page). The Canvas rail
	 * mount stays read-only. The flows come from `@/lib/connections-actions`,
	 * shared with /connections so the two surfaces cannot drift.
	 */
	manage?: boolean;
}) {
	const connections = useQuery({
		...userConnectionsQueryOptions(),
		staleTime: 60_000,
	});
	// Provider metadata (connection type, supported scopes) backs the
	// reconnect affordance; read only on the manage surface.
	const providers = useQuery({
		...connectionProvidersQueryOptions(),
		staleTime: 60_000,
		enabled: manage,
	});
	const canManageOrganizationConnections = useCanManageConnections();
	const canManagePersonalOauthConnections =
		useCanManagePersonalOauthConnections();
	useConnectionCompleteListener();
	const [disconnectTarget, setDisconnectTarget] =
		useState<DisconnectConnectionTarget | null>(null);
	const disconnectMutation = useDisconnectConnection({
		onSuccess: () => setDisconnectTarget(null),
	});
	const shownConnections = (connections.data?.data ?? []).slice(
		0,
		CONNECTIONS_LIMIT,
	);

	const rowActions = (connection: UserConnection): ReactNode => {
		if (!manage) return null;
		const provider = providers.data?.data.find(
			(candidate) => candidate.appId === connection.appId,
		);
		const isPersonalOauth =
			connection.tokenScope === "user" && provider?.connectionType === "oauth";
		const canManage = isPersonalOauth
			? canManagePersonalOauthConnections
			: canManageOrganizationConnections;
		const manageDeniedReason = isPersonalOauth
			? PERSONAL_OAUTH_MANAGE_DENIED_REASON
			: CONNECTIONS_MANAGE_DENIED_REASON;
		return (
			<>
				{provider?.connectionType === "oauth" && (
					<Button
						size="sm"
						variant="outline"
						disabled={!canManage}
						title={canManage ? undefined : manageDeniedReason}
						onClick={() =>
							startOauthConnect({
								appId: connection.appId,
								effectiveScope: effectiveConnectionScope(
									provider,
									connection.tokenScope,
								),
								registrationMode: provider.registrationMode,
							})
						}
					>
						Reconnect
					</Button>
				)}
				<Button
					size="sm"
					variant="ghost"
					className="text-destructive hover:text-destructive"
					disabled={
						!canManage ||
						(disconnectMutation.isPending &&
							disconnectTarget?.appId === connection.appId)
					}
					title={canManage ? undefined : manageDeniedReason}
					onClick={() =>
						setDisconnectTarget({
							appId: connection.appId,
							providerName: connection.providerName,
							tokenScope: connection.tokenScope,
						})
					}
				>
					Disconnect
				</Button>
			</>
		);
	};
	const connectionRows = shownConnections.map((connection) => (
		<ConnectionRow
			key={`${connection.appId}:${connection.tokenScope}`}
			connection={connection}
			action={rowActions(connection)}
		/>
	));

	return (
		<div className="grid gap-3" data-connections-panel>
			{manage ? (
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Gateway connections</SectionTitle>
						<SectionDescription>
							Credentials currently available to installed apps.
						</SectionDescription>
					</SectionHeading>
					{connections.data ? (
						<Badge variant="outline">{shownConnections.length}</Badge>
					) : null}
				</SectionHeader>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<SectionEyebrow
						title="MCP gateway connections"
						count={connections.data ? shownConnections.length : undefined}
					/>
					{catalogAction ? (
						<Button
							render={
								<Link
									to="/account/connections"
									search={{ q: "", status: "all" }}
								/>
							}
							size="sm"
						>
							Connect app
						</Button>
					) : null}
				</div>
			)}
			{contextNote ? (
				<Text
					as="p"
					role="label"
					tone="secondary"
					className="m-0 rounded-lg border border-kumo-line bg-kumo-tint px-3 py-2"
				>
					{contextNote}
				</Text>
			) : null}
			{connections.isPending && <ListSkeleton rows={2} />}
			{connections.isError && (
				<Text as="p" role="body" tone="secondary" className="m-0">
					{connectionFailureMessage(Boolean(contextNote))}
				</Text>
			)}
			{manage && disconnectMutation.isError && (
				<Text as="p" role="body" tone="error" className="m-0">
					The disconnect failed:{" "}
					{(disconnectMutation.error as Error).message ||
						"the credential could not be removed."}
				</Text>
			)}
			{connections.data && shownConnections.length === 0 && (
				<ConnectionsEmpty />
			)}
			{connections.data && shownConnections.length > 0 && (
				<>
					{manage ? (
						<Collection aria-label="Gateway connections">
							{connectionRows}
						</Collection>
					) : (
						<ul className="m-0 grid list-none gap-1 p-0">{connectionRows}</ul>
					)}
					{connections.data.data.length > CONNECTIONS_LIMIT && (
						<Text role="body" tone="secondary" className="m-0">
							Showing the first {CONNECTIONS_LIMIT} of{" "}
							{formatCount(connections.data.data.length)} connections.
						</Text>
					)}
				</>
			)}
			{manage && (
				<Text as="p" role="body" tone="secondary" className="m-0">
					<Link
						className="text-kumo-default underline"
						to="/account/connections"
					>
						Manage all connections
					</Link>{" "}
					— connect your OAuth providers; organization admins can also govern
					shared credentials and API keys.
				</Text>
			)}
			{manage && (
				<DisconnectConnectionDialog
					target={disconnectTarget}
					isPending={disconnectMutation.isPending}
					onCancel={() => setDisconnectTarget(null)}
					onConfirm={(target) =>
						disconnectMutation.mutate({
							appId: target.appId,
							tokenScope: target.tokenScope,
						})
					}
				/>
			)}
		</div>
	);
}

export function AppsPage({
	search,
	onSearchChange,
}: {
	search: AppsSearch;
	onSearchChange: (query: string) => void;
}) {
	const surface = getOsSurface("gateways");
	const [visibleLimit, setVisibleLimit] = useState(APPS_VISIBLE_PAGE_SIZE);

	const apps = useQuery(appListQueryOptions(APPS_LIMIT));

	// One batch read ties every installed app to its required grants
	// (connectors/scopes/plan/entitlements) and per-tool availability.
	// Degrades gracefully: the app list renders without badges on failure.
	const eligibility = useQuery({
		...installedAppEligibilityQueryOptions(),
		staleTime: 60_000,
	});
	const gatewayMemberships = useQuery({
		...appGatewayMembershipsQueryOptions(),
		staleTime: 60_000,
	});
	const installedApps = useMemo(
		() =>
			(apps.data?.data ?? []).filter(
				(app) => app.id !== gatewayMemberships.data?.gateway?.id,
			),
		[apps.data, gatewayMemberships.data?.gateway?.id],
	);
	const organizationConnections = useQuery(
		connectionsOverviewQueryOptions({
			scope: "organization",
			q: "",
			status: "all",
			limit: 100,
			offset: 0,
		}),
	);
	const personalConnections = useQuery(
		connectionsOverviewQueryOptions({
			scope: "personal",
			q: "",
			status: "all",
			limit: 100,
			offset: 0,
		}),
	);
	const [serviceChecks, setServiceChecks] = useState<
		Record<string, AppServiceCheck>
	>({});
	const checkService = async (app: AppListItem) => {
		setServiceChecks((current) => ({
			...current,
			[app.id]: {
				status: "checking",
				toolCount: current[app.id]?.toolCount ?? null,
				detail: `Checking ${app.slug}'s MCP protocol service…`,
			},
		}));
		try {
			const result = await (
				await import("@/lib/api")
			).osDirectReadApi.mcpHealth.run({
				appSlug: app.slug,
				authStrategy: "auto",
				tasksExtension: "ignore",
			});
			setServiceChecks((current) => ({
				...current,
				[app.id]: completedServiceCheck(result),
			}));
		} catch (error) {
			setServiceChecks((current) => ({
				...current,
				[app.id]: {
					status: "error",
					checkedAt: new Date().toISOString(),
					toolCount: null,
					detail:
						error instanceof Error
							? error.message
							: "The MCP service check could not run.",
				},
			}));
		}
	};

	const eligibilityByAppId = useMemo(() => {
		const map: Record<
			string,
			{ badge: EligibilityBadge; result: EligibilityResult }
		> = {};
		for (const entry of eligibility.data ?? []) {
			map[entry.appId] = { badge: entry.badge, result: entry.result };
		}
		return map;
	}, [eligibility.data]);
	const gatewayMembershipByAppId = useMemo(
		() =>
			new Map(
				(gatewayMemberships.data?.memberships ?? []).map((membership) => [
					membership.appId,
					membership.enabled,
				]),
			),
		[gatewayMemberships.data],
	);
	const connectionRowsByApp = useMemo(() => {
		const map = new Map<string, ConnectionInventoryRow[]>();
		for (const row of [
			...(organizationConnections.data?.rows ?? []),
			...(personalConnections.data?.rows ?? []),
		]) {
			for (const reference of row.references) {
				for (const key of [reference.appId, reference.appSlug]) {
					map.set(key, [...(map.get(key) ?? []), row]);
				}
			}
		}
		return map;
	}, [organizationConnections.data, personalConnections.data]);
	const filteredApps = useMemo(
		() => filterInstalledApps(installedApps, search.q),
		[installedApps, search.q],
	);
	const displayedApps = filteredApps.slice(0, visibleLimit);
	const appRows = displayedApps.map((app) => {
		const connectionRows = Array.from(
			new Set([
				...(connectionRowsByApp.get(app.id) ?? []),
				...(connectionRowsByApp.get(app.slug) ?? []),
			]),
		);
		const gatewayState = gatewayMemberships.data
			? gatewayMemberships.data.gateway
				? gatewayMemberships.data.gateway.id === app.id
					? "gateway"
					: gatewayMembershipByAppId.get(app.id)
						? "enabled"
						: "disabled"
				: "unavailable"
			: undefined;
		return {
			app,
			connection: appConnectionStatus(
				connectionRows,
				Boolean(organizationConnections.data && personalConnections.data),
			),
			gateway: appGatewayStatus(gatewayState),
			service: appServiceStatus(serviceChecks[app.id]),
			check: serviceChecks[app.id],
		};
	});
	const changeSearch = (query: string) => {
		setVisibleLimit(APPS_VISIBLE_PAGE_SIZE);
		onSearchChange(query);
	};

	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>
						Apps installed for this organization. Accounts and tool permissions
						are managed separately.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<CapabilityNavigation active="installed" />

			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Installed apps</SectionTitle>
						<SectionDescription>
							Installation, account, gateway, governance, and health are
							separate states. Open an app to manage them.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{apps.data && installedApps.length > 0 ? (
					<>
						<PageToolbar>
							<SearchInput
								containerClassName="w-full sm:max-w-sm"
								aria-label="Search installed apps"
								placeholder="Search apps by name, purpose, or domain…"
								value={search.q}
								onChange={(event) => changeSearch(event.target.value)}
								trailing={
									<span
										aria-label={`${filteredApps.length} results`}
										className="tabular-nums text-kumo-inactive type-tedix-label"
									>
										{filteredApps.length}
									</span>
								}
							/>
						</PageToolbar>
						{apps.data.pagination.hasMore ? (
							<Text as="p" role="label" tone="secondary" className="m-0">
								Search covers the first {formatCount(installedApps.length)}{" "}
								loaded apps.
							</Text>
						) : null}
					</>
				) : null}
				{apps.isPending && <ListSkeleton />}
				{apps.isError && (
					<Alert variant="destructive">
						<AlertTitle>Apps are unavailable</AlertTitle>
						<AlertDescription>{(apps.error as Error).message}</AlertDescription>
					</Alert>
				)}
				{apps.data && installedApps.length === 0 && <AppsEmpty />}
				{apps.data && installedApps.length > 0 && filteredApps.length === 0 ? (
					<Empty appearance="quiet">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<MagnifyingGlass size={20} />
							</EmptyMedia>
							<EmptyTitle>No installed apps match this search</EmptyTitle>
							<EmptyDescription>
								{apps.data.pagination.hasMore
									? `No match among the first ${formatCount(installedApps.length)} loaded apps.`
									: "Try another app name, purpose, slug, or domain."}
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button variant="secondary" onClick={() => changeSearch("")}>
								Clear search
							</Button>
						</EmptyContent>
					</Empty>
				) : null}
				{apps.data && filteredApps.length > 0 && (
					<>
						<div className="hidden overflow-hidden rounded-xl border border-kumo-line sm:block">
							<Table scrollLabel="Installed apps">
								<TableHeader>
									<TableRow>
										<TableHead>App</TableHead>
										<TableHead>Connection</TableHead>
										<TableHead>Gateway</TableHead>
										<TableHead>MCP service</TableHead>
										<TableHead>Actions</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{appRows.map(
										({ app, connection, gateway, service, check }) => (
											<TableRow key={app.id} data-app-row="desktop">
												<TableCell className="min-w-60 max-w-80 whitespace-normal">
													<div className="flex min-w-0 items-start gap-3">
														<IconFrame aria-hidden>
															<AppWindow size={18} />
														</IconFrame>
														<AppRowMain
															app={app}
															eligibility={eligibilityByAppId[app.id]}
														/>
													</div>
												</TableCell>
												<TableCell>
													<AppChip tone={connection.tone}>
														{connection.label}
													</AppChip>
												</TableCell>
												<TableCell>
													<AppChip tone={gateway.tone}>{gateway.label}</AppChip>
												</TableCell>
												<TableCell className="min-w-40">
													<AppChip tone={service.tone}>{service.label}</AppChip>
													<AppServiceDetail check={check} />
												</TableCell>
												<TableCell>
													<AppActions
														app={app}
														check={check}
														onCheck={() => void checkService(app)}
													/>
												</TableCell>
											</TableRow>
										),
									)}
								</TableBody>
							</Table>
						</div>
						<Collection
							className="sm:hidden"
							aria-label="Installed apps mobile"
						>
							{appRows.map(({ app, connection, gateway, service, check }) => (
								<li
									key={app.id}
									data-app-row="mobile"
									className="grid gap-3 px-3 py-3"
								>
									<div className="flex min-w-0 items-start gap-3">
										<IconFrame aria-hidden>
											<AppWindow size={18} />
										</IconFrame>
										<AppRowMain
											app={app}
											eligibility={eligibilityByAppId[app.id]}
										/>
									</div>
									<div className="grid grid-cols-2 gap-3">
										<AppStatusField label="Connection" status={connection} />
										<AppStatusField label="Gateway" status={gateway} />
										<AppStatusField label="MCP service" status={service} />
									</div>
									<AppServiceDetail check={check} />
									<AppActions
										app={app}
										check={check}
										onCheck={() => void checkService(app)}
									/>
								</li>
							))}
						</Collection>
						{filteredApps.length > APPS_VISIBLE_PAGE_SIZE ? (
							<div
								aria-live="polite"
								className="flex flex-col items-center justify-between gap-2 sm:flex-row"
							>
								<Text as="p" role="label" tone="secondary">
									Showing {displayedApps.length} of {filteredApps.length}{" "}
									installed apps
								</Text>
								{displayedApps.length < filteredApps.length ? (
									<Button
										className="w-full sm:w-auto"
										onClick={() =>
											setVisibleLimit((limit) =>
												Math.min(
													limit + APPS_VISIBLE_PAGE_SIZE,
													filteredApps.length,
												),
											)
										}
										variant="outline"
									>
										Show more
									</Button>
								) : null}
							</div>
						) : null}
						{apps.data.pagination.hasMore && (
							<Text as="p" role="body" tone="secondary" className="m-0">
								Showing the first {formatCount(apps.data.data.length)} of{" "}
								{formatCount(apps.data.pagination.total)} apps.
							</Text>
						)}
					</>
				)}
				{eligibility.isError && apps.data && apps.data.data.length > 0 && (
					<Text role="body" tone="secondary" className="m-0">
						Grant status is unavailable right now — apps are listed without
						their governance badges.
					</Text>
				)}
			</PageSection>
		</Page>
	);
}

import {
	ArrowSquareOut,
	DotsThree,
	Eye,
	EyeSlash,
	MonitorPlay,
	Wrench,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink, useParams } from "@tanstack/react-router";
import type { App, AppTool } from "@tedix/api-contract/schemas/app";
import type { ConnectionInventoryRow } from "@tedix/api-contract/schemas/connections";
import type { ToolAnnotations } from "@tedix/api-contract/schemas/tools";
import type { ReactNode } from "react";
import { Component, useMemo, useState } from "react";
import { AppGatewayMembership } from "@/components/app-gateway-membership";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Card, CardContent } from "@/components/kumo/card";
import { Link } from "@/components/kumo/link";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	Collection,
	PageSection,
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { WidgetFrame } from "@/components/widget-frame";
import { sentenceCase } from "@/lib/format";
import {
	appAdaptersListQueryOptions,
	appAnalyticsRange,
	appDetailQueryOptions,
	appGatewayMembershipQueryOptions,
	appMetricsQueryOptions,
	connectionsOverviewQueryOptions,
	contentSourcesQueryOptions,
	installedAppEligibilityQueryOptions,
} from "@/lib/os-query-options";
import { osDirectReadApi } from "@/lib/api";
import { useCanManageApps } from "@/lib/app-permissions";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { resolveSurfaceTenant } from "@tedix/tenant-directory";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Default widget host origin. apps/mcp resolves
 * `app.metadata.mcpConfig.widgetDomain ?? env.MCP_UI_URL`
 * (apps/mcp/src/mcp/server-factory.ts); production MCP_UI_URL is
 * https://mcp-ui.tedix.dev (apps/mcp/wrangler.jsonc).
 */
export const DEFAULT_WIDGET_ORIGIN = "https://mcp-ui.tedix.dev";

/**
 * The preview URL embeds the layout spec in the query string; apps/mcp caps
 * the embeddable JSON at 8000 chars (preview-widget.ts).
 */
export const MAX_EMBEDDABLE_SPEC_CHARS = 8000;

export const DEFAULT_WIDGET_FRAME_HEIGHT = 420;

/**
 * Local evaluation uses the launcher's MCP port; Cloud and custom domains
 * keep their existing hostname. This is a connection target, not an OS route.
 */
export function mcpEndpointHost(
	app: Pick<App, "slug" | "customMcpDomain">,
	osHostname = typeof window === "undefined" ? "" : window.location.hostname,
): string {
	if (app.customMcpDomain) return app.customMcpDomain;
	if (
		resolveSurfaceTenant(osHostname, { expectedSurface: "os" }).kind === "local"
	) {
		return `${app.slug}.localhost:3000`;
	}
	return app.customMcpDomain ?? `${app.slug}.mcp.tedix.dev`;
}

export function mcpEndpointUrl(
	app: Pick<App, "slug" | "customMcpDomain">,
	osHostname = typeof window === "undefined" ? "" : window.location.hostname,
): string {
	const host = mcpEndpointHost(app, osHostname);
	return `${host.endsWith(".localhost:3000") ? "http" : "https"}://${host}/mcp`;
}

export function widgetOrigin(app: App): string {
	const domain = app.metadata?.mcpConfig?.widgetDomain;
	return typeof domain === "string" && domain.length > 0
		? domain
		: DEFAULT_WIDGET_ORIGIN;
}

/**
 * Durable layout spec on the tool row (config.layoutSpec, object or JSON
 * string). Mirrors apps/mcp/src/mcp/utils/render-widget.ts getToolLayoutSpec.
 */
export function getToolLayoutSpec(
	tool: AppTool,
): Record<string, unknown> | null {
	const config = isRecord(tool.config) ? tool.config : null;
	const layoutSpec = config?.layoutSpec;
	if (isRecord(layoutSpec)) return layoutSpec;
	if (typeof layoutSpec === "string") {
		try {
			const parsed: unknown = JSON.parse(layoutSpec);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Malformed stored spec — treat as no spec; the MCP edge does the same.
		}
	}
	return null;
}

/**
 * The renderable-widget predicate — mirrors isRenderWidgetTool
 * (apps/mcp/src/mcp/utils/render-widget.ts).
 */
export function isWidgetTool(tool: AppTool): boolean {
	return tool.widgetKey === "render" || getToolLayoutSpec(tool) !== null;
}

/** Mirrors getToolLayoutId: config.layoutId falls back to the tool name. */
export function getToolLayoutId(tool: AppTool): string {
	const config = isRecord(tool.config) ? tool.config : null;
	const layoutId = config?.layoutId;
	return typeof layoutId === "string" && layoutId.trim().length > 0
		? layoutId
		: tool.toolId;
}

/**
 * The MCP Apps resource identifier the host bridge reads via resources/read
 * (apps/mcp/src/mcp/utils/register-widget.ts buildResourceUris).
 */
export function widgetResourceUri(appSlug: string, tool: AppTool): string {
	return `ui://widgets/mcp-app/${appSlug}/r/${getToolLayoutId(tool)}.html`;
}

/** Anonymous preview URL with JSON encoded as UTF-8 bytes before base64.
 * Returns null when no client-readable spec exists or it exceeds the URL limit.
 */
export function buildWidgetPreviewUrl(
	origin: string,
	appSlug: string,
	tool: AppTool,
): string | null {
	const spec = getToolLayoutSpec(tool);
	if (!spec) return null;
	const specJson = JSON.stringify(spec);
	if (specJson.length > MAX_EMBEDDABLE_SPEC_CHARS) return null;
	let specBinary = "";
	for (const byte of new TextEncoder().encode(specJson)) {
		specBinary += String.fromCharCode(byte);
	}
	return `${origin}/${appSlug}/r/preview?spec=${encodeURIComponent(btoa(specBinary))}`;
}

/** Preferred frame height clamp per the MCP Apps host contract (160-900). */
export function clampWidgetFrameHeight(px: number): number {
	return Math.min(900, Math.max(160, Math.round(px)));
}

export interface ToolChipSpec {
	label: string;
	tone: "read" | "write" | "destructive" | "neutral";
}

/**
 * read/write/destructive chips derived from MCP tool annotations. Chips are
 * evidence-based: absent hints render nothing rather than guessed defaults.
 */
export function toolAnnotationChips(
	annotations: ToolAnnotations | null,
): ToolChipSpec[] {
	if (!annotations) return [];
	const chips: ToolChipSpec[] = [];
	if (annotations.readOnlyHint === true) {
		chips.push({ label: "read", tone: "read" });
	} else if (annotations.readOnlyHint === false) {
		chips.push(
			annotations.destructiveHint === true
				? { label: "destructive", tone: "destructive" }
				: { label: "write", tone: "write" },
		);
	} else if (annotations.destructiveHint === true) {
		chips.push({ label: "destructive", tone: "destructive" });
	}
	if (annotations.idempotentHint === true) {
		chips.push({ label: "idempotent", tone: "neutral" });
	}
	if (annotations.openWorldHint === true) {
		chips.push({ label: "open world", tone: "neutral" });
	}
	return chips;
}

export function toolChips(tool: AppTool): ToolChipSpec[] {
	const chips = toolAnnotationChips(tool.annotations);
	if (tool.authRequired) chips.push({ label: "auth", tone: "neutral" });
	if (isWidgetTool(tool)) chips.push({ label: "widget", tone: "neutral" });
	if (tool.enabled === false) {
		chips.push({ label: "disabled", tone: "neutral" });
	}
	return chips;
}

export function sortTools(tools: AppTool[]): AppTool[] {
	return [...tools].sort((a, b) => {
		const orderA = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
		const orderB = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
		if (orderA !== orderB) return orderA - orderB;
		return a.toolId.localeCompare(b.toolId);
	});
}

export const APP_OVERVIEW_TOOL_PREVIEW_LIMIT = 5;

/** Take a bounded preview after canonical sorting; Tools owns the full inventory. */
export function appOverviewToolPreview(tools: AppTool[]): AppTool[] {
	return tools.slice(0, APP_OVERVIEW_TOOL_PREVIEW_LIMIT);
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Annotation-chip tones as tinted Kumo Badge variants: read is informational,
 * write warns, destructive is danger, and evidence-free hints stay outlined.
 */
const TOOL_CHIP_VARIANTS: Record<ToolChipSpec["tone"], BadgeVariant> = {
	read: "info",
	write: "warning",
	destructive: "destructive",
	neutral: "outline",
};

export function ToolChip({ chip }: { chip: ToolChipSpec }) {
	return (
		<Badge variant={TOOL_CHIP_VARIANTS[chip.tone]} data-tone={chip.tone}>
			{sentenceCase(chip.label)}
		</Badge>
	);
}

/**
 * Direct iframe onto the widget host's anonymous preview route. Sandbox per
 * the MCP Apps host contract: allow-scripts WITHOUT allow-same-origin, so the
 * guest runs with an opaque origin and can never read OS cookies or DOM.
 * Widget HTML is never inlined into or proxied through the OS origin. The
 * containing Card supplies the brief's hairline panel treatment; the iframe
 * itself keeps its exact sandbox semantics.
 */
export function WidgetPreviewFrame({
	url,
	title,
	height = DEFAULT_WIDGET_FRAME_HEIGHT,
}: {
	url: string;
	title: string;
	height?: number;
}) {
	return (
		<Card size="sm" className="gap-0 overflow-hidden py-0">
			<iframe
				className="block w-full border-0"
				src={url}
				title={title}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				loading="lazy"
				style={{ height: `${clampWidgetFrameHeight(height)}px` }}
			/>
		</Card>
	);
}

/**
 * Honest degraded state for a ui:// widget whose live session-gated mount is
 * unavailable (the MCP Apps renderer failed and no anonymous preview exists).
 * Per the host contract, broken mounts degrade to a native panel that keeps
 * the structured evidence — here, the exact resource identifier — instead of
 * a blank loader shell (docs/mcp/apps.md, Ship Checklist 9-10).
 */
export function WidgetHostOnlyPanel({ resourceUri }: { resourceUri: string }) {
	return (
		<Card className="border-dashed">
			<CardContent className="flex items-start gap-4">
				<span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-kumo-hairline bg-kumo-elevated text-kumo-subtle">
					<MonitorPlay size={18} />
				</span>
				<div className="min-w-0">
					<Text
						as="strong"
						role="body"
						weight="medium"
						className="mt-0.5 block tracking-[-0.2px]"
					>
						Live widget rendering is unavailable
					</Text>
					<Text
						as="p"
						role="body"
						tone="secondary"
						className="mt-1.5 mb-0 max-w-xl leading-relaxed tracking-[-0.1px]"
					>
						The session-gated MCP Apps mount for this widget failed, so it is
						contained here without breaking the rest of the page. Resource:{" "}
						<Text
							as="code"
							role="label"
							className="inline-block break-all rounded-md border border-kumo-hairline bg-kumo-fill px-1.5 py-px"
						>
							{resourceUri}
						</Text>
					</Text>
				</div>
			</CardContent>
		</Card>
	);
}

interface WidgetFrameBoundaryProps {
	/** Rendered in place of the children after a renderer failure. */
	fallback: ReactNode;
	children: ReactNode;
}

interface WidgetFrameBoundaryState {
	failed: boolean;
}

/**
 * Per-widget containment per the MCP Apps host contract: a renderer failure
 * affects only its own mount (docs/mcp/apps.md, Host Architecture / Ship
 * Checklist 10). One broken widget degrades to its fallback while every other
 * row on the page stays healthy.
 */
export class WidgetFrameBoundary extends Component<
	WidgetFrameBoundaryProps,
	WidgetFrameBoundaryState
> {
	override state: WidgetFrameBoundaryState = { failed: false };

	static getDerivedStateFromError(): WidgetFrameBoundaryState {
		return { failed: true };
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

export function AppToolRow({
	tool,
	appSlug,
	widgetHostOrigin = DEFAULT_WIDGET_ORIGIN,
	defaultPreviewOpen = false,
	showDescription = true,
}: {
	tool: AppTool;
	appSlug: string;
	widgetHostOrigin?: string;
	/** Keep inventory rows descriptive; bounded overview previews stay scannable. */
	showDescription?: boolean;
	/**
	 * Initial expansion state. Rows stay collapsed by default; static test
	 * renders cannot click the toggle, so tests open the row through this.
	 */
	defaultPreviewOpen?: boolean;
}) {
	const [previewOpen, setPreviewOpen] = useState(defaultPreviewOpen);
	const widget = isWidgetTool(tool);
	const resourceUri = widget ? widgetResourceUri(appSlug, tool) : null;
	const previewUrl = widget
		? buildWidgetPreviewUrl(widgetHostOrigin, appSlug, tool)
		: null;
	const chips = toolChips(tool);
	return (
		<li className="flex flex-col gap-2.5 px-4 py-3 transition-colors duration-150 hover:bg-kumo-tint">
			<div className="flex items-start gap-3">
				<IconFrame>
					<Wrench size={18} />
				</IconFrame>
				<span className="grid min-w-0 flex-1 gap-1">
					<Text
						as="strong"
						role="body"
						weight="medium"
						tone="default"
						className="truncate tracking-[-0.2px]"
					>
						{tool.toolId}
					</Text>
					{tool.title && tool.title !== tool.toolId && (
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="tracking-[-0.1px]"
						>
							{tool.title}
						</Text>
					)}
					{showDescription && tool.description && (
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="hidden tracking-[-0.1px] sm:line-clamp-2"
						>
							{tool.description}
						</Text>
					)}
					{chips.length > 0 && (
						<span className="mt-0.5 flex flex-wrap items-center gap-1.5">
							{chips.map((chip) => (
								<ToolChip key={chip.label} chip={chip} />
							))}
						</span>
					)}
				</span>
				{widget && (
					<Button
						variant="outline"
						size="sm"
						className="ml-auto shrink-0"
						aria-expanded={previewOpen}
						onClick={() => setPreviewOpen((open) => !open)}
						icon={previewOpen ? <EyeSlash size={14} /> : <Eye size={14} />}
					>
						{previewOpen ? "Hide preview" : "Preview"}
					</Button>
				)}
			</div>
			{widget && previewOpen && resourceUri && (
				<div className="grid gap-2">
					{/*
					 * Primary path: the LIVE session-gated MCP Apps mount. WidgetFrame
					 * owns resources/read via /api/widgets/resource, the sandbox-proxy
					 * bridge, and /api/widgets/mcp proxying. If its renderer throws,
					 * containment degrades this row to the anonymous preview iframe when
					 * the spec is URL-embeddable, else the honest host-only panel.
					 */}
					<WidgetFrameBoundary
						fallback={
							previewUrl ? (
								<WidgetPreviewFrame
									url={previewUrl}
									title={`${tool.toolId} anonymous widget preview`}
								/>
							) : (
								<WidgetHostOnlyPanel resourceUri={resourceUri} />
							)
						}
					>
						<WidgetFrame
							appSlug={appSlug}
							resourceUri={resourceUri}
							title={`${tool.toolId} widget`}
						/>
					</WidgetFrameBoundary>
					{previewUrl && (
						<Button
							variant="link"
							size="xs"
							className="w-fit"
							icon={<ArrowSquareOut size={13} />}
							render={
								<a
									href={previewUrl}
									target="_blank"
									rel="noreferrer noopener"
								/>
							}
						>
							Open anonymous preview
						</Button>
					)}
				</div>
			)}
		</li>
	);
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

/** Compact navigation fact linking into the sub-route that owns the number. */
function OverviewStat({
	label,
	value,
	sub,
	to,
	appId,
}: {
	label: string;
	value: string;
	sub?: string;
	to:
		| "/apps/$appId/tools"
		| "/apps/$appId/content"
		| "/apps/$appId/analytics"
		| "/apps/$appId/evals";
	appId: string;
}) {
	return (
		<MetricItem
			className="relative transition-colors hover:bg-kumo-tint"
			emphasis="dialog"
			label={
				<Link
					variant="record"
					href={to.replace("$appId", appId)}
					className="after:absolute after:inset-0 after:content-['']"
				>
					{label}
				</Link>
			}
			value={value}
			description={sub}
		/>
	);
}

export function AppOverviewSummary({
	appId,
	tools,
	adapters,
	contentSources,
	sessions,
	successRate,
}: {
	appId: string;
	tools: { enabled: number; total: number };
	adapters: { enabled: number; total: number } | null;
	contentSources: number | null;
	sessions: number | null;
	successRate: number | null;
}) {
	return (
		<MetricGrid aria-label="App overview" columns={4}>
			<OverviewStat
				label="Tools"
				value={`${tools.enabled}/${tools.total}`}
				sub="enabled"
				to="/apps/$appId/tools"
				appId={appId}
			/>
			<OverviewStat
				label="Adapters"
				value={adapters ? `${adapters.enabled}/${adapters.total}` : "—"}
				sub="active"
				to="/apps/$appId/tools"
				appId={appId}
			/>
			<OverviewStat
				label="Content sources"
				value={contentSources == null ? "—" : String(contentSources)}
				sub="configured"
				to="/apps/$appId/content"
				appId={appId}
			/>
			<OverviewStat
				label="Sessions (30d)"
				value={sessions == null ? "—" : String(sessions)}
				sub={
					successRate == null
						? undefined
						: `${Math.round(successRate)}% success`
				}
				to="/apps/$appId/analytics"
				appId={appId}
			/>
		</MetricGrid>
	);
}

export function appConnectionRows(
	app: Pick<App, "id" | "slug" | "metadata">,
	rows: ConnectionInventoryRow[],
): ConnectionInventoryRow[] {
	const aggregateSlugs = new Set(
		(app.metadata?.mcpConfig?.aggregateApps ?? []).map((entry) =>
			entry.slug.trim().toLowerCase(),
		),
	);
	return rows.filter((row) =>
		row.references.some(
			(reference) =>
				reference.appId === app.id ||
				reference.appSlug === app.slug ||
				aggregateSlugs.has(reference.appSlug.trim().toLowerCase()),
		),
	);
}

function LifecycleFact({
	label,
	value,
	detail,
	className,
}: {
	label: string;
	value: string;
	detail: string;
	className?: string;
}) {
	return (
		<div className={`grid min-w-0 content-start gap-1 p-3 ${className ?? ""}`}>
			<Text as="dt" role="label" tone="secondary">
				{label}
			</Text>
			<dd className="m-0 grid gap-1">
				<Text as="strong" weight="medium">
					{value}
				</Text>
				<Text as="span" role="body" tone="secondary">
					{detail}
				</Text>
			</dd>
		</div>
	);
}

export function AppLifecyclePanel({ app }: { app: App }) {
	const canManage = useCanManageApps();
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
	const eligibility = useQuery(installedAppEligibilityQueryOptions());
	const membership = useQuery(appGatewayMembershipQueryOptions(app.id));
	const [serviceCheck, setServiceCheck] = useState<{
		status: "checking" | "healthy" | "issue" | "error";
		detail: string;
		toolCount: number | null;
		checkedAt?: string;
	} | null>(null);

	const orgRows = appConnectionRows(
		app,
		organizationConnections.data?.rows ?? [],
	);
	const personalRows = appConnectionRows(
		app,
		personalConnections.data?.rows ?? [],
	);
	const connectedOrg = orgRows.some(
		(row) =>
			row.accountState === "present" && row.connection?.status === "connected",
	);
	const connectedPersonal = personalRows.some(
		(row) =>
			row.accountState === "present" && row.connection?.status === "connected",
	);
	const governance = eligibility.data?.find((entry) => entry.appId === app.id);
	const providerQuery =
		app.metadata?.mcpConfig?.aggregateApps?.[0]?.slug ?? app.slug;

	const checkService = async () => {
		setServiceCheck({
			status: "checking",
			detail: "Running protocol checks and live tool discovery…",
			toolCount: serviceCheck?.toolCount ?? null,
		});
		try {
			const result = await osDirectReadApi.mcpHealth.run({
				appSlug: app.slug,
				authStrategy: "auto",
				tasksExtension: "ignore",
			});
			setServiceCheck({
				status: result.allPassed ? "healthy" : "issue",
				detail: result.allPassed
					? `${result.passCount} protocol checks passed.`
					: `${result.failCount} of ${result.passCount + result.failCount} protocol checks failed.`,
				toolCount: result.toolCount,
				checkedAt: new Date().toISOString(),
			});
		} catch (error) {
			setServiceCheck({
				status: "error",
				detail:
					error instanceof Error
						? error.message
						: "The MCP check could not run.",
				toolCount: null,
				checkedAt: new Date().toISOString(),
			});
		}
	};

	const connectionValue =
		organizationConnections.isPending || personalConnections.isPending
			? "Checking accounts"
			: organizationConnections.isError || personalConnections.isError
				? "Account state unavailable"
				: connectedOrg
					? connectedPersonal
						? "Organization and personal accounts connected"
						: "Organization account connected"
					: connectedPersonal
						? "Personal account connected"
						: orgRows.length + personalRows.length > 0
							? "Connection needs attention"
							: "No account requirement discovered";
	const gatewayValue = membership.isPending
		? "Checking membership"
		: membership.isError
			? "Gateway state unavailable"
			: membership.data?.enabled
				? "Available in unified gateway"
				: "Not in unified gateway";
	const governanceValue = eligibility.isPending
		? "Checking readiness"
		: eligibility.isError
			? "Governance unavailable"
			: governance?.badge === "ready"
				? "Governance ready"
				: governance?.badge === "plan_upgrade"
					? "Plan upgrade needed"
					: governance
						? "Setup needed"
						: "Governance not evaluated";
	const healthValue = !serviceCheck
		? "MCP service not checked"
		: serviceCheck.status === "checking"
			? "Checking MCP service"
			: serviceCheck.status === "healthy"
				? "MCP healthy"
				: serviceCheck.status === "issue"
					? "MCP service issue"
					: "MCP check unavailable";

	return (
		<div className="grid gap-4">
			<PageSection aria-labelledby="app-lifecycle-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="app-lifecycle-title">App lifecycle</SectionTitle>
						<SectionDescription>
							Installation, accounts, gateway access, governance, and health are
							independent states.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<div className="grid gap-3">
					<dl
						aria-label="App lifecycle states"
						className="m-0 grid overflow-hidden rounded-lg border border-kumo-line md:grid-cols-2"
					>
						<LifecycleFact
							label="Installation"
							value="Installed for this organization"
							detail="The app record is tenant scoped. Personal credentials are never implied by installation."
							className="md:border-kumo-hairline md:border-r"
						/>
						<LifecycleFact
							label="Account"
							value={connectionValue}
							detail="Organization credentials may be shared by policy; personal credentials remain owned by the connected user."
							className="border-kumo-hairline border-t md:border-t-0"
						/>
						<LifecycleFact
							label="Unified gateway"
							value={gatewayValue}
							detail="Gateway membership controls discovery. It does not create credentials or grant scopes."
							className="border-kumo-hairline border-t md:border-r"
						/>
						<LifecycleFact
							label="Governance"
							value={governanceValue}
							detail="Readiness evaluates required connections, scopes, plans, entitlements, and tool policy."
							className="border-kumo-hairline border-t"
						/>
						<LifecycleFact
							label="MCP health"
							value={healthValue}
							detail={
								serviceCheck
									? `${serviceCheck.detail}${serviceCheck.checkedAt ? ` Checked ${new Date(serviceCheck.checkedAt).toLocaleString()}.` : ""}`
									: "Run a service test to inspect the MCP protocol endpoint."
							}
							className="border-kumo-hairline border-t md:border-r"
						/>
						<LifecycleFact
							label="Available tools"
							value={
								serviceCheck?.toolCount == null
									? "Live inventory not checked"
									: `${serviceCheck.toolCount.toLocaleString()} live ${serviceCheck.toolCount === 1 ? "tool" : "tools"}`
							}
							detail="Counts come from live gateway discovery, not stored governance inventory."
							className="border-kumo-hairline border-t"
						/>
					</dl>
					<div
						className="flex flex-wrap items-center gap-2"
						role="group"
						aria-label="App lifecycle actions"
					>
						<Button
							size="sm"
							onClick={() => void checkService()}
							disabled={serviceCheck?.status === "checking"}
						>
							{serviceCheck?.status === "checking"
								? "Testing…"
								: "Test connection"}
						</Button>
						<Button
							size="sm"
							variant="outline"
							nativeButton={false}
							render={
								<RouterLink
									to="/admin/connections"
									search={{ q: providerQuery, status: "used" }}
								/>
							}
						>
							Connect
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label="More app lifecycle actions"
										size="icon-sm"
										variant="outline"
									/>
								}
							>
								<DotsThree size={16} weight="bold" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuLinkItem
									href={`/admin/connections?q=${encodeURIComponent(providerQuery)}&status=used`}
								>
									Manage scopes
								</DropdownMenuLinkItem>
								<DropdownMenuLinkItem href={`/apps/${app.id}/tools`}>
									View tools
								</DropdownMenuLinkItem>
								<DropdownMenuSeparator />
								<DropdownMenuLinkItem
									href={`/apps/${app.id}/settings#app-danger-zone`}
									variant="danger"
								>
									Remove app
								</DropdownMenuLinkItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</PageSection>
			<AppGatewayMembership appId={app.id} canManage={canManage} />
		</div>
	);
}

/**
 * The Overview tab of /apps/$appId: quick stats across the sibling tabs, the
 * 30-day session summary, and a bounded tool preview with live widget previews. The
 * app identity header lives in the layout (`app-detail-layout.tsx`).
 */
export function AppOverviewPage() {
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";

	const detail = useQuery({
		...appDetailQueryOptions(appId),
		enabled: appId.length > 0,
	});

	// Sibling-tab counters. Each degrades independently: a failed read renders
	// an em dash on its tile rather than blocking the overview.
	const adapters = useQuery({
		...appAdaptersListQueryOptions(appId),
		enabled: appId.length > 0,
	});
	const sources = useQuery({
		...contentSourcesQueryOptions(appId),
		enabled: appId.length > 0,
	});
	const range = useMemo(() => appAnalyticsRange(), []);
	const metrics = useQuery({
		...appMetricsQueryOptions(appId, range),
		enabled: appId.length > 0,
		retry: false,
		refetchOnWindowFocus: false,
	});

	const app = detail.data?.app ?? null;
	const tools = sortTools(detail.data?.tools ?? []);
	const previewTools = appOverviewToolPreview(tools);

	if (detail.isPending) {
		return (
			<div aria-hidden="true" className="grid gap-4">
				<Skeleton className="h-24 rounded-lg" />
				<Skeleton className="h-14 rounded-lg" />
				<Skeleton className="h-14 rounded-lg" />
			</div>
		);
	}
	if (detail.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>App is unavailable</AlertTitle>
				<AlertDescription>{(detail.error as Error).message}</AlertDescription>
			</Alert>
		);
	}
	if (!app) return null;

	const enabledTools = tools.filter((tool) => tool.enabled !== false);
	const adapterRows = adapters.data?.data ?? null;
	const enabledAdapters =
		adapterRows?.filter((adapter) => adapter.enabled !== false) ?? null;
	const sourceRows = sources.data?.sources ?? null;

	return (
		<div className="grid gap-6">
			<AppLifecyclePanel app={app} />
			<AppOverviewSummary
				appId={appId}
				tools={{ enabled: enabledTools.length, total: tools.length }}
				adapters={
					adapterRows && enabledAdapters
						? { enabled: enabledAdapters.length, total: adapterRows.length }
						: null
				}
				contentSources={sourceRows?.length ?? null}
				sessions={metrics.data?.totalSessions ?? null}
				successRate={metrics.data?.successRate ?? null}
			/>

			<PageSection aria-labelledby="app-overview-tools-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="app-overview-tools-title">Tools</SectionTitle>
						<SectionDescription>
							A preview of MCP capabilities exposed by this installed app.
						</SectionDescription>
					</SectionHeading>
					<SectionActions>
						<Badge variant="secondary">{tools.length}</Badge>
						{tools.length > 0 && (
							<Button
								size="sm"
								variant="outline"
								nativeButton={false}
								render={
									<RouterLink to="/apps/$appId/tools" params={{ appId }} />
								}
							>
								View all tools
							</Button>
						)}
					</SectionActions>
				</SectionHeader>
				{tools.length === 0 && (
					<Empty appearance="quiet">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Wrench size={20} />
							</EmptyMedia>
							<EmptyTitle>No tools yet</EmptyTitle>
							<EmptyDescription>
								This app has no D1 tool rows. Register verb-first tools through
								the Tedix CLI or the app's config pipeline — the same rows serve
								MCP clients and render here.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
				{previewTools.length > 0 && (
					<Collection>
						{previewTools.map((tool) => (
							<AppToolRow
								key={tool.id}
								tool={tool}
								appSlug={app.slug}
								widgetHostOrigin={widgetOrigin(app)}
								showDescription={false}
							/>
						))}
					</Collection>
				)}
			</PageSection>
		</div>
	);
}

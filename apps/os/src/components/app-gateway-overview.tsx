/**
 * Overview of the organization's gateway app: the one address people add to
 * their AI tool to reach every installed app.
 *
 * Most people who land here have never configured an MCP server, so the page
 * leads with their jobs in plain words — copy the address, follow the steps
 * for their AI tool, choose which apps it reaches, check that it works — and
 * keeps the technical facts behind one "Advanced" disclosure. The generic app
 * overview (`AppOverviewPage`) still serves every other app.
 */

import { AppWindow } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink, useParams } from "@tanstack/react-router";
import type { App, AppListItem } from "@tedix/api-contract/schemas/app";
import { type ReactNode, useMemo, useState } from "react";
import { LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { IconFrame } from "@/components/kumo/icon-frame";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	PageSection,
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Skeleton } from "@/components/kumo/skeleton";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import {
	AppOverviewPage,
	mcpEndpointHost,
	mcpEndpointUrl,
} from "@/components/app-detail";
import { osApi, osDirectReadApi } from "@/lib/api";
import {
	APPS_MANAGE_DENIED_REASON,
	useCanManageApps,
} from "@/lib/app-permissions";
import {
	appAnalyticsRange,
	appDetailQueryOptions,
	appGatewayMembershipQueryOptions,
	appGatewayMembershipsQueryOptions,
	appListQueryOptions,
	appMetricsQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

const GATEWAY_APPS_LIMIT = 100;

/**
 * True when this app is the organization's gateway. The membership read is
 * authoritative; until it answers, an app that aggregates other apps is
 * treated as the gateway so the page does not flash the generic layout.
 */
export function useIsOrganizationGateway(
	app: Pick<App, "id" | "metadata"> | null,
): boolean {
	const membership = useQuery({
		...appGatewayMembershipQueryOptions(app?.id ?? ""),
		enabled: Boolean(app?.id),
	});
	if (!app) return false;
	if (membership.data) return membership.data.gateway?.id === app.id;
	return (app.metadata?.mcpConfig?.aggregateApps?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Connect your AI tool
// ---------------------------------------------------------------------------

export type GatewayClient =
	| "claude"
	| "chatgpt"
	| "cursor"
	| "claude-code"
	| "codex";

export const GATEWAY_CLIENTS: readonly {
	value: GatewayClient;
	label: string;
}[] = [
	{ value: "claude", label: "Claude" },
	{ value: "chatgpt", label: "ChatGPT" },
	{ value: "cursor", label: "Cursor" },
	{ value: "claude-code", label: "Claude Code" },
	{ value: "codex", label: "Codex" },
];

export function cursorConfigSnippet(name: string, url: string): string {
	return JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2);
}

function Step({ number, children }: { number: number; children: ReactNode }) {
	return (
		<li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
			<span
				aria-hidden="true"
				className="grid size-6 place-items-center rounded-full border border-kumo-line text-kumo-subtle type-tedix-control"
			>
				{number}
			</span>
			<div className="grid min-w-0 gap-2 pt-0.5">{children}</div>
		</li>
	);
}

function StepText({ children }: { children: ReactNode }) {
	return (
		<Text as="p" role="body" className="m-0">
			{children}
		</Text>
	);
}

function Note({ children }: { children: ReactNode }) {
	return (
		<Text as="p" role="body" tone="secondary" className="m-0">
			{children}
		</Text>
	);
}

function CopyCommand({ command }: { command: string }) {
	return (
		<ClipboardText
			className="max-w-full"
			size="sm"
			text={command}
			labels={{ copyAction: "Copy command" }}
			tooltip={{ text: "Copy command" }}
		/>
	);
}

function ExternalLink({
	href,
	children,
}: {
	href: string;
	children: ReactNode;
}) {
	return (
		<Link href={href} target="_blank" rel="noreferrer noopener">
			{children}
		</Link>
	);
}

export function GatewayClientSteps({
	client,
	appName,
	name,
	url,
}: {
	client: GatewayClient;
	appName: string;
	name: string;
	url: string;
}) {
	switch (client) {
		case "claude":
			return (
				<>
					<ol className="m-0 grid list-none gap-4 p-0">
						<Step number={1}>
							<StepText>
								In Claude, open{" "}
								<ExternalLink href="https://claude.ai/customize/connectors">
									Customize › Connectors
								</ExternalLink>
								.
							</StepText>
						</Step>
						<Step number={2}>
							<StepText>
								Select <strong>+ Add</strong>, then{" "}
								<strong>Add custom connector</strong>.
							</StepText>
						</Step>
						<Step number={3}>
							<StepText>
								Name it <strong>{appName}</strong>, paste the address above and
								select <strong>Continue</strong>.
							</StepText>
						</Step>
						<Step number={4}>
							<StepText>
								Select <strong>Connect</strong> and sign in with your Tedix
								account.
							</StepText>
						</Step>
					</ol>
					<Note>
						Works in Claude on the web, the desktop app and Cowork. On a Team or
						Enterprise plan, an owner adds it once under Organization settings ›
						Connectors; everyone else only selects Connect.
					</Note>
				</>
			);
		case "chatgpt":
			return (
				<>
					<ol className="m-0 grid list-none gap-4 p-0">
						<Step number={1}>
							<StepText>
								A ChatGPT workspace admin opens{" "}
								<ExternalLink href="https://chatgpt.com/admin/ca">
									Workspace settings › Apps
								</ExternalLink>{" "}
								and creates a custom app with the address above.
							</StepText>
						</Step>
						<Step number={2}>
							<StepText>
								The admin tests it and publishes it to the workspace.
							</StepText>
						</Step>
						<Step number={3}>
							<StepText>
								Each person turns it on in a chat and signs in with their Tedix
								account.
							</StepText>
						</Step>
					</ol>
					<Note>
						Only ChatGPT Business, Enterprise and Edu can add custom apps. Tedix
						has not tested this path yet; if it fails, use Claude or Cursor.
					</Note>
				</>
			);
		case "cursor":
			return (
				<ol className="m-0 grid list-none gap-4 p-0">
					<Step number={1}>
						<StepText>
							Open <code>~/.cursor/mcp.json</code> (create it if it is missing)
							and add:
						</StepText>
						<CodeBlock
							className="w-full min-w-0 max-w-full overflow-auto"
							code={cursorConfigSnippet(name, url)}
							lang="json"
						/>
					</Step>
					<Step number={2}>
						<StepText>
							Restart Cursor. When it asks you to sign in to{" "}
							<strong>{name}</strong>, sign in with your Tedix account.
						</StepText>
					</Step>
				</ol>
			);
		case "claude-code":
			return (
				<ol className="m-0 grid list-none gap-4 p-0">
					<Step number={1}>
						<StepText>In a terminal, run:</StepText>
						<CopyCommand
							command={`claude mcp add --transport http ${name} ${url}`}
						/>
					</Step>
					<Step number={2}>
						<StepText>
							In Claude Code, type <code>/mcp</code>, choose{" "}
							<strong>{name}</strong> and sign in with your Tedix account.
						</StepText>
					</Step>
				</ol>
			);
		case "codex":
			return (
				<ol className="m-0 grid list-none gap-4 p-0">
					<Step number={1}>
						<StepText>In a terminal, run:</StepText>
						<CopyCommand command={`codex mcp add ${name} --url ${url}`} />
					</Step>
					<Step number={2}>
						<StepText>Then sign in with your Tedix account:</StepText>
						<CopyCommand command={`codex mcp login ${name}`} />
					</Step>
				</ol>
			);
	}
}

function ConnectSection({ app }: { app: App }) {
	const [client, setClient] = useState<GatewayClient>("claude");
	const url = mcpEndpointUrl(app);
	// The slug is the stable short name for config files and commands.
	const name = app.slug;
	return (
		<PageSection aria-labelledby="gateway-connect-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="gateway-connect-title">
						Connect your AI tool
					</SectionTitle>
					<SectionDescription>
						Everyone in your organization uses the same address. Each person
						signs in with their own Tedix account, so the AI tool only sees what
						that person is allowed to see.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<div className="grid min-w-0 gap-2">
				<Text as="span" role="label" tone="secondary">
					Connection address
				</Text>
				<ClipboardText
					className="w-full max-w-xl"
					size="base"
					text={url}
					labels={{ copyAction: "Copy address" }}
					tooltip={{ text: "Copy address" }}
				/>
			</div>
			<div className="grid min-w-0 gap-4 rounded-lg border border-kumo-line p-4">
				<SegmentedControl
					ariaLabel="AI tool"
					value={client}
					onValueChange={setClient}
					options={GATEWAY_CLIENTS}
				/>
				<div className="grid min-w-0 gap-4">
					<GatewayClientSteps
						client={client}
						appName={app.name}
						name={name}
						url={url}
					/>
				</div>
			</div>
		</PageSection>
	);
}

// ---------------------------------------------------------------------------
// Apps it reaches
// ---------------------------------------------------------------------------

function GatewayAppRow({
	app,
	enabled,
	canManage,
}: {
	app: AppListItem;
	enabled: boolean;
	canManage: boolean;
}) {
	const client = useQueryClient();
	const mutation = useMutation({
		mutationFn: (next: boolean) =>
			osApi.apps.setGatewayMembership({ appId: app.id, enabled: next }),
		onSuccess: (_data, next) => {
			toast.success(
				next
					? `${app.name} is now reachable`
					: `${app.name} is no longer reachable`,
			);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : `Could not update ${app.name}`,
			);
		},
		onSettled: async () => {
			await client.invalidateQueries({ queryKey: osQueryKeys.apps() });
		},
	});
	const checked = mutation.isPending ? Boolean(mutation.variables) : enabled;
	return (
		<li className="flex min-w-0 items-center gap-3 px-4 py-3">
			<IconFrame size="sm" className="shrink-0 overflow-hidden">
				{app.logoUrl ? (
					<img src={app.logoUrl} alt="" className="size-full object-cover" />
				) : (
					<AppWindow size={16} aria-hidden="true" />
				)}
			</IconFrame>
			<div className="grid min-w-0 flex-1 gap-0.5">
				<RouterLink
					to="/apps/$appId"
					params={{ appId: app.id }}
					className="min-w-0 truncate font-medium text-kumo-default no-underline type-tedix-body hover:underline"
				>
					{app.name}
				</RouterLink>
				{app.description ? (
					<Text as="span" role="label" tone="secondary" className="truncate">
						{app.description}
					</Text>
				) : null}
			</div>
			<Switch
				className="shrink-0"
				aria-label={`Include ${app.name}`}
				checked={checked}
				disabled={!canManage || mutation.isPending}
				title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
				onCheckedChange={(next) => mutation.mutate(next)}
			/>
		</li>
	);
}

function AppsSection({ gatewayId }: { gatewayId: string }) {
	const canManage = useCanManageApps();
	const apps = useQuery(appListQueryOptions(GATEWAY_APPS_LIMIT));
	const memberships = useQuery(appGatewayMembershipsQueryOptions());
	const enabledById = useMemo(
		() =>
			new Map(
				(memberships.data?.memberships ?? []).map((row) => [
					row.appId,
					row.enabled,
				]),
			),
		[memberships.data],
	);
	const rows = (apps.data?.data ?? []).filter((app) => app.id !== gatewayId);
	const onCount = rows.filter((app) => enabledById.get(app.id)).length;
	const pending = apps.isPending || memberships.isPending;
	const error = apps.error ?? memberships.error;

	return (
		<PageSection aria-labelledby="gateway-apps-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="gateway-apps-title">Apps it reaches</SectionTitle>
					<SectionDescription>
						Your AI tool can use the apps switched on here. Turning one off
						hides it from the AI tool; the app stays installed and no one&apos;s
						account changes. Open an app to choose which of its tools are
						available.
					</SectionDescription>
				</SectionHeading>
				{!pending && !error ? (
					<SectionActions>
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="whitespace-nowrap"
						>
							{onCount} of {rows.length} on
						</Text>
					</SectionActions>
				) : null}
			</SectionHeader>
			{pending ? (
				<div aria-hidden="true" className="grid gap-2">
					<Skeleton className="h-14 rounded-lg" />
					<Skeleton className="h-14 rounded-lg" />
				</div>
			) : error ? (
				<LoadError
					onRetry={() => {
						void apps.refetch();
						void memberships.refetch();
					}}
					title="Apps could not be loaded"
					error={apps.error ?? memberships.error}
					retrying={apps.isFetching || memberships.isFetching}
				/>
			) : rows.length === 0 ? (
				<Text as="p" role="body" tone="secondary">
					No other apps are installed yet. Install an app and it can be added
					here.
				</Text>
			) : (
				<Collection aria-label="Apps it reaches">
					{rows.map((app) => (
						<GatewayAppRow
							key={app.id}
							app={app}
							enabled={enabledById.get(app.id) ?? false}
							canManage={canManage}
						/>
					))}
				</Collection>
			)}
			{!canManage && rows.length > 0 ? (
				<Text as="p" role="body" tone="secondary">
					{APPS_MANAGE_DENIED_REASON}
				</Text>
			) : null}
		</PageSection>
	);
}

// ---------------------------------------------------------------------------
// Is it working?
// ---------------------------------------------------------------------------

type HealthState =
	| { status: "checking" }
	| { status: "healthy"; toolCount: number }
	| { status: "issue"; failed: number; total: number }
	| { status: "error"; message: string };

export function gatewayHealthSentence(state: HealthState | null): string {
	if (!state) return "Not checked yet.";
	switch (state.status) {
		case "checking":
			return "Checking…";
		case "healthy":
			return `Working. AI tools can reach ${state.toolCount.toLocaleString()} ${state.toolCount === 1 ? "tool" : "tools"}.`;
		case "issue":
			return `Not fully working: ${state.failed} of ${state.total} checks failed.`;
		case "error":
			return `The check could not run: ${state.message}`;
	}
}

export function gatewayUsageSentence(
	sessions: number | null,
	successRate: number | null,
): string | null {
	if (sessions == null) return null;
	if (sessions === 0) return "Nobody has used it in the last 30 days.";
	const used = `Used in ${sessions.toLocaleString()} ${sessions === 1 ? "session" : "sessions"} in the last 30 days`;
	return successRate == null
		? `${used}.`
		: `${used}; ${Math.round(successRate)}% finished without errors.`;
}

function HealthSection({ app }: { app: App }) {
	const [health, setHealth] = useState<HealthState | null>(null);
	const range = useMemo(() => appAnalyticsRange(), []);
	const metrics = useQuery({
		...appMetricsQueryOptions(app.id, range),
		retry: false,
		refetchOnWindowFocus: false,
	});
	const check = async () => {
		setHealth({ status: "checking" });
		try {
			const result = await osDirectReadApi.mcpHealth.run({
				appSlug: app.slug,
				authStrategy: "auto",
				tasksExtension: "ignore",
			});
			setHealth(
				result.allPassed
					? { status: "healthy", toolCount: result.toolCount ?? 0 }
					: {
							status: "issue",
							failed: result.failCount,
							total: result.passCount + result.failCount,
						},
			);
		} catch (error) {
			setHealth({
				status: "error",
				message:
					error instanceof Error ? error.message : "Try again in a minute.",
			});
		}
	};
	const usage = gatewayUsageSentence(
		metrics.data?.totalSessions ?? null,
		metrics.data?.successRate ?? null,
	);
	return (
		<PageSection aria-labelledby="gateway-health-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="gateway-health-title">Is it working?</SectionTitle>
				</SectionHeading>
			</SectionHeader>
			<div className="grid min-w-0 gap-3 rounded-lg border border-kumo-line p-4">
				<div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
					<Text
						as="p"
						role="body"
						className="m-0 min-w-0"
						tone={
							health?.status === "issue" || health?.status === "error"
								? "error"
								: health?.status === "healthy"
									? "success"
									: "default"
						}
						aria-live="polite"
					>
						{gatewayHealthSentence(health)}
					</Text>
					<Button
						size="sm"
						variant="outline"
						onClick={() => void check()}
						disabled={health?.status === "checking"}
					>
						{health?.status === "checking" ? "Checking…" : "Check connection"}
					</Button>
				</div>
				{usage ? (
					<Text as="p" role="body" tone="secondary" className="m-0">
						{usage}{" "}
						<Link
							href={`/apps/${app.id}/analytics`}
							className="whitespace-nowrap"
						>
							See usage
						</Link>
					</Text>
				) : null}
			</div>
		</PageSection>
	);
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

function AdvancedFact({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="grid min-w-0 gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
			<Text as="dt" role="label" tone="secondary">
				{label}
			</Text>
			<Text
				as="dd"
				role="body"
				className="m-0 min-w-0 [overflow-wrap:anywhere]"
			>
				{children}
			</Text>
		</div>
	);
}

function AdvancedSection({
	app,
	tools,
}: {
	app: App;
	tools: { enabled: number; total: number };
}) {
	const authMode = app.metadata?.mcpConfig?.authMode;
	return (
		<Collapsible data-gateway-advanced="">
			<CollapsibleDefaultTrigger className="group/disclosure -ml-2">
				Advanced
			</CollapsibleDefaultTrigger>
			<CollapsibleDefaultContent>
				<div className="grid gap-4 pt-3">
					<Text as="p" role="body" tone="secondary" className="m-0 max-w-2xl">
						Technically this is an MCP server (Model Context Protocol, the open
						standard AI tools use to connect to apps). It combines the apps
						above into one server, so people add one connection instead of one
						per app.
					</Text>
					<dl className="m-0 grid gap-3">
						<AdvancedFact label="Server name">
							<code>{app.slug}</code>
						</AdvancedFact>
						<AdvancedFact label="Host">
							<code>{mcpEndpointHost(app)}</code>
						</AdvancedFact>
						{authMode ? (
							<AdvancedFact label="Sign-in method">{authMode}</AdvancedFact>
						) : null}
						{app.visibility ? (
							<AdvancedFact label="Visibility">{app.visibility}</AdvancedFact>
						) : null}
						<AdvancedFact label="Own tools">
							{tools.enabled} of {tools.total} on
						</AdvancedFact>
					</dl>
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="outline"
							nativeButton={false}
							render={
								<RouterLink
									to="/apps/$appId/tools"
									params={{ appId: app.id }}
								/>
							}
						>
							Tools
						</Button>
						<Button
							size="sm"
							variant="outline"
							nativeButton={false}
							render={
								<RouterLink
									to="/apps/$appId/settings"
									params={{ appId: app.id }}
								/>
							}
						>
							Settings
						</Button>
					</div>
				</div>
			</CollapsibleDefaultContent>
		</Collapsible>
	);
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

export function AppGatewayOverview({
	app,
	tools,
}: {
	app: App;
	tools: { enabled: number; total: number };
}) {
	return (
		<div className="grid min-w-0 gap-8">
			<ConnectSection app={app} />
			<AppsSection gatewayId={app.id} />
			<HealthSection app={app} />
			<AdvancedSection app={app} tools={tools} />
		</div>
	);
}

/**
 * Overview tab of /apps/$appId: the gateway gets its own job-led page, every
 * other app keeps the generic overview.
 */
export function AppOverviewRoute() {
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";
	const detail = useQuery({
		...appDetailQueryOptions(appId),
		enabled: appId.length > 0,
	});
	const app = detail.data?.app ?? null;
	const isGateway = useIsOrganizationGateway(app);
	if (!app || !isGateway) return <AppOverviewPage />;
	const tools = detail.data?.tools ?? [];
	return (
		<AppGatewayOverview
			app={app}
			tools={{
				enabled: tools.filter((tool) => tool.enabled !== false).length,
				total: tools.length,
			}}
		/>
	);
}

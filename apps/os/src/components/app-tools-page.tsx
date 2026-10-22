/**
 * /apps/$appId/tools — MCP tool and adapter configuration.
 *
 * Enable/disable toggles are optimistic on the GENERATED keys:
 * cancel → snapshot → setQueryData → rollback on error → invalidate on settle.
 * The settle invalidation also reaches the apps domain, because the Overview
 * tab renders the same tool rows through `apps.getByIdWithTools`.
 *
 * Write affordances render disabled without `apps:update` — mirroring the
 * server's `AUTHZ.toolsWrite`/`appsWrite` gates, never replacing them.
 *
 * Search and pagination are server-owned. The browser receives one narrow page
 * plus exact matched and unfiltered counts, so a large tool schema cannot turn
 * an inventory screen into an oversized response or an incomplete local search.
 */

import { useDeferredValue, useState } from "react";
import {
	useMutation,
	useQueryClient,
	useQuery,
	type QueryKey,
} from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { CAPABILITY_SCOPE_METADATA } from "@tedix/mcp-shared/auth/scopes";
import { Plugs, Wrench } from "@phosphor-icons/react";
import { toast } from "@/components/kumo/toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { PageSection } from "@/components/kumo/page";
import { Pagination } from "@/components/kumo/pagination";
import { SearchInput } from "@/components/kumo/search-input";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { TableCell, TableHead, TableRow } from "@/components/kumo/table";
import {
	AppTabTable,
	AppTabHeader,
	AppTabEmpty,
	AppTabError,
	AppTabLoading,
} from "./app-detail-tab-shared";
import { osApi } from "@/lib/api";
import {
	APPS_MANAGE_DENIED_REASON,
	useCanManageApps,
} from "@/lib/app-permissions";
import {
	APP_TOOLS_PAGE_SIZE,
	appAdaptersListQueryOptions,
	appToolsListQueryOptions,
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Tooltip for a required scope, read from `CAPABILITY_SCOPE_METADATA` in
 * @tedix/mcp-shared — the catalog that sits beside the scopes the edge
 * enforces, so this page cannot describe a scope that does not exist.
 * An unknown string passes through undescribed rather than being hidden: the
 * resolver can legitimately return a per-app `toolScopes` override that is not
 * in the capability catalog, and hiding it would under-report the requirement.
 */
export function scopeHint(scope: string): string {
	const meta = (
		CAPABILITY_SCOPE_METADATA as Record<string, { description?: string }>
	)[scope];
	return meta?.description
		? `${scope} — ${meta.description}`
		: `${scope} — required to call this tool`;
}

/** Longest query considered when matching; anything past it cannot narrow. */
const MAX_TOOL_QUERY_CHARS = 200;

type AppToolsListResponse = Awaited<ReturnType<typeof osApi.appTools.list>>;
// An absent requiredScopes value means unreported, rather than no access required.
type ToolRowData = AppToolsListResponse["data"][number];
type AdapterRowData = Awaited<
	ReturnType<typeof osApi.appAdapters.list>
>["data"][number];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function ToolRow({
	tool,
	appId,
	canManage,
	listKey,
}: {
	tool: ToolRowData;
	appId: string;
	canManage: boolean;
	listKey: QueryKey;
}) {
	const queryClient = useQueryClient();
	const isEnabled = tool.enabled !== false;
	const toggleMutation = useMutation({
		mutationFn: (checked: boolean) =>
			checked
				? osApi.appTools.enable({ appId, toolId: tool.id })
				: osApi.appTools.disable({ appId, toolId: tool.id }),
		onMutate: async (checked) => {
			await queryClient.cancelQueries({ queryKey: osQueryKeys.appTools() });
			const previous = queryClient.getQueryData<AppToolsListResponse>(listKey);
			queryClient.setQueryData<AppToolsListResponse>(listKey, (old) =>
				old
					? {
							...old,
							data: old.data.map((row) =>
								row.id === tool.id ? { ...row, enabled: checked } : row,
							),
						}
					: old,
			);
			return { previous };
		},
		onError: (_error, _checked, context) => {
			if (context?.previous) {
				queryClient.setQueryData(listKey, context.previous);
			}
			toast.error("Failed to update tool");
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.appTools() });
			queryClient.invalidateQueries({
				queryKey: osQuery.mcpServer.previewToolScopes.key({ type: "query" }),
			});
			// The Overview tab renders the same rows via apps.getByIdWithTools.
			queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() });
		},
		onSuccess: (_data, checked) => {
			toast.success(`${tool.title} ${checked ? "enabled" : "disabled"}`);
		},
	});

	return (
		<TableRow>
			<TableCell className="whitespace-normal">
				<div className="flex min-w-0 items-center gap-3">
					<div className="min-w-0 flex-1">
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<Text
								as="span"
								role="body"
								weight="medium"
								className="min-w-0 max-w-full truncate"
							>
								{tool.title}
							</Text>
							{tool.toolTypeId && (
								<Badge variant="outline" className="max-w-full truncate">
									{tool.toolTypeId}
								</Badge>
							)}
							{tool.visibility === "private" && (
								<Badge variant="secondary">Private</Badge>
							)}
							{tool.widgetRoute && <Badge variant="outline">Widget</Badge>}
							{(tool.requiredScopes ?? []).map((scope) => (
								<Badge
									key={scope}
									title={scopeHint(scope)}
									variant={scope === "platform:admin" ? "secondary" : "outline"}
								>
									{scope}
								</Badge>
							))}
							{tool.requiredScopes?.length === 0 && (
								<Badge variant="outline">No scope required</Badge>
							)}
						</div>
						{tool.description && (
							<Text
								as="p"
								role="label"
								tone="secondary"
								className="mt-0.5 mb-0 line-clamp-1"
							>
								{tool.description}
							</Text>
						)}
					</div>
				</div>
			</TableCell>
			<TableCell className="w-16 text-right">
				<Switch
					className="shrink-0"
					aria-label={`${isEnabled ? "Disable" : "Enable"} ${tool.title}`}
					checked={isEnabled}
					onCheckedChange={(checked) => toggleMutation.mutate(checked)}
					disabled={!canManage || toggleMutation.isPending}
					title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
				/>
			</TableCell>
		</TableRow>
	);
}

function AdapterRow({
	adapter,
	appId,
	canManage,
}: {
	adapter: AdapterRowData;
	appId: string;
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const isEnabled = adapter.enabled !== false;
	const listKey = appAdaptersListQueryOptions(appId).queryKey;
	const adapterLabel = adapter.displayName || adapter.name;

	const toggleMutation = useMutation({
		mutationFn: (checked: boolean) =>
			checked
				? osApi.appAdapters.enable({ appId, adapterId: adapter.id })
				: osApi.appAdapters.disable({ appId, adapterId: adapter.id }),
		onMutate: async (checked) => {
			await queryClient.cancelQueries({ queryKey: osQueryKeys.appAdapters() });
			const previous = queryClient.getQueryData(listKey);
			queryClient.setQueryData(listKey, (old) =>
				old
					? {
							...old,
							data: old.data.map((row) =>
								row.id === adapter.id ? { ...row, enabled: checked } : row,
							),
						}
					: old,
			);
			return { previous };
		},
		onError: (_error, _checked, context) => {
			if (context?.previous) {
				queryClient.setQueryData(listKey, context.previous);
			}
			toast.error("Failed to update adapter");
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.appAdapters() });
		},
		onSuccess: (_data, checked) => {
			toast.success(`${adapterLabel} ${checked ? "enabled" : "disabled"}`);
		},
	});

	return (
		<TableRow>
			<TableCell className="whitespace-normal">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
						<Text
							as="span"
							role="body"
							weight="medium"
							className="min-w-0 max-w-full truncate"
						>
							{adapterLabel}
						</Text>
						<Badge variant="outline" className="max-w-full truncate">
							{adapter.adapterType}
						</Badge>
						{adapter.priority != null && adapter.priority > 0 && (
							<Badge variant="outline" className="px-1 py-0">
								P{adapter.priority}
							</Badge>
						)}
					</div>
				</div>
			</TableCell>
			<TableCell className="w-16 text-right">
				<Switch
					className="shrink-0"
					aria-label={`${isEnabled ? "Disable" : "Enable"} ${adapterLabel}`}
					checked={isEnabled}
					onCheckedChange={(checked) => toggleMutation.mutate(checked)}
					disabled={!canManage || toggleMutation.isPending}
					title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
				/>
			</TableCell>
		</TableRow>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AppToolsPage() {
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";
	const canManage = useCanManageApps();
	const [gatewayQuery, setGatewayQuery] = useState("");
	const [gatewayPage, setGatewayPage] = useState(1);
	const [toolQuery, setToolQuery] = useState("");
	const [toolPage, setToolPage] = useState(1);
	const deferredToolQuery = useDeferredValue(toolQuery.trim());
	const toolsQueryOptions = appToolsListQueryOptions(appId, {
		page: toolPage,
		query: deferredToolQuery || undefined,
	});

	const tools = useQuery({
		...toolsQueryOptions,
		enabled: appId.length > 0,
		staleTime: 30_000,
	});
	const adapters = useQuery({
		...appAdaptersListQueryOptions(appId),
		enabled: appId.length > 0,
		staleTime: 30_000,
	});

	const gateway = useQuery({
		...osQuery.mcpServer.previewToolScopes.queryOptions({ input: { appId } }),
		enabled: appId.length > 0,
		staleTime: 30_000,
	});
	const gatewayTools = Object.entries(gateway.data?.toolScopes ?? {}).filter(
		([name]) => name.toLowerCase().includes(gatewayQuery.trim().toLowerCase()),
	);
	const currentGatewayPage = Math.min(
		gatewayPage,
		Math.max(1, Math.ceil(gatewayTools.length / APP_TOOLS_PAGE_SIZE)),
	);

	const toolRows = tools.data?.data ?? [];
	const adapterRows = adapters.data?.data ?? [];

	// `pagination.total` is the exact search result count. `inventoryTotal`
	// remains the exact unfiltered count, so filtering never rewrites inventory.
	const toolTotal = tools.data?.pagination.total ?? 0;
	const inventoryTotal = tools.data?.inventoryTotal ?? 0;
	const toolPageCount = Math.max(1, Math.ceil(toolTotal / APP_TOOLS_PAGE_SIZE));
	// Clamped rather than reset, so a shrinking result set (a search, a delete)
	// cannot strand the collection on a page that no longer exists.
	const currentToolPage = Math.min(toolPage, toolPageCount);

	return (
		<div className="grid gap-6">
			<PageSection aria-labelledby="app-tools-title">
				<AppTabHeader
					id="app-tools-title"
					title="Direct tools"
					description={
						<>
							Tools configured directly on this app. A gateway can also compose
							tools from other apps and the host.
						</>
					}
					actions={
						<div className="flex min-w-0 items-center gap-2 sm:shrink-0">
							{inventoryTotal > 0 && (
								<SearchInput
									aria-label="Search MCP tools"
									containerClassName="w-full sm:w-56"
									onChange={(event) => {
										setToolQuery(
											event.target.value.slice(0, MAX_TOOL_QUERY_CHARS),
										);
										setToolPage(1);
									}}
									placeholder="Search tools"
									value={toolQuery}
								/>
							)}
							{/*
							 * The inventory count, not the length of what one request
							 * returned: past the fetch limit the two differ, and the
							 * badge used to report the smaller number as if it were the
							 * whole app.
							 */}
							<Badge variant="secondary">
								{tools.data
									? deferredToolQuery
										? `${toolTotal} of ${inventoryTotal}`
										: inventoryTotal
									: "—"}
							</Badge>
						</div>
					}
				/>
				{tools.isPending && <AppTabLoading label="Loading tools" />}
				{tools.isError && (
					<AppTabError title="Tools are unavailable" query={tools}>
						{tools.error.message}
					</AppTabError>
				)}
				{/*
				 * One empty state, two claims. Only the unfiltered branch may say the
				 * app has no tools, and it can only be reached when the server's
				 * exact `total` is zero; a search that found nothing reports its own
				 * reach instead of the app's inventory.
				 */}
				{tools.data && toolRows.length === 0 && (
					<AppTabEmpty
						icon={<Wrench size={20} />}
						title={
							deferredToolQuery
								? "No matching tools"
								: "No direct tools configured"
						}
						description={
							deferredToolQuery
								? `No tool in this app's ${inventoryTotal}-tool inventory matches this search.`
								: "No direct tools configured for this app. This does not mean its gateway has no tools."
						}
					/>
				)}
				{toolRows.length > 0 && (
					<AppTabTable
						label="Direct tools"
						headings={
							<>
								<TableHead>Tool</TableHead>
								<TableHead className="text-right">Enabled</TableHead>
							</>
						}
					>
						{toolRows.map((tool) => (
							<ToolRow
								key={tool.id}
								tool={tool}
								appId={appId}
								canManage={canManage}
								listKey={toolsQueryOptions.queryKey}
							/>
						))}
					</AppTabTable>
				)}
				{toolPageCount > 1 && (
					<Pagination
						className="flex-col items-stretch gap-3 sm:flex-row sm:items-center"
						page={currentToolPage}
						perPage={APP_TOOLS_PAGE_SIZE}
						totalCount={toolTotal}
						setPage={setToolPage}
					>
						<Pagination.Info />
						<Pagination.Controls controls="simple" />
					</Pagination>
				)}
			</PageSection>

			<PageSection aria-labelledby="gateway-tools-title">
				<AppTabHeader
					id="gateway-tools-title"
					title="Gateway tools"
					description={
						<>
							Configured tools from this app and its composed apps.
							Host-generated tools and your connection's granted access can
							differ; this is not a connection health check.
						</>
					}
					actions={
						<Badge variant="secondary">
							{gateway.data ? gateway.data.toolCount : "—"}
						</Badge>
					}
				/>
				{gateway.isPending && <AppTabLoading label="Loading gateway preview" />}
				{gateway.isError && (
					<AppTabError title="Gateway preview is unavailable" query={gateway}>
						{gateway.error.message}
					</AppTabError>
				)}
				{gateway.data && (
					<>
						{!gateway.data.complete && (
							<Alert>
								<AlertTitle>Partial gateway inventory</AlertTitle>
								<AlertDescription>
									Some sources could not be included:{" "}
									{gateway.data.skippedSources
										.map((source) => source.slug)
										.join(", ")}
									.
								</AlertDescription>
							</Alert>
						)}
						<SearchInput
							aria-label="Search gateway tools"
							placeholder="Search gateway tools"
							value={gatewayQuery}
							onChange={(event) => {
								setGatewayQuery(
									event.target.value.slice(0, MAX_TOOL_QUERY_CHARS),
								);
								setGatewayPage(1);
							}}
						/>
						{gatewayTools.length === 0 && (
							<Text as="p">
								{gatewayQuery
									? "No matching gateway tools."
									: "No configured tools found in this preview. Host-generated tools may still be available."}
							</Text>
						)}
						<AppTabTable
							label="Gateway tools"
							headings={
								<>
									<TableHead>Tool</TableHead>
									<TableHead>Required access</TableHead>
								</>
							}
						>
							{gatewayTools
								.slice(
									(currentGatewayPage - 1) * APP_TOOLS_PAGE_SIZE,
									currentGatewayPage * APP_TOOLS_PAGE_SIZE,
								)
								.map(([name, scopes]) => (
									<TableRow key={name}>
										<TableCell className="whitespace-normal break-all">
											<Text as="span">{name}</Text>
										</TableCell>
										<TableCell className="whitespace-normal">
											<div className="flex flex-wrap gap-2">
												{scopes.map((scope) => (
													<Badge
														key={scope}
														variant="outline"
														title={scopeHint(scope)}
													>
														{scope}
													</Badge>
												))}
											</div>
										</TableCell>
									</TableRow>
								))}
						</AppTabTable>
						{gatewayTools.length > APP_TOOLS_PAGE_SIZE && (
							<Pagination
								page={currentGatewayPage}
								perPage={APP_TOOLS_PAGE_SIZE}
								totalCount={gatewayTools.length}
								setPage={setGatewayPage}
							>
								<Pagination.Info />
								<Pagination.Controls controls="simple" />
							</Pagination>
						)}
					</>
				)}
			</PageSection>

			<PageSection aria-labelledby="app-adapters-title">
				<AppTabHeader
					id="app-adapters-title"
					title="Adapters"
					description="Execution adapters available to route tool calls."
					actions={
						<Badge variant="secondary">
							{adapters.data
								? adapterRows.filter((adapter) => adapter.enabled !== false)
										.length
								: "—"}
						</Badge>
					}
				/>
				{adapters.isPending && <AppTabLoading label="Loading adapters" />}
				{adapters.isError && (
					<AppTabError title="Adapters are unavailable" query={adapters}>
						{adapters.error.message}
					</AppTabError>
				)}
				{adapters.data && adapterRows.length === 0 && (
					<AppTabEmpty
						icon={<Plugs size={20} />}
						title="No adapters configured"
						description="No adapters configured for this app."
					/>
				)}
				{adapterRows.length > 0 && (
					<AppTabTable
						label="Adapters"
						headings={
							<>
								<TableHead>Adapter</TableHead>
								<TableHead className="text-right">Enabled</TableHead>
							</>
						}
					>
						{adapterRows.map((adapter) => (
							<AdapterRow
								key={adapter.id}
								adapter={adapter}
								appId={appId}
								canManage={canManage}
							/>
						))}
					</AppTabTable>
				)}
			</PageSection>
		</div>
	);
}

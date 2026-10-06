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
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	Collection,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Pagination } from "@/components/kumo/pagination";
import { SearchInput } from "@/components/kumo/search-input";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { osApi } from "@/lib/api";
import {
	APPS_MANAGE_DENIED_REASON,
	useCanManageApps,
} from "@/lib/app-permissions";
import {
	APP_TOOLS_PAGE_SIZE,
	appAdaptersListQueryOptions,
	appToolsListQueryOptions,
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

interface ToolRowData {
	id: string;
	toolId: string;
	title: string;
	description: string | null;
	toolTypeId: string | null;
	enabled: boolean | null;
	visibility: string | null;
	widgetRoute: string | null;
	sortOrder: number | null;
	/**
	 * Derived server-side by the same resolver the MCP edge enforces with.
	 * Absent means "not reported", which is NOT the same as an empty array —
	 * empty means the tool genuinely requires no scope.
	 */
	requiredScopes?: string[];
}

interface AdapterRowData {
	id: string;
	name: string;
	displayName: string | null;
	adapterType: string;
	enabled: boolean | null;
	priority: number | null;
}

type AppToolsListResponse = Awaited<ReturnType<typeof osApi.appTools.list>>;

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
			// The Overview tab renders the same rows via apps.getByIdWithTools.
			queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() });
		},
		onSuccess: (_data, checked) => {
			toast.success(`${tool.title} ${checked ? "enabled" : "disabled"}`);
		},
	});

	return (
		<li className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-kumo-tint">
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
			<Switch
				className="shrink-0"
				aria-label={`${isEnabled ? "Disable" : "Enable"} ${tool.title}`}
				checked={isEnabled}
				onCheckedChange={(checked) => toggleMutation.mutate(checked)}
				disabled={!canManage || toggleMutation.isPending}
				title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
			/>
		</li>
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
		<li className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-kumo-tint">
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
			<Switch
				className="shrink-0"
				aria-label={`${isEnabled ? "Disable" : "Enable"} ${adapterLabel}`}
				checked={isEnabled}
				onCheckedChange={(checked) => toggleMutation.mutate(checked)}
				disabled={!canManage || toggleMutation.isPending}
				title={canManage ? undefined : APPS_MANAGE_DENIED_REASON}
			/>
		</li>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AppToolsPage() {
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";
	const canManage = useCanManageApps();
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
	const visibleTools = toolRows;

	return (
		<div className="grid gap-6">
			<PageSection aria-labelledby="app-tools-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="app-tools-title">MCP tools</SectionTitle>
						<SectionDescription>
							Capabilities served through this app's MCP endpoint.
						</SectionDescription>
					</SectionHeading>
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
				</SectionHeader>
				{tools.isPending && <ListSkeleton />}
				{tools.isError && (
					<Alert variant="destructive">
						<AlertTitle>Tools are unavailable</AlertTitle>
						<AlertDescription>
							{(tools.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
				{/*
				 * One empty state, two claims. Only the unfiltered branch may say the
				 * app has no tools, and it can only be reached when the server's
				 * exact `total` is zero; a search that found nothing reports its own
				 * reach instead of the app's inventory.
				 */}
				{tools.data && visibleTools.length === 0 && (
					<Empty appearance="quiet">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Wrench size={20} />
							</EmptyMedia>
							<EmptyTitle>
								{deferredToolQuery
									? "No matching tools"
									: "No MCP tools configured"}
							</EmptyTitle>
							<EmptyDescription>
								{deferredToolQuery
									? `No tool in this app's ${inventoryTotal}-tool inventory matches this search.`
									: "No MCP tools configured for this app."}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
				{visibleTools.length > 0 && (
					<Collection>
						{visibleTools.map((tool) => (
							<ToolRow
								key={tool.id}
								tool={tool}
								appId={appId}
								canManage={canManage}
								listKey={toolsQueryOptions.queryKey}
							/>
						))}
					</Collection>
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

			<PageSection aria-labelledby="app-adapters-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="app-adapters-title">Adapters</SectionTitle>
						<SectionDescription>
							Execution adapters available to route tool calls.
						</SectionDescription>
					</SectionHeading>
					<Badge variant="secondary">
						{adapters.data
							? adapterRows.filter((adapter) => adapter.enabled !== false)
									.length
							: "—"}
					</Badge>
				</SectionHeader>
				{adapters.isPending && <ListSkeleton rows={2} />}
				{adapters.isError && (
					<Alert variant="destructive">
						<AlertTitle>Adapters are unavailable</AlertTitle>
						<AlertDescription>
							{(adapters.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
				{adapters.data && adapterRows.length === 0 && (
					<Empty appearance="quiet">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Plugs size={20} />
							</EmptyMedia>
							<EmptyTitle>No adapters configured</EmptyTitle>
							<EmptyDescription>
								No adapters configured for this app.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
				{adapterRows.length > 0 && (
					<Collection>
						{adapterRows.map((adapter) => (
							<AdapterRow
								key={adapter.id}
								adapter={adapter}
								appId={appId}
								canManage={canManage}
							/>
						))}
					</Collection>
				)}
			</PageSection>
		</div>
	);
}

"use client";

import {
	createColumnHelper,
	createSortedRowModel,
	flexRender,
	rowSortingFeature,
	sortFn_alphanumeric,
	sortFn_text,
	type SortingState,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import type { CatalogMcpToolWithMetrics } from "@tedix/api-contract/schemas/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

interface ToolsTableProps {
	tools: CatalogMcpToolWithMetrics[];
	toolsUrl?: string;
}

type ToolRow = CatalogMcpToolWithMetrics;

// Sorting is the only table feature this view uses — filtering is done ahead of
// the table in `filteredTools`, so registering more would only cost bundle. The
// two sort fns are the ones `auto` resolution can pick for these string columns
// (`alphanumeric` for names like `list_skills`, `text` for prose); unregistered
// names silently fall back to `basic`.
const features = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});

const columnHelper = createColumnHelper<typeof features, ToolRow>();

function formatLatency(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelativeTime(dateString: string | null): string {
	if (!dateString) return "—";
	try {
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return "Just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return date.toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch {
		return "—";
	}
}

function getSuccessBadge(
	successRatePercent: number | null,
	hasBeenTested: boolean,
) {
	if (!hasBeenTested || successRatePercent === null) {
		return { label: "Not tested", variant: "outline" as const };
	}
	if (successRatePercent >= 90)
		return {
			label: `${successRatePercent.toFixed(0)}%`,
			variant: "success" as const,
		};
	if (successRatePercent >= 50)
		return {
			label: `${successRatePercent.toFixed(0)}%`,
			variant: "secondary" as const,
		};
	return {
		label: `${successRatePercent.toFixed(0)}%`,
		variant: "destructive" as const,
	};
}

function hasToolDetails(tool: ToolRow): boolean {
	return (
		Boolean(tool.exampleInput) ||
		Boolean(tool.exampleOutput) ||
		Boolean(tool.inputSchema)
	);
}

function ToolFlags({
	tool,
	fallback = null,
}: {
	tool: ToolRow;
	fallback?: ReactNode;
}) {
	const hasReadOnly = Boolean(tool.annotations?.readOnlyHint);
	const hasDestructive = Boolean(tool.annotations?.destructiveHint);
	if (!hasReadOnly && !hasDestructive) return fallback;
	return (
		<div className="flex flex-wrap gap-2">
			{hasReadOnly && (
				<Badge variant="secondary" className="text-[10px]">
					read-only
				</Badge>
			)}
			{hasDestructive && (
				<Badge variant="destructive" className="text-[10px]">
					destructive
				</Badge>
			)}
		</div>
	);
}

function ToolTestBadge({ tool }: { tool: ToolRow }) {
	const successRatePercent =
		tool.testSuccessRate !== null ? tool.testSuccessRate * 100 : null;
	const hasBeenTested = (tool.testCount ?? 0) > 0;
	const badge = getSuccessBadge(successRatePercent, hasBeenTested);
	return <Badge variant={badge.variant}>{badge.label}</Badge>;
}

function ToolDetails({ tool }: { tool: ToolRow }) {
	return (
		<div className="grid gap-4 md:grid-cols-2">
			{tool.exampleInput && (
				<div>
					<p className="mb-2 font-medium text-muted-foreground text-xs">
						Example Input
					</p>
					<pre className="max-h-40 overflow-x-auto rounded-lg border border-border/60 bg-background p-3 text-xs">
						{JSON.stringify(tool.exampleInput, null, 2)}
					</pre>
				</div>
			)}
			{!!tool.exampleOutput && (
				<div>
					<p className="mb-2 font-medium text-muted-foreground text-xs">
						Example Output
					</p>
					<pre className="max-h-40 overflow-x-auto rounded-lg border border-border/60 bg-background p-3 text-xs">
						{typeof tool.exampleOutput === "string"
							? tool.exampleOutput
							: JSON.stringify(tool.exampleOutput, null, 2)}
					</pre>
				</div>
			)}
			{tool.inputSchema && (
				<div className="md:col-span-2">
					<p className="mb-2 font-medium text-muted-foreground text-xs">
						Input Schema
					</p>
					<pre className="max-h-56 overflow-x-auto rounded-lg border border-border/60 bg-background p-3 text-xs">
						{JSON.stringify(tool.inputSchema, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}

function ToolCard({
	tool,
	expanded,
	onToggle,
}: {
	tool: ToolRow;
	expanded: boolean;
	onToggle: () => void;
}) {
	const detailsId = `tool-details-${tool.id}`;
	const hasDetails = hasToolDetails(tool);
	return (
		<li className="rounded-lg border border-border/50 p-3">
			<div className="flex items-start justify-between gap-3">
				<code className="break-all font-mono font-semibold text-foreground text-sm">
					{tool.toolName}
				</code>
				<ToolFlags tool={tool} />
			</div>
			<span className="mt-1.5 line-clamp-3 block text-muted-foreground text-sm">
				{tool.description ?? "No description provided"}
			</span>
			<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
				<ToolTestBadge tool={tool} />
				{tool.avgLatencyMs !== null && (
					<span>Latency {formatLatency(tool.avgLatencyMs)}</span>
				)}
				<span>Tested {formatRelativeTime(tool.lastTestedAt)}</span>
			</div>
			{hasDetails && (
				<>
					<Button
						variant="outline"
						size="sm"
						className="mt-3 w-full"
						aria-expanded={expanded}
						aria-controls={detailsId}
						onClick={onToggle}
					>
						{expanded ? "Hide details" : "Details"}
					</Button>
					{expanded && (
						<div id={detailsId} className="mt-3">
							<ToolDetails tool={tool} />
						</div>
					)}
				</>
			)}
		</li>
	);
}

export default function ToolsTable({
	tools: initialTools,
	toolsUrl,
}: ToolsTableProps) {
	const [tools, setTools] = useState(initialTools);
	const [visibleCount, setVisibleCount] = useState(10);
	const [detailsError, setDetailsError] = useState(false);
	useEffect(() => {
		if (!toolsUrl) return;
		const controller = new AbortController();
		fetch(toolsUrl, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error("Tool details unavailable");
				setTools(await response.json());
			})
			.catch(() => {
				if (!controller.signal.aborted) setDetailsError(true);
			});
		return () => controller.abort();
	}, [toolsUrl]);
	const [search, setSearch] = useState("");
	const [showTested, setShowTested] = useState(false);
	const [showReadOnly, setShowReadOnly] = useState(false);
	const [showDestructive, setShowDestructive] = useState(false);
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "toolName", desc: false },
	]);
	const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

	const filteredTools = useMemo(() => {
		const query = search.trim().toLowerCase();
		return tools.filter((tool) => {
			const name = tool.toolName.toLowerCase();
			const desc = (tool.description ?? "").toLowerCase();
			const matchesQuery =
				!query || name.includes(query) || desc.includes(query);
			const hasBeenTested = (tool.testCount ?? 0) > 0;
			const matchesTested = !showTested || hasBeenTested;
			const matchesReadOnly =
				!showReadOnly || Boolean(tool.annotations?.readOnlyHint);
			const matchesDestructive =
				!showDestructive || Boolean(tool.annotations?.destructiveHint);
			return (
				matchesQuery && matchesTested && matchesReadOnly && matchesDestructive
			);
		});
	}, [tools, search, showTested, showReadOnly, showDestructive]);

	const columns = useMemo(
		() =>
			columnHelper.columns([
				columnHelper.accessor("toolName", {
					header: "Tool",
					cell: (info) => (
						<div className="flex min-w-0 items-center gap-2">
							<code className="break-all font-mono font-semibold text-foreground text-sm">
								{info.getValue()}
							</code>
						</div>
					),
				}),
				columnHelper.accessor("description", {
					header: "Description",
					cell: (info) => (
						<span className="block text-muted-foreground">
							{info.getValue() ?? "No description provided"}
						</span>
					),
				}),
				columnHelper.display({
					id: "flags",
					header: "Flags",
					cell: ({ row }) => (
						<ToolFlags
							tool={row.original}
							fallback={
								<span className="text-muted-foreground text-xs">—</span>
							}
						/>
					),
				}),
				columnHelper.display({
					id: "test",
					header: "Test",
					cell: ({ row }) => {
						const tool = row.original;
						return (
							<div className="flex flex-col gap-1">
								<ToolTestBadge tool={tool} />
								{tool.avgLatencyMs !== null && (
									<span className="text-muted-foreground text-xs">
										Latency {formatLatency(tool.avgLatencyMs)}
									</span>
								)}
							</div>
						);
					},
				}),
				columnHelper.accessor("lastTestedAt", {
					header: "Last Tested",
					cell: (info) => (
						<span className="text-muted-foreground">
							{formatRelativeTime(info.getValue())}
						</span>
					),
				}),
				columnHelper.display({
					id: "details",
					header: "",
					cell: ({ row }) => {
						const tool = row.original;
						const isExpanded = expandedRowId === tool.id;

						if (!hasToolDetails(tool))
							return <span className="text-muted-foreground text-xs">—</span>;

						return (
							<Button
								size="xs"
								variant="ghost"
								aria-expanded={isExpanded}
								onClick={() => setExpandedRowId(isExpanded ? null : tool.id)}
							>
								{isExpanded ? "Hide" : "Details"}
							</Button>
						);
					},
				}),
			]),
		[expandedRowId],
	);

	const table = useTable({
		features,
		data: filteredTools,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
	});

	const visibleRows = table.getRowModel().rows.slice(0, visibleCount);
	const sortValue = `${sorting[0]?.id ?? "toolName"}:${sorting[0]?.desc ? "desc" : "asc"}`;

	return (
		<Card className="min-w-0">
			<CardContent className="p-2">
				<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
					<div>
						<h2 className="flex items-center gap-2 font-semibold text-xl">
							Tools
							<span className="font-normal text-base text-muted-foreground">
								({tools.length})
							</span>
						</h2>
						<p className="text-muted-foreground text-xs">
							Showing {filteredTools.length} of {tools.length} tools
						</p>
					</div>
					<div className="text-muted-foreground text-xs">
						Sorted by{" "}
						<span className="font-medium text-foreground">
							{table.state.sorting[0]?.id ?? "tool"}
						</span>
					</div>
				</div>

				<div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
					<div className="flex-1">
						<Input
							aria-label="Filter tools by name or description"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Filter by tool name or description"
						/>
					</div>
					<div className="flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
						<label className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1">
							<Checkbox
								aria-label="Show tested tools"
								checked={showTested}
								onCheckedChange={(value) => setShowTested(Boolean(value))}
							/>
							Tested
						</label>
						<label className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1">
							<Checkbox
								aria-label="Show read-only tools"
								checked={showReadOnly}
								onCheckedChange={(value) => setShowReadOnly(Boolean(value))}
							/>
							Read-only
						</label>
						<label className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1">
							<Checkbox
								aria-label="Show destructive tools"
								checked={showDestructive}
								onCheckedChange={(value) => setShowDestructive(Boolean(value))}
							/>
							Destructive
						</label>
					</div>
					<div className="md:hidden">
						<label htmlFor="tools-sort" className="sr-only">
							Sort tools
						</label>
						<Select
							id="tools-sort"
							aria-label="Sort tools"
							value={sortValue}
							onValueChange={(value) => {
								if (!value) return;
								const [id, dir] = value.split(":");
								setSorting([{ id, desc: dir === "desc" }]);
							}}
						>
							<Select.Option value="toolName:asc">Name A-Z</Select.Option>
							<Select.Option value="toolName:desc">Name Z-A</Select.Option>
							<Select.Option value="description:asc">
								Description A-Z
							</Select.Option>
							<Select.Option value="description:desc">
								Description Z-A
							</Select.Option>
							<Select.Option value="lastTestedAt:desc">
								Recently tested
							</Select.Option>
							<Select.Option value="lastTestedAt:asc">
								Least recently tested
							</Select.Option>
						</Select>
					</div>
				</div>

				<div className="hidden max-w-full overflow-x-auto rounded-lg border border-border/50 md:block">
					<Table className="min-w-[760px] table-fixed">
						<TableHeader className="bg-muted/40">
							{table.getHeaderGroups().map((headerGroup) => (
								<TableRow key={headerGroup.id}>
									{headerGroup.headers.map((header) => (
										<TableHead
											key={header.id}
											className={cn(
												"text-muted-foreground text-xs uppercase tracking-wide",
												header.column.id === "toolName" && "w-[22%]",
												header.column.id === "description" && "w-[38%]",
												header.column.id === "flags" && "w-[14%]",
												header.column.id === "test" && "w-[12%]",
												header.column.id === "lastTestedAt" && "w-[10%]",
												header.column.id === "details" && "w-[4%]",
											)}
										>
											{header.isPlaceholder ? null : header.column.getCanSort() ? (
												<Button
													variant="ghost"
													size="xs"
													className="-ml-2 uppercase"
													onClick={header.column.getToggleSortingHandler()}
												>
													{flexRender(
														header.column.columnDef.header,
														header.getContext(),
													)}
												</Button>
											) : (
												flexRender(
													header.column.columnDef.header,
													header.getContext(),
												)
											)}
										</TableHead>
									))}
								</TableRow>
							))}
						</TableHeader>
						<TableBody>
							{visibleRows.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={table.getAllColumns().length}
										className="py-6 text-center text-muted-foreground"
									>
										No tools match the current filters.
									</TableCell>
								</TableRow>
							) : (
								visibleRows.map((row) => (
									<Fragment key={row.id}>
										<TableRow key={row.id} className="border-border/40">
											{row.getAllCells().map((cell) => (
												<TableCell
													key={cell.id}
													className={cn(
														"align-top",
														cell.column.id === "description" &&
															"whitespace-normal break-words leading-relaxed",
														cell.column.id === "toolName" &&
															"whitespace-normal break-words",
														cell.column.id === "flags" && "whitespace-normal",
													)}
												>
													{flexRender(
														cell.column.columnDef.cell,
														cell.getContext(),
													)}
												</TableCell>
											))}
										</TableRow>
										{expandedRowId === row.original.id && (
											<TableRow className="bg-muted/30">
												<TableCell
													colSpan={table.getAllColumns().length}
													className="p-4"
												>
													<ToolDetails tool={row.original} />
												</TableCell>
											</TableRow>
										)}
									</Fragment>
								))
							)}
						</TableBody>
					</Table>
				</div>

				{/* Compact list below md; the 760px table stays desktop-only. */}
				<ul className="space-y-2 md:hidden">
					{visibleRows.length === 0 ? (
						<li className="rounded-lg border border-border/50 px-3 py-6 text-center text-muted-foreground text-sm">
							No tools match the current filters.
						</li>
					) : (
						visibleRows.map((row) => (
							<ToolCard
								key={row.id}
								tool={row.original}
								expanded={expandedRowId === row.original.id}
								onToggle={() =>
									setExpandedRowId(
										expandedRowId === row.original.id ? null : row.original.id,
									)
								}
							/>
						))
					)}
				</ul>
				{filteredTools.length > visibleCount && (
					<Button
						variant="outline"
						onClick={() => setVisibleCount((count) => count + 10)}
					>
						Show more tools ({Math.min(visibleCount, filteredTools.length)} of{" "}
						{filteredTools.length})
					</Button>
				)}
				{detailsError && (
					<p role="status">
						Tool schemas and examples could not load. Reload to try again.
					</p>
				)}
			</CardContent>
		</Card>
	);
}

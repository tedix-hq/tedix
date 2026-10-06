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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Fragment, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

interface ToolsTableProps {
	tools: CatalogMcpToolWithMetrics[];
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

export default function ToolsTable({ tools }: ToolsTableProps) {
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
					cell: ({ row }) => {
						const tool = row.original;
						const hasReadOnly = Boolean(tool.annotations?.readOnlyHint);
						const hasDestructive = Boolean(tool.annotations?.destructiveHint);
						if (!hasReadOnly && !hasDestructive) {
							return <span className="text-muted-foreground text-xs">—</span>;
						}
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
					},
				}),
				columnHelper.display({
					id: "test",
					header: "Test",
					cell: ({ row }) => {
						const tool = row.original;
						const successRatePercent =
							tool.testSuccessRate !== null ? tool.testSuccessRate * 100 : null;
						const hasBeenTested = (tool.testCount ?? 0) > 0;
						const badge = getSuccessBadge(successRatePercent, hasBeenTested);
						return (
							<div className="flex flex-col gap-1">
								<Badge variant={badge.variant}>{badge.label}</Badge>
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
						const hasDetails =
							Boolean(tool.exampleInput) ||
							Boolean(tool.exampleOutput) ||
							Boolean(tool.inputSchema);

						if (!hasDetails)
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
				</div>

				<div className="max-w-full overflow-x-auto rounded-lg border border-border/50">
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
							{table.getRowModel().rows.map((row) => (
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
												<div className="grid gap-4 md:grid-cols-2">
													{row.original.exampleInput && (
														<div>
															<p className="mb-2 font-medium text-muted-foreground text-xs">
																Example Input
															</p>
															<pre className="max-h-40 overflow-x-auto rounded-lg border border-border/60 bg-background p-3 text-xs">
																{JSON.stringify(
																	row.original.exampleInput,
																	null,
																	2,
																)}
															</pre>
														</div>
													)}
													{!!row.original.exampleOutput && (
														<div>
															<p className="mb-2 font-medium text-muted-foreground text-xs">
																Example Output
															</p>
															<pre className="max-h-40 overflow-x-auto rounded-lg border border-border/60 bg-background p-3 text-xs">
																{typeof row.original.exampleOutput === "string"
																	? row.original.exampleOutput
																	: JSON.stringify(
																			row.original.exampleOutput,
																			null,
																			2,
																		)}
															</pre>
														</div>
													)}
													{row.original.inputSchema && (
														<div className="md:col-span-2">
															<p className="mb-2 font-medium text-muted-foreground text-xs">
																Input Schema
															</p>
															<pre className="max-h-56 overflow-x-auto rounded-lg border border-border/60 bg-background p-3 text-xs">
																{JSON.stringify(
																	row.original.inputSchema,
																	null,
																	2,
																)}
															</pre>
														</div>
													)}
												</div>
											</TableCell>
										</TableRow>
									)}
								</Fragment>
							))}
						</TableBody>
					</Table>
				</div>
			</CardContent>
		</Card>
	);
}

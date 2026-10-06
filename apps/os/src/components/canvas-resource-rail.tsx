import { MagnifyingGlass } from "@phosphor-icons/react";
import type { OsOutputLibraryItem } from "@tedix/api-contract/schemas/os-workspaces";
import { type ReactNode, useState } from "react";
import { OutputPreview } from "@/components/output-preview";
import { CreateDocumentButton } from "@/components/create-document-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { ListSkeleton } from "@/components/list-skeleton";
import { Input } from "@/components/kumo/input";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Text } from "@/components/kumo/text";
import {
	deliveryBadgeLabel,
	groupDeliverables,
	matchesStateFilter,
	type OutputStateFilter,
	outputStateCounts,
} from "@/lib/canvas-deliverables";
import type { CanvasDocSelection } from "@/lib/canvas-search";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { cn } from "@/lib/utils";

/**
 * The Canvas resource rail: workspace gadget/output pickers over the shell's
 * canonical list queries. Purely presentational — the queries, selection
 * state, and URL writes stay in canvas-page.tsx, so the rail renders whatever
 * cache entries the shell already owns.
 */

/** The slice of a TanStack list query the rail renders; structural on purpose. */
type ResourceListQuery<TItem> = {
	isPending: boolean;
	isError: boolean;
	error: unknown;
	data: { items: TItem[] } | undefined;
};

const CanvasIcon = SURFACE_ICONS.workspaces;

function fileLabel(item: OsOutputLibraryItem) {
	const label = deliveryBadgeLabel(item);
	return label
		.replace(/^revise/, "Needs changes")
		.replace(/^pass/, "Passed review")
		.replace(/^reject/, "Rejected")
		.replace(/^candidate/, "Draft")
		.replace(/^approved/, "Approved")
		.replace(/^document$/, "Document")
		.replace(/^sheet$/, "Spreadsheet")
		.replace(/^presentation$/, "Slides")
		.replace(/^video$/, "Video");
}

function sourceLabel(value: string) {
	if (value === "github") return "GitHub";
	return value
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function DocButton({
	selected,
	onSelect,
	children,
	item,
}: {
	selected: boolean;
	onSelect: () => void;
	children: ReactNode;
	item?: OsOutputLibraryItem;
}) {
	return (
		<Button
			disabled={item?.preview.kind === "unavailable"}
			aria-current={selected || undefined}
			multiline
			onClick={onSelect}
			size="sm"
			variant={selected ? "secondary" : "ghost"}
			className={cn(
				"w-full min-w-0 justify-start overflow-hidden px-3 py-2 text-left",
				item &&
					"h-auto flex-col items-stretch rounded-xl border border-kumo-line p-0",
				/*
				 * Selection paints the solid control step, not the tint. Tint is the
				 * hover token, and the type badge on the right is ALSO tint — so a
				 * tinted row made that badge vanish, leaving the selected row the
				 * only one without a visible chip. This is the same rule the shell
				 * nav follows.
				 */
				selected && "bg-kumo-control",
			)}
		>
			{item ? (
				<>
					<div
						data-workspace-output-preview
						className="h-36 w-full overflow-hidden border-b border-kumo-line"
					>
						<OutputPreview preview={item.preview} />
					</div>
					<span className="flex w-full min-w-0 flex-wrap items-center gap-2 p-3">
						{children}
					</span>
				</>
			) : (
				children
			)}
		</Button>
	);
}

export function CanvasResourceRail({
	workspaces,
	workspaceId,
	gadgets,
	outputs,
	resources,
	selectedDoc,
	onSelectGadget,
	onSelectOutput,
}: {
	workspaces: ResourceListQuery<{ id: string }>;
	workspaceId: string | null;
	gadgets: ResourceListQuery<{ id: string; name: string }>;
	outputs: ResourceListQuery<OsOutputLibraryItem>;
	resources: ResourceListQuery<{
		id: string;
		name: string;
		providerId: string;
		resourceType: string;
	}>;
	selectedDoc: CanvasDocSelection | null;
	onSelectGadget: (gadgetId: string) => void;
	onSelectOutput: (outputId: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [showHistory, setShowHistory] = useState(false);
	const [stateFilter, setStateFilter] = useState<OutputStateFilter>("active");
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const matches = (value: string) =>
		normalizedQuery.length === 0 ||
		value.toLocaleLowerCase().includes(normalizedQuery);
	const shownResources =
		resources.data?.items.filter((item) =>
			matches(`${item.name} ${item.providerId} ${item.resourceType}`),
		) ?? [];
	const shownGadgets =
		gadgets.data?.items.filter((item) => matches(item.name)) ?? [];
	// Search first, then state. Chip counts are computed over the search-matched
	// set so each chip honors the search but ignores itself, and active +
	// archived always sums to all.
	const searchedOutputs =
		outputs.data?.items.filter((item) =>
			matches(`${item.output.title} ${fileLabel(item)}`),
		) ?? [];
	const stateCounts = outputStateCounts(searchedOutputs);
	const shownOutputs = searchedOutputs.filter((item) =>
		matchesStateFilter(item, stateFilter),
	);
	const {
		approved: approvedDelivery,
		latestCandidate,
		earlierIterations,
		references,
	} = groupDeliverables(shownOutputs);
	const visibleHistory = showHistory
		? earlierIterations
		: earlierIterations.slice(0, 5);

	return (
		<aside aria-label="Workspace library" className="canvas-resource-rail">
			<div className="canvas-resource-library">
				<header className="canvas-resource-library-header">
					<div>
						<h2>Resources</h2>
						<p>
							Start with a file below. Open it in the Editor to read or edit it,
							or use the conversation to ask for changes.
						</p>
					</div>
					{workspaceId && (
						<CreateDocumentButton
							workspaceId={workspaceId}
							onCreated={(output) => onSelectOutput(output.id)}
						/>
					)}
					<label className="canvas-resource-search">
						<span className="sr-only">Search workspace</span>
						<MagnifyingGlass aria-hidden size={16} />
						<Input
							aria-label="Search workspace"
							placeholder="Search this workspace"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
				</header>
				{workspaces.isPending && <ListSkeleton rows={2} rowClassName="h-9" />}
				{workspaces.isError && (
					<Alert variant="destructive">
						<AlertTitle>Workspaces are unavailable</AlertTitle>
						<AlertDescription>
							{(workspaces.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
				{workspaces.data && workspaces.data.items.length === 0 && (
					<Empty appearance="quiet">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<CanvasIcon size={20} />
							</EmptyMedia>
							<EmptyTitle>No workspaces yet</EmptyTitle>
							<EmptyDescription>
								Create a workspace to keep your files and conversations
								together.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)}
				{workspaces.data && workspaceId !== null && (
					<div className="canvas-resource-library-sections">
						<section className="canvas-resource-section canvas-resource-outputs">
							<SectionEyebrow
								title="Files"
								count={shownOutputs.length}
								variant="console"
							/>
							{outputs.isPending && (
								<ListSkeleton rows={2} rowClassName="h-9" />
							)}
							{outputs.isError && (
								<Alert variant="destructive">
									<AlertTitle>Files are unavailable</AlertTitle>
									<AlertDescription>
										{(outputs.error as Error).message}
									</AlertDescription>
								</Alert>
							)}
							{outputs.data && stateCounts.all > 0 && (
								<div
									aria-label="Filter files by state"
									className="canvas-resource-state-filter"
									role="group"
								>
									{(
										[
											["active", "Active", stateCounts.active],
											["archived", "Archived", stateCounts.archived],
											["all", "All", stateCounts.all],
										] as const
									).map(([value, label, count]) => (
										<Button
											aria-pressed={stateFilter === value}
											key={value}
											onClick={() => setStateFilter(value)}
											size="sm"
											variant={stateFilter === value ? "secondary" : "ghost"}
										>
											{label}
											<span className="text-kumo-subtle">{count}</span>
										</Button>
									))}
								</div>
							)}
							{outputs.data && shownOutputs.length === 0 && (
								<Text as="p" role="label" tone="secondary" className="m-0">
									{normalizedQuery
										? "No files match your search."
										: stateFilter === "active" && stateCounts.archived > 0
											? `No active files. ${stateCounts.archived} archived.`
											: "No files in this workspace."}
								</Text>
							)}
							{outputs.data && !approvedDelivery && latestCandidate && (
								<Alert>
									<AlertTitle>No approved result yet</AlertTitle>
									<AlertDescription>
										Drafts still need a separate quality review before approval.
									</AlertDescription>
								</Alert>
							)}
							{outputs.data && approvedDelivery && (
								<>
									<p className="canvas-resource-group-label">Approved result</p>
									<ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
										{[approvedDelivery].map((item) => (
											<li key={item.output.id}>
												<DocButton
													item={item}
													selected={
														selectedDoc?.type === "output" &&
														selectedDoc.id === item.output.id
													}
													onSelect={() => onSelectOutput(item.output.id)}
												>
													<span className="min-w-0 flex-1 truncate">
														{item.output.title}
													</span>
													<Badge
														className="shrink-0"
														variant="secondary"
														data-kind={item.output.kind}
													>
														Approved
													</Badge>
												</DocButton>
											</li>
										))}
									</ul>
								</>
							)}
							{outputs.data && latestCandidate && (
								<>
									<p className="canvas-resource-group-label">Latest draft</p>
									<ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
										<li key={latestCandidate.output.id}>
											<DocButton
												item={latestCandidate}
												selected={
													selectedDoc?.type === "output" &&
													selectedDoc.id === latestCandidate.output.id
												}
												onSelect={() =>
													onSelectOutput(latestCandidate.output.id)
												}
											>
												<span className="min-w-0 flex-1 truncate">
													{latestCandidate.output.title}
												</span>
												<Badge className="shrink-0" variant="secondary">
													{fileLabel(latestCandidate)}
												</Badge>
											</DocButton>
										</li>
									</ul>
								</>
							)}
							{outputs.data && earlierIterations.length > 0 && (
								<details className="grid gap-3">
									<summary className="cursor-pointer text-kumo-subtle type-tedix-control">
										Previous drafts ({earlierIterations.length})
									</summary>
									<ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
										{visibleHistory.map((item) => (
											<li key={item.output.id}>
												<DocButton
													item={item}
													selected={
														selectedDoc?.type === "output" &&
														selectedDoc.id === item.output.id
													}
													onSelect={() => onSelectOutput(item.output.id)}
												>
													<span className="min-w-0 flex-1 truncate">
														{item.output.title}
													</span>
													<Badge
														className="shrink-0"
														data-kind={item.output.kind}
														variant="secondary"
													>
														{fileLabel(item)}
													</Badge>
												</DocButton>
											</li>
										))}
									</ul>
									{earlierIterations.length > 5 ? (
										<Button
											className="justify-start"
											size="sm"
											variant="ghost"
											onClick={() => setShowHistory((value) => !value)}
										>
											{showHistory
												? "Show fewer drafts"
												: `Show ${earlierIterations.length - 5} more drafts`}
										</Button>
									) : null}
								</details>
							)}
							{outputs.data && references.length > 0 && (
								<>
									<p className="canvas-resource-group-label">
										Documents and files
									</p>
									<ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
										{references.map((item) => (
											<li key={item.output.id}>
												<DocButton
													item={item}
													selected={
														selectedDoc?.type === "output" &&
														selectedDoc.id === item.output.id
													}
													onSelect={() => onSelectOutput(item.output.id)}
												>
													<span className="min-w-0 flex-1 truncate">
														{item.output.title}
													</span>
													<Badge
														className="shrink-0"
														data-kind={item.output.kind}
														variant="secondary"
													>
														{fileLabel(item)}
													</Badge>
												</DocButton>
											</li>
										))}
									</ul>
								</>
							)}
						</section>
						<section className="canvas-resource-section">
							<SectionEyebrow
								title="Connected sources"
								count={shownResources.length}
								variant="console"
							/>
							<Text as="p" role="label" tone="secondary" className="m-0">
								Accounts and files workers can use with permission. Manage them
								in an open file’s Connections tab.
							</Text>
							{resources.isPending && (
								<ListSkeleton rows={1} rowClassName="h-9" />
							)}
							{resources.isError && (
								<Text as="p" role="label" tone="error" className="m-0">
									Attached resources are unavailable.
								</Text>
							)}
							{resources.data && shownResources.length === 0 && (
								<Text as="p" role="label" tone="secondary" className="m-0">
									{normalizedQuery
										? "No sources match your search."
										: "No sources attached yet. Add one from a file’s Connections tab."}
								</Text>
							)}
							{resources.data && shownResources.length > 0 && (
								<ul className="m-0 grid list-none gap-0.5 p-0">
									{shownResources.map((resource) => (
										<li
											key={resource.id}
											className="min-w-0 rounded-md px-3 py-2 text-left"
										>
											<Text as="p" role="body" className="m-0 truncate">
												{resource.name}
											</Text>
											<Text
												as="p"
												role="label"
												tone="secondary"
												className="m-0 truncate"
											>
												{sourceLabel(resource.providerId)} ·{" "}
												{sourceLabel(resource.resourceType)}
											</Text>
										</li>
									))}
								</ul>
							)}
						</section>

						<section className="canvas-resource-section">
							<SectionEyebrow
								title="Automations"
								count={shownGadgets.length}
								variant="console"
							/>
							<Text as="p" role="label" tone="secondary" className="m-0">
								Open an automation to see what it does and choose when to run
								it.
							</Text>
							{gadgets.isPending && (
								<ListSkeleton rows={2} rowClassName="h-9" />
							)}
							{gadgets.isError && (
								<Alert variant="destructive">
									<AlertTitle>Automations are unavailable</AlertTitle>
									<AlertDescription>
										{(gadgets.error as Error).message}
									</AlertDescription>
								</Alert>
							)}
							{gadgets.data && shownGadgets.length === 0 && (
								<Text as="p" role="label" tone="secondary" className="m-0">
									{normalizedQuery
										? "No automations match your search."
										: "No active automations in this workspace."}
								</Text>
							)}
							{gadgets.data && shownGadgets.length > 0 && (
								<ul className="m-0 grid list-none gap-0.5 p-0">
									{shownGadgets.map((gadget) => (
										<li key={gadget.id}>
											<DocButton
												selected={
													(selectedDoc?.type === "gadget" &&
														selectedDoc.id === gadget.id) ||
													(selectedDoc?.type === "output" &&
														selectedDoc.linkedGadgetId === gadget.id)
												}
												onSelect={() => onSelectGadget(gadget.id)}
											>
												<span className="truncate">{gadget.name}</span>
											</DocButton>
										</li>
									))}
								</ul>
							)}
						</section>
					</div>
				)}
			</div>
		</aside>
	);
}

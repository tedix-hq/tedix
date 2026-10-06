import {
	Archive,
	ArrowSquareOut,
	CaretDown,
	Clock,
	DotsThree,
	FileText,
	FolderOpen,
	List as ListIcon,
	LockKey,
	PencilSimple,
	PresentationChart,
	ShareNetwork,
	SquaresFour,
	Table as TableIcon,
	User,
	VideoCamera,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
	OsOutputLibraryItem,
	OsOutputLibraryPreview,
} from "@tedix/api-contract/schemas/os-workspaces";
import { getOsSurface } from "@/lib/os-navigation";
import type { ComponentType, KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import * as z from "zod";
import { OutputPreview } from "@/components/output-preview";
import { CreateDocumentButton } from "@/components/create-document-dialog";
import { FormInput } from "@/components/forms/form-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { IconFrame } from "@/components/kumo/icon-frame";
import {
	Page,
	PageActions,
	PageDescription,
	PageHeader,
	PageHeading,
	PageToolbar,
	PageTitle,
} from "@/components/kumo/page";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { SearchInput } from "@/components/kumo/search-input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Surface } from "@/components/kumo/surface";
import { ListSkeleton } from "@/components/list-skeleton";
import { useOutputsWebMcpTools } from "@/components/outputs-webmcp-tools";
import { ShareControls } from "@/components/share-controls";
import { Tabs, TabsList, TabsTrigger } from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import {
	activeOutputLibraryQueryOptions,
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";
import { outputOpenAffordance } from "@/lib/output-navigation";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { absoluteTime, relativeTime } from "@/lib/time";

const KIND_ICONS: Record<
	"document" | "sheet" | "presentation" | "video",
	ComponentType<{ size?: number }>
> = {
	document: FileText,
	sheet: TableIcon,
	presentation: PresentationChart,
	video: VideoCamera,
};

const KIND_FILTERS = [
	"all",
	"document",
	"sheet",
	"presentation",
	"video",
] as const;
type KindFilter = (typeof KIND_FILTERS)[number];
type ScopeFilter = "all" | "mine" | "organization";
type Layout = "grid" | "list";
const LAYOUT_STORAGE_KEY = "tedix:outputs:layout:v1";
const OUTPUT_LIBRARY_PAGE_SIZE = 20;
type OutputLibraryData = {
	items: OsOutputLibraryItem[];
	truncated: boolean;
};

function kindLabel(kind: KindFilter): string {
	if (kind === "all") return "All";
	if (kind === "presentation") return "Slides";
	if (kind === "video") return "Videos";
	return kind === "document" ? "Documents" : "Sheets";
}

function initialLayout(): Layout {
	if (typeof window === "undefined") return "grid";
	try {
		return window.localStorage?.getItem(LAYOUT_STORAGE_KEY) === "list"
			? "list"
			: "grid";
	} catch {
		return "grid";
	}
}

function persistLayout(layout: Layout): void {
	try {
		window.localStorage?.setItem(LAYOUT_STORAGE_KEY, layout);
	} catch {
		// Storage can be disabled by privacy settings; layout still works in-memory.
	}
}

function creatorLabel(item: OsOutputLibraryItem): string {
	if (item.scope === "mine") return "Created by you";
	if (item.output.createdByKind === "tedi") return "Shared by a tedi";
	if (item.output.createdByKind === "external_agent")
		return "Shared by an agent";
	if (item.output.createdByKind === "service") return "Shared by automation";
	return "Shared by a teammate";
}

function workspaceLabel(item: OsOutputLibraryItem): string {
	if (!item.workspace) return "Organization output";
	return item.workspace.status === "archived"
		? `${item.workspace.name} · Archived workspace`
		: item.workspace.name;
}

function outputMetric(preview: OsOutputLibraryPreview): string {
	if (preview.kind === "unavailable") return "Source access unavailable";
	if (preview.kind === "document")
		return `${preview.blockCount} ${preview.blockCount === 1 ? "block" : "blocks"}`;
	if (preview.kind === "sheet")
		return `${preview.rowCount} rows · ${preview.sheetCount} ${preview.sheetCount === 1 ? "sheet" : "sheets"}`;
	if (preview.kind === "video") return "MP4 video";
	return `${preview.slideCount} ${preview.slideCount === 1 ? "slide" : "slides"}`;
}

function OutputMenu(props: {
	item: OsOutputLibraryItem;
	openMenuLabel: string;
	opensInWorkspace: boolean;
	onOpen: () => void;
	onOpenStandalone: () => void;
	onOpenWorkspace: () => void;
	onRename: () => void;
	onArchive: () => void;
	contentAvailable: boolean;
}) {
	return (
		<div
			className="output-card-actions flex shrink-0 items-center gap-1"
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
		>
			{props.contentAvailable ? (
				<ShareControls
					outputId={props.item.output.id}
					currentRevisionId={props.item.output.currentRevisionId}
					compact
				/>
			) : null}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={`Actions for ${props.item.output.title}`}
							size="icon-sm"
							variant="ghost"
						/>
					}
				>
					<DotsThree size={16} weight="bold" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{props.contentAvailable ? (
						<DropdownMenuItem onClick={props.onOpen}>
							{props.opensInWorkspace ? (
								<SquaresFour size={14} />
							) : (
								<ArrowSquareOut size={14} />
							)}{" "}
							{props.openMenuLabel}
						</DropdownMenuItem>
					) : null}
					{props.contentAvailable && props.opensInWorkspace ? (
						<>
							<DropdownMenuItem onClick={props.onOpenStandalone}>
								<ArrowSquareOut size={14} /> Open standalone
							</DropdownMenuItem>
							<DropdownMenuItem onClick={props.onOpenWorkspace}>
								<FolderOpen size={14} /> Open workspace
							</DropdownMenuItem>
						</>
					) : null}
					<DropdownMenuItem onClick={props.onRename}>
						<PencilSimple size={14} /> Rename
					</DropdownMenuItem>
					<DropdownMenuItem variant="destructive" onClick={props.onArchive}>
						<Archive size={14} /> Archive
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

interface OutputCardProps {
	item: OsOutputLibraryItem;
	layout: Layout;
	onOpen: () => void;
	onOpenStandalone: () => void;
	onOpenWorkspace: () => void;
	onRename: () => void;
	onArchive: () => void;
}

function OutputCard(props: OutputCardProps) {
	const { item } = props;
	const Icon = KIND_ICONS[item.output.kind];
	const provenance = workspaceLabel(item);
	const affordance = outputOpenAffordance(item);
	const contentAvailable = item.preview.kind !== "unavailable";
	const cardLabel = contentAvailable
		? affordance.cardLabel
		: `${item.output.title} — source access unavailable`;
	const menu = (
		<OutputMenu
			item={item}
			onArchive={props.onArchive}
			onOpen={props.onOpen}
			onOpenStandalone={props.onOpenStandalone}
			onOpenWorkspace={props.onOpenWorkspace}
			onRename={props.onRename}
			openMenuLabel={affordance.menuLabel}
			opensInWorkspace={affordance.target.kind === "workspace"}
			contentAvailable={contentAvailable}
		/>
	);
	const activate = (event: KeyboardEvent) => {
		if (!contentAvailable) return;
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			props.onOpen();
		}
	};
	if (props.layout === "list") {
		return (
			<li
				aria-label={cardLabel}
				role={contentAvailable ? "button" : undefined}
				tabIndex={contentAvailable ? 0 : undefined}
				aria-disabled={contentAvailable ? undefined : true}
				onClick={contentAvailable ? props.onOpen : undefined}
				onKeyDown={activate}
				className={`group flex min-h-16 items-center gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors motion-reduce:transition-none ${contentAvailable ? "cursor-pointer hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring" : "cursor-default"}`}
			>
				<IconFrame>
					<Icon size={18} />
				</IconFrame>
				<span className="grid min-w-0 flex-1 gap-0.5">
					<Text
						as="strong"
						role="body"
						weight="medium"
						tone="strong"
						className="truncate"
					>
						{item.output.title}
					</Text>
					<Text as="span" role="label" tone="secondary" className="truncate">
						{item.output.kind === "presentation"
							? "Slides"
							: kindLabel(item.output.kind)}{" "}
						· {provenance}
					</Text>
					{!contentAvailable ? (
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="inline-flex items-center gap-1"
						>
							<LockKey size={12} aria-hidden="true" /> Source access unavailable
						</Text>
					) : null}
				</span>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="hidden w-40 shrink-0 items-center gap-1 truncate lg:flex"
					title={`${creatorLabel(item)} (${item.output.createdByKind}:${item.output.createdById})`}
				>
					{item.scope === "mine" ? (
						<User size={12} />
					) : (
						<ShareNetwork size={12} />
					)}{" "}
					{creatorLabel(item)}
				</Text>
				{/* `as="time"` can't carry `dateTime` — Text's props are fixed to
				    span attributes regardless of `as`, so this stays a plain
				    element with the raw utilities. */}
				<time
					dateTime={item.output.updatedAt}
					title={absoluteTime(item.output.updatedAt)}
					className="hidden w-20 shrink-0 items-center justify-end gap-1 text-kumo-subtle text-xs sm:flex"
				>
					<Clock size={11} />
					{relativeTime(item.output.updatedAt)}
				</time>
				{menu}
			</li>
		);
	}
	return (
		<Surface
			aria-label={cardLabel}
			tier="panel"
			role={contentAvailable ? "button" : undefined}
			tabIndex={contentAvailable ? 0 : undefined}
			aria-disabled={contentAvailable ? undefined : true}
			onClick={contentAvailable ? props.onOpen : undefined}
			onKeyDown={activate}
			className={`output-grid-card group relative outline-none transition-[border-color] motion-reduce:transition-none ${contentAvailable ? "cursor-pointer hover:border-kumo-fill focus-visible:ring-2 focus-visible:ring-kumo-ring" : "cursor-default"}`}
			render={<li />}
		>
			<div
				data-slot="output-grid-preview"
				className="aspect-video overflow-hidden rounded-t-xl border-kumo-line border-b sm:aspect-[4/3]"
			>
				<OutputPreview preview={item.preview} />
			</div>
			<div className="flex items-center gap-2.5 px-3 py-2.5">
				<IconFrame size="sm">
					<Icon size={16} />
				</IconFrame>
				<span className="grid min-w-0 flex-1">
					<Text
						as="strong"
						tone="strong"
						role="control"
						truncate
						weight="medium"
					>
						{item.output.title}
					</Text>
					<Text as="span" tone="secondary" role="caption" truncate>
						{provenance} · {creatorLabel(item)}
					</Text>
					<span className="sr-only">
						{outputMetric(item.preview)}, updated{" "}
						{relativeTime(item.output.updatedAt)}
					</span>
				</span>
				{menu}
			</div>
		</Surface>
	);
}

function ScopeSelect(props: {
	value: ScopeFilter;
	counts: Record<ScopeFilter, number>;
	onChange: (value: ScopeFilter) => void;
}) {
	const labels: Record<ScopeFilter, string> = {
		all: "Yours and shared",
		mine: "Created by you",
		organization: "Shared in team",
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="secondary"
						className="w-full justify-between sm:w-auto"
					/>
				}
			>
				{props.value === "mine" ? (
					<User size={14} />
				) : (
					<ShareNetwork size={14} />
				)}
				{labels[props.value]}
				<CaretDown size={12} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{(["all", "mine", "organization"] as const).map((scope) => (
					<DropdownMenuItem key={scope} onClick={() => props.onChange(scope)}>
						<span className="min-w-32 flex-1">{labels[scope]}</span>
						<span className="tabular-nums text-kumo-inactive">
							{props.counts[scope]}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const renameOutputSchema = z.object({
	title: z.string().trim().min(1, "Enter an output title.").max(120),
});

function RenameDialog(props: {
	item: OsOutputLibraryItem | null;
	busy: boolean;
	error?: Error | null;
	onClose: () => void;
	onSave: (title: string) => void;
}) {
	const title = props.item?.output.title ?? "";
	const form = useZodForm({
		schema: renameOutputSchema,
		defaultValues: { title },
		onSubmit: ({ value }) => props.onSave(value.title),
	});
	useEffect(() => form.reset({ title }), [form, title]);
	return (
		<Dialog
			open={props.item !== null}
			onOpenChange={(open) => {
				if (!open && !props.busy) props.onClose();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void form.handleSubmit();
					}}
				>
					<DialogHeader>
						<DialogTitle>Rename output</DialogTitle>
						<DialogDescription>
							The title changes for every authorized organization member.
							Immutable revisions are unchanged.
						</DialogDescription>
					</DialogHeader>
					<FormField form={form} name="title" label="Output title">
						{(field, meta) => (
							<FormInput field={field} {...meta} autoFocus maxLength={120} />
						)}
					</FormField>
					{props.error ? (
						<Alert variant="destructive">
							<AlertTitle>Output not renamed</AlertTitle>
							<AlertDescription>{props.error.message}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={props.busy}
							onClick={props.onClose}
						>
							Cancel
						</Button>
						<Button type="submit" loading={props.busy} disabled={props.busy}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function ArchiveDialog(props: {
	item: OsOutputLibraryItem | null;
	busy: boolean;
	error?: Error | null;
	onClose: () => void;
	onConfirm: () => void;
}) {
	return (
		<Dialog
			open={props.item !== null}
			onOpenChange={(open) => {
				if (!open && !props.busy) props.onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Archive “{props.item?.output.title}”?</DialogTitle>
					<DialogDescription>
						This removes it from the active library. Its immutable revisions and
						audit provenance remain durable.
					</DialogDescription>
				</DialogHeader>
				{props.error ? (
					<Alert variant="destructive">
						<AlertTitle>Output not archived</AlertTitle>
						<AlertDescription>{props.error.message}</AlertDescription>
					</Alert>
				) : null}
				<DialogFooter>
					<Button
						variant="outline"
						disabled={props.busy}
						onClick={props.onClose}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						loading={props.busy}
						onClick={props.onConfirm}
					>
						Archive
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function OutputsPage() {
	useOutputsWebMcpTools();
	const surface = getOsSurface("outputs");
	const EmptyIcon = SURFACE_ICONS.outputs;
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState<KindFilter>("all");
	const [scope, setScope] = useState<ScopeFilter>("all");
	const [layout, setLayout] = useState<Layout>(initialLayout);
	const [visibleLimit, setVisibleLimit] = useState(OUTPUT_LIBRARY_PAGE_SIZE);
	const [renameTarget, setRenameTarget] = useState<OsOutputLibraryItem | null>(
		null,
	);
	const [archiveTarget, setArchiveTarget] =
		useState<OsOutputLibraryItem | null>(null);
	useEffect(() => persistLayout(layout), [layout]);
	const outputLibraryOptions = activeOutputLibraryQueryOptions();
	const outputs = useQuery({
		...outputLibraryOptions,
		retry: false,
	});
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
	const rename = useMutation({
		...osQuery.osWorkspaces.outputs.rename.mutationOptions(),
		onSuccess: ({ output }) => {
			queryClient.setQueryData<OutputLibraryData>(
				outputLibraryOptions.queryKey,
				(current) =>
					current
						? {
								...current,
								items: current.items.map((item) =>
									item.output.id === output.id ? { ...item, output } : item,
								),
							}
						: current,
			);
			setRenameTarget(null);
			void invalidate();
		},
	});
	const archive = useMutation({
		...osQuery.osWorkspaces.outputs.archive.mutationOptions(),
		onSuccess: ({ output }) => {
			queryClient.setQueryData<OutputLibraryData>(
				outputLibraryOptions.queryKey,
				(current) =>
					current
						? {
								...current,
								items: current.items.filter(
									(item) => item.output.id !== output.id,
								),
							}
						: current,
			);
			setArchiveTarget(null);
			void invalidate();
		},
	});
	const allItems = outputs.data?.items ?? [];
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const matchesSearch = (item: OsOutputLibraryItem) =>
		[
			item.output.title,
			item.workspace?.name ?? "",
			creatorLabel(item),
			item.output.kind,
		]
			.join(" ")
			.toLocaleLowerCase()
			.includes(normalizedQuery);
	const inKindScope = allItems.filter(
		(item) => (scope === "all" || item.scope === scope) && matchesSearch(item),
	);
	const inOwnerScope = allItems.filter(
		(item) =>
			(kind === "all" || item.output.kind === kind) && matchesSearch(item),
	);
	const visibleOutputs = inKindScope.filter(
		(item) => kind === "all" || item.output.kind === kind,
	);
	useEffect(() => {
		setVisibleLimit(OUTPUT_LIBRARY_PAGE_SIZE);
	}, [kind, normalizedQuery, scope]);
	const displayedOutputs = visibleOutputs.slice(0, visibleLimit);
	const hasMoreOutputs = displayedOutputs.length < visibleOutputs.length;
	const kindCounts = Object.fromEntries(
		KIND_FILTERS.map((filter) => [
			filter,
			filter === "all"
				? inKindScope.length
				: inKindScope.filter((item) => item.output.kind === filter).length,
		]),
	) as Record<KindFilter, number>;
	const scopeCounts: Record<ScopeFilter, number> = {
		all: inOwnerScope.length,
		mine: inOwnerScope.filter((item) => item.scope === "mine").length,
		organization: inOwnerScope.filter((item) => item.scope === "organization")
			.length,
	};
	const openStandaloneOutput = (item: OsOutputLibraryItem) =>
		void navigate({
			to: "/outputs/$outputId",
			params: { outputId: item.output.id },
		});
	const openOutput = (item: OsOutputLibraryItem) => {
		const { target } = outputOpenAffordance(item);
		if (target.kind === "workspace") {
			void navigate({
				to: "/workspace/$workspaceId",
				params: { workspaceId: target.workspaceId },
				search: target.search,
			});
			return;
		}
		openStandaloneOutput(item);
	};
	const openWorkspace = (item: OsOutputLibraryItem) => {
		if (item.workspace)
			void navigate({
				to: "/workspace/$workspaceId",
				params: { workspaceId: item.workspace.id },
			});
	};

	return (
		<Page width="lg" className="outputs-surface">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>{surface.description}</PageDescription>
				</PageHeading>
				<PageActions>
					<CreateDocumentButton
						onCreated={(output) => {
							if (output.workspaceId)
								void navigate({
									to: "/workspace/$workspaceId",
									params: { workspaceId: output.workspaceId },
									search: {
										pane: "workpiece",
										workpiece: `output:${output.id}`,
									},
								});
							else
								void navigate({
									to: "/outputs/$outputId",
									params: { outputId: output.id },
								});
						}}
					/>
					<SegmentedControl
						ariaLabel="Layout"
						className="[&_button]:size-8 [&_button]:px-0 coarse:[&_button]:size-11"
						compact
						value={layout}
						onValueChange={setLayout}
						options={[
							{
								value: "list",
								label: (
									<>
										<ListIcon size={16} />
										<span className="sr-only">List view</span>
									</>
								),
							},
							{
								value: "grid",
								label: (
									<>
										<SquaresFour size={16} />
										<span className="sr-only">Grid view</span>
									</>
								),
							},
						]}
					/>
				</PageActions>
			</PageHeader>
			<PageToolbar aria-label="Output library controls">
				<Tabs
					className="w-full min-w-0 max-w-full shrink"
					value={kind}
					onValueChange={(value) => setKind(value as KindFilter)}
				>
					<TabsList aria-label="Filter by type" variant="filter">
						{KIND_FILTERS.map((filter) => (
							<TabsTrigger key={filter} value={filter} className="group">
								<span className="flex items-center gap-1.5">
									<span>{kindLabel(filter)} </span>
									<span className="tabular-nums text-kumo-inactive group-aria-selected:text-kumo-subtle">
										{kindCounts[filter]}
									</span>
								</span>
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<div className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:items-center lg:w-auto lg:shrink-0">
					<ScopeSelect value={scope} counts={scopeCounts} onChange={setScope} />
					<SearchInput
						containerClassName="w-full min-w-0 sm:w-60"
						aria-label="Search outputs"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search outputs"
					/>
				</div>
			</PageToolbar>

			{outputs.isPending ? <ListSkeleton /> : null}
			{outputs.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Outputs are unavailable</AlertTitle>
					<AlertDescription>
						<span>{(outputs.error as Error).message}</span>
						<Button
							variant="outline"
							size="sm"
							className="mt-2 w-fit"
							disabled={outputs.isFetching}
							onClick={() => void outputs.refetch()}
						>
							{outputs.isFetching ? "Trying again…" : "Try again"}
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			{outputs.data && visibleOutputs.length === 0 ? (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<EmptyIcon size={20} />
						</EmptyMedia>
						<EmptyTitle>
							{allItems.length === 0 ? "No outputs yet" : "No matching outputs"}
						</EmptyTitle>
						<EmptyDescription>
							{allItems.length === 0
								? "Create a document from a blank page or a template. Documents, sheets, and presentations created with your tedi also appear here."
								: "Try another search, format, or sharing scope."}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : null}
			{visibleOutputs.length > 0 ? (
				<ul
					className={
						layout === "grid"
							? "m-0 grid grid-cols-1 list-none gap-3 p-0 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
							: "m-0 grid list-none gap-1 p-0"
					}
				>
					{displayedOutputs.map((item) => (
						<OutputCard
							key={item.output.id}
							item={item}
							layout={layout}
							onOpen={() => openOutput(item)}
							onOpenStandalone={() => openStandaloneOutput(item)}
							onOpenWorkspace={() => openWorkspace(item)}
							onRename={() => {
								rename.reset();
								setRenameTarget(item);
							}}
							onArchive={() => {
								archive.reset();
								setArchiveTarget(item);
							}}
						/>
					))}
				</ul>
			) : null}
			{visibleOutputs.length > OUTPUT_LIBRARY_PAGE_SIZE ? (
				<div
					className="flex min-h-11 items-center justify-between gap-3 border-kumo-hairline border-t pt-3"
					aria-live="polite"
				>
					<Text role="label" tone="secondary">
						Showing {displayedOutputs.length} of {visibleOutputs.length} outputs
					</Text>
					{hasMoreOutputs ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="max-sm:min-h-11"
							onClick={() =>
								setVisibleLimit((limit) => limit + OUTPUT_LIBRARY_PAGE_SIZE)
							}
						>
							Show more
						</Button>
					) : null}
				</div>
			) : null}
			{outputs.data?.truncated ? (
				<Text role="label" tone="secondary" className="text-center">
					Showing the 200 most recently updated outputs.
				</Text>
			) : null}
			<RenameDialog
				item={renameTarget}
				busy={rename.isPending}
				error={rename.error}
				onClose={() => setRenameTarget(null)}
				onSave={(title) =>
					renameTarget &&
					rename.mutate({ outputId: renameTarget.output.id, title })
				}
			/>
			<ArchiveDialog
				item={archiveTarget}
				busy={archive.isPending}
				error={archive.error}
				onClose={() => setArchiveTarget(null)}
				onConfirm={() =>
					archiveTarget && archive.mutate({ outputId: archiveTarget.output.id })
				}
			/>
		</Page>
	);
}

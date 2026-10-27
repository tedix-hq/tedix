import "./outputs-page.css";
import { useLibraryApps } from "@/lib/use-library-apps";
import { WorkspaceAppCard } from "@/components/workspace-app-cards";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
	Archive,
	ArrowCounterClockwise,
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
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import * as z from "zod";
import { OutputPreview } from "@/components/output-preview";
import { NewResourceMenu } from "@/components/create-document-dialog";
import { FormInput } from "@/components/forms/form-input";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
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
import { ResourceCard } from "@/components/resource-card";
import { ListSkeleton } from "@/components/list-skeleton";
import { useOutputsWebMcpTools } from "@/components/outputs-webmcp-tools";
import { ShareDialog } from "@/components/share-controls";
import { Tabs, TabsList, TabsTrigger } from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import {
	activeOutputLibraryQueryOptions,
	archivedOutputLibraryQueryOptions,
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";
import { outputOpenAffordance } from "@/lib/output-navigation";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { useOsFormattingPreferences } from "@/lib/format";
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

/** The type tabs, then Archived: every archived output, whatever its type. */
const KIND_FILTERS = [
	"all",
	"document",
	"sheet",
	"presentation",
	"video",
	"app",
	"archived",
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
	if (kind === "app") return "Apps";
	if (kind === "archived") return "Archived";
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

type OutputActions = {
	onOpen: () => void;
	onOpenStandalone: () => void;
	onOpenWorkspace: () => void;
	onRename: () => void;
	onShare: () => void;
	onArchive: () => void;
	onRestore: () => void;
};

/**
 * Open, then ⋯ with everything else. Open's ::after covers the whole card so
 * a click anywhere opens it; only the ⋯ trigger is lifted above that layer,
 * which is why Share lives in the menu and not as a button beside Open.
 */
function OutputMenu(props: OutputActions & { item: OsOutputLibraryItem }) {
	const affordance = outputOpenAffordance(props.item);
	const opensInWorkspace = affordance.target.kind === "workspace";
	const contentAvailable = props.item.preview.kind !== "unavailable";
	const archived = props.item.output.status === "archived";
	return (
		<div className="output-card-actions flex shrink-0 items-center gap-1">
			{contentAvailable ? (
				<Button
					type="button"
					tabIndex={0}
					variant="ghost"
					size="sm"
					aria-label={affordance.cardLabel}
					onClick={props.onOpen}
					className="output-card-open static after:absolute after:inset-px after:content-['']"
				>
					Open
				</Button>
			) : null}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={`More actions for ${props.item.output.title}`}
							title="More actions"
							size="icon-sm"
							variant="ghost"
							// Open's height, so the row reads as one line of controls.
							className="relative z-10 !size-7"
						/>
					}
				>
					<DotsThree size={16} weight="bold" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{contentAvailable ? (
						<DropdownMenuItem onClick={props.onOpen}>
							{opensInWorkspace ? (
								<SquaresFour size={14} />
							) : (
								<ArrowSquareOut size={14} />
							)}{" "}
							{affordance.menuLabel}
						</DropdownMenuItem>
					) : null}
					{contentAvailable && opensInWorkspace ? (
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
					{contentAvailable && !archived ? (
						<DropdownMenuItem onClick={props.onShare}>
							<ShareNetwork size={14} /> Share…
						</DropdownMenuItem>
					) : null}
					{archived ? (
						<DropdownMenuItem onClick={props.onRestore}>
							<ArrowCounterClockwise size={14} /> Restore
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem variant="destructive" onClick={props.onArchive}>
							<Archive size={14} /> Archive…
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

function OutputCard(
	props: OutputActions & { item: OsOutputLibraryItem; layout: Layout },
) {
	const { item, layout, ...actions } = props;
	const Icon = KIND_ICONS[item.output.kind];
	const provenance = workspaceLabel(item);
	const affordance = outputOpenAffordance(item);
	const contentAvailable = item.preview.kind !== "unavailable";
	const cardLabel = contentAvailable
		? affordance.cardLabel
		: `${item.output.title} — source access unavailable`;
	const menu = <OutputMenu item={item} {...actions} />;
	if (layout === "list") {
		return (
			<ResourceCard
				asListItem
				layout="list"
				label={cardLabel}
				disabled={!contentAvailable}
			>
				<IconFrame>
					<Icon size={18} />
				</IconFrame>
				{/* One shrinkable column: an auto track grew to an unbroken title
				    and pushed the row past a phone's edge. */}
				<span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
					<Text
						as="strong"
						role="body"
						weight="medium"
						tone="strong"
						className="wrap-anywhere"
					>
						{item.output.title}
					</Text>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="wrap-anywhere"
					>
						{kindLabel(item.output.kind)} · {provenance}
						<time
							className="sm:hidden"
							dateTime={item.output.updatedAt}
							title={absoluteTime(item.output.updatedAt)}
						>
							{" "}
							· {relativeTime(item.output.updatedAt)}
						</time>
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
			</ResourceCard>
		);
	}
	return (
		<ResourceCard
			asListItem
			bodyClassName="grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
			label={cardLabel}
			disabled={!contentAvailable}
			preview={<OutputPreview preview={item.preview} />}
			actions={menu}
		>
			<>
				<IconFrame size="sm">
					<Icon size={16} />
				</IconFrame>
				<span className="grid min-w-0">
					<Text
						as="strong"
						tone="strong"
						role="control"
						className="wrap-anywhere"
						weight="medium"
					>
						{item.output.title}
					</Text>
					<Text
						as="span"
						tone="secondary"
						role="caption"
						className="wrap-anywhere"
					>
						{provenance} ·{" "}
						<span className="sr-only">
							{creatorLabel(item)} · {outputMetric(item.preview)}, updated{" "}
						</span>
						<time
							dateTime={item.output.updatedAt}
							title={`Updated ${absoluteTime(item.output.updatedAt)}`}
						>
							{relativeTime(item.output.updatedAt)}
						</time>
					</Text>
				</span>
			</>
		</ResourceCard>
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
					<Button variant="secondary" className="shrink-0 justify-between" />
				}
			>
				{props.value === "mine" ? (
					<User aria-hidden size={14} />
				) : (
					<ShareNetwork aria-hidden size={14} />
				)}
				<span className="hidden sm:inline">{labels[props.value]}</span>
				<span className="sm:hidden">
					{props.value === "all"
						? "All sharing"
						: props.value === "mine"
							? "Yours"
							: "Team"}
				</span>
				<CaretDown aria-hidden size={12} />
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
		<ConfirmDialog
			open={props.item !== null}
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			title={<>Archive “{props.item?.output.title}”?</>}
			description="This removes it from the active library. Its immutable revisions and audit provenance remain durable."
			confirmLabel="Archive"
			pendingLabel="Archiving…"
			destructive
			isPending={props.busy}
			onConfirm={props.onConfirm}
		>
			{props.error ? (
				<Alert variant="destructive">
					<AlertTitle>Output not archived</AlertTitle>
					<AlertDescription>{props.error.message}</AlertDescription>
				</Alert>
			) : null}
		</ConfirmDialog>
	);
}

export function OutputsPage() {
	useOsFormattingPreferences();
	useOutputsWebMcpTools();
	const surface = getOsSurface("outputs");
	const EmptyIcon = SURFACE_ICONS.outputs;
	const navigate = useNavigate();
	const apps = useLibraryApps();
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
	const [shareTarget, setShareTarget] = useState<OsOutputLibraryItem | null>(
		null,
	);
	useEffect(() => persistLayout(layout), [layout]);
	const outputLibraryOptions = activeOutputLibraryQueryOptions();
	const archivedLibraryOptions = archivedOutputLibraryQueryOptions();
	const activeOutputs = useQuery({
		...outputLibraryOptions,
		retry: false,
	});
	// Archived outputs load when someone opens the Archived tab.
	const archivedOutputs = useQuery({
		...archivedLibraryOptions,
		enabled: kind === "archived",
		retry: false,
	});
	const outputs = kind === "archived" ? archivedOutputs : activeOutputs;
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
	const restore = useMutation({
		...osQuery.osWorkspaces.outputs.restore.mutationOptions(),
		onSuccess: ({ output }) => {
			queryClient.setQueryData<OutputLibraryData>(
				archivedLibraryOptions.queryKey,
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
			void invalidate();
		},
	});
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
	const matchesScope = (item: OsOutputLibraryItem) =>
		scope === "all" || item.scope === scope;
	const matchesKind = (item: OsOutputLibraryItem) =>
		kind === "all" || kind === "archived" || item.output.kind === kind;
	const matchingApps = apps.items.filter(({ gadget, workspace }) =>
		`${gadget.name} ${gadget.description ?? ""} ${workspace.name} app`
			.toLocaleLowerCase()
			.includes(normalizedQuery),
	);
	const appsInScope = matchingApps.filter(
		(item) => scope === "all" || item.scope === scope,
	);
	const visibleApps = kind === "all" || kind === "app" ? appsInScope : [];
	const allItems = outputs.data?.items ?? [];
	const searchResults = allItems.filter(matchesSearch);
	const activeInScope = (activeOutputs.data?.items ?? []).filter(
		(item) => matchesSearch(item) && matchesScope(item),
	);
	const inKind = searchResults.filter(matchesKind);
	const visibleOutputs = inKind.filter(matchesScope);
	useEffect(() => {
		setVisibleLimit(OUTPUT_LIBRARY_PAGE_SIZE);
	}, [kind, normalizedQuery, scope]);
	const displayedApps = visibleApps.slice(0, visibleLimit);
	const displayedOutputs = visibleOutputs.slice(
		0,
		Math.max(0, visibleLimit - displayedApps.length),
	);
	const visibleCount = visibleApps.length + visibleOutputs.length;
	const displayedCount = displayedApps.length + displayedOutputs.length;
	const hasMoreOutputs = displayedCount < visibleCount;
	// Archived shows a count only once its list has loaded.
	const kindCounts = Object.fromEntries(
		KIND_FILTERS.map((filter) => [
			filter,
			filter === "archived"
				? archivedOutputs.data?.items.filter(
						(item) => matchesSearch(item) && matchesScope(item),
					).length
				: filter === "all"
					? activeInScope.length + appsInScope.length
					: filter === "app"
						? appsInScope.length
						: activeInScope.filter((item) => item.output.kind === filter)
								.length,
		]),
	) as Record<KindFilter, number | undefined>;
	const appsInKind = kind === "all" || kind === "app" ? matchingApps : [];
	const scopeCounts: Record<ScopeFilter, number> = {
		all: inKind.length + appsInKind.length,
		mine:
			inKind.filter((item) => item.scope === "mine").length +
			appsInKind.filter((item) => item.scope === "mine").length,
		organization:
			inKind.filter((item) => item.scope === "organization").length +
			appsInKind.filter((item) => item.scope === "organization").length,
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
		<Page width="lg" className="outputs-library">
			<div className="grid min-w-0 gap-4">
				<PageHeader>
					<PageHeading>
						<PageTitle>{surface.label}</PageTitle>
						<PageDescription>{surface.description}</PageDescription>
					</PageHeading>
					<PageActions>
						<NewResourceMenu
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
							iconOnly
							value={layout}
							onValueChange={setLayout}
							options={[
								{
									value: "list",
									label: "List view",
									icon: <ListIcon aria-hidden size={16} />,
								},
								{
									value: "grid",
									label: "Grid view",
									icon: <SquaresFour aria-hidden size={16} />,
								},
							]}
						/>
					</PageActions>
				</PageHeader>
				<PageToolbar aria-label="Output library controls" appearance="inline">
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
					<div className="flex w-full min-w-0 items-stretch gap-2 sm:items-center lg:w-auto lg:shrink-0">
						<ScopeSelect
							value={scope}
							counts={scopeCounts}
							onChange={setScope}
						/>
						<SearchInput
							containerClassName="min-w-0 flex-1 sm:w-60"
							aria-label="Search outputs"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search"
						/>
					</div>
				</PageToolbar>
			</div>

			{(kind === "all" || kind === "app") && apps.failed && (
				<LoadError title="Apps are unavailable" onRetry={apps.retry} />
			)}
			{(kind === "all" || kind === "app") && apps.truncated && (
				<Text role="label" tone="secondary">
					Showing apps from the loaded workspaces. Open a workspace to see its
					full library.
				</Text>
			)}
			{outputs.isPending ? <ListSkeleton /> : null}
			{outputs.isError ? (
				<LoadError
					title="Documents are unavailable"
					error={outputs.error}
					onRetry={() => void outputs.refetch()}
					retrying={outputs.isFetching}
				/>
			) : null}
			{restore.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Output not restored</AlertTitle>
					<AlertDescription>{restore.error.message}</AlertDescription>
				</Alert>
			) : null}
			{outputs.data &&
			visibleOutputs.length === 0 &&
			visibleApps.length === 0 &&
			!apps.pending ? (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<EmptyIcon size={20} />
						</EmptyMedia>
						<EmptyTitle>
							{allItems.length > 0
								? "No matching outputs"
								: kind === "archived"
									? "No archived outputs"
									: "No outputs yet"}
						</EmptyTitle>
						<EmptyDescription>
							{allItems.length > 0
								? "Try another search, format, or sharing scope."
								: kind === "archived"
									? "Outputs you archive appear here, and you can restore them from the ⋯ menu."
									: "Create a document from a blank page or a template. Documents, sheets, and presentations created with your tedi also appear here."}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : null}
			{visibleOutputs.length > 0 || visibleApps.length > 0 ? (
				<ul
					className={
						layout === "grid"
							? "output-library-items m-0 grid grid-cols-1 list-none gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3"
							: "output-library-items m-0 grid grid-cols-1 list-none gap-1 p-0"
					}
				>
					{displayedApps.map(({ gadget, workspace }) => (
						<li key={`app:${gadget.id}`} className="min-w-0">
							<WorkspaceAppCard
								workspaceId={workspace.id}
								gadget={gadget}
								selected={false}
								layout={layout}
								onOpen={() =>
									void navigate({
										to: "/workspace/$workspaceId",
										params: { workspaceId: workspace.id },
										search: {
											pane: "workpiece",
											workpiece: `gadget:${gadget.id}`,
										},
									})
								}
							/>
						</li>
					))}
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
							onShare={() => setShareTarget(item)}
							onArchive={() => {
								archive.reset();
								setArchiveTarget(item);
							}}
							onRestore={() => restore.mutate({ outputId: item.output.id })}
						/>
					))}
				</ul>
			) : null}
			{visibleCount > OUTPUT_LIBRARY_PAGE_SIZE ? (
				<div
					className="flex min-h-11 items-center justify-between gap-3 border-kumo-hairline border-t pt-3"
					aria-live="polite"
				>
					<Text role="label" tone="secondary">
						Showing {displayedCount} of {visibleCount} items
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
			{shareTarget ? (
				<ShareDialog
					outputId={shareTarget.output.id}
					currentRevisionId={shareTarget.output.currentRevisionId}
					open
					onOpenChange={(open) => {
						if (!open) setShareTarget(null);
					}}
				/>
			) : null}
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

import { EntityAvatar } from "@/shared/entity-avatar";
import {
	AppWindow,
	GearSix,
	Lightning,
	MagnifyingGlass,
	Plus,
	Pulse,
	SquaresFour,
	Stack,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { OS_COPY } from "@/shared/os-copy";
import { useOsLocale } from "@/lib/use-os-locale";
import {
	OS_PAGES,
	matchOsPage,
	osPageParents,
	osPagePath,
} from "@/lib/os-navigation";
import type { ComponentType } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreateOutputAppDialog } from "@/components/create-doc-app-dialog";
import { WorkspaceFormDialog } from "@/components/workspace-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	CommandPalette,
	CommandPaletteTitle,
} from "@/components/kumo/command-palette";
import { Kbd } from "@/components/kumo/kbd";
import {
	appListQueryOptions,
	commandPaletteOutputLibraryQueryOptions,
	commandPaletteWorkspacesQueryOptions,
	skillCatalogQueryOptions,
	skillRunHistoryQueryOptions,
	workAppsQueryOptions,
	workspacePreferencesQueryOptions,
} from "@/lib/os-query-options";
import { canvasDocKey } from "@/lib/canvas-search";
import { primaryOutputNavigationTarget } from "@/lib/output-navigation";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { openableWorkViews, WORK_VIEWS, type WorkView } from "@/lib/work-views";

// Other resource groups remain bounded; workspace search loads every page.
const PALETTE_LIST_LIMIT = 12;
const PALETTE_RUNS_LIMIT = 8;
// How many recently opened workspaces lead the list before anything is typed.
const PALETTE_RECENT_LIMIT = 5;

type PaletteCreateKind = "workspace" | "document" | "sheet" | "presentation";

type PaletteCommand = {
	id: string;
	title: string;
	description: string;
	icon: ComponentType<{ size?: number; className?: string }>;
	workspace?: {
		id: string;
		name: string;
		visibility: string;
		iconUrl?: string | null;
	};
	run: () => void;
};

type PaletteGroup = {
	id: string;
	label: string;
	items: PaletteCommand[];
};

/** One "Go to …" command per Work view, so ⌘K is the first way to find them. */
function workViewCommands(
	open: (view: WorkView) => void,
	views: readonly WorkView[] = WORK_VIEWS,
): PaletteCommand[] {
	return views.map((view) => ({
		id: `work-view-${view.id}`,
		title: `Go to ${view.label}`,
		description: `Work · ${view.description}`,
		icon: SURFACE_ICONS.work,
		run: () => open(view),
	}));
}

function pageCommands(
	open: (path: string) => void,
	pathname: string,
): PaletteCommand[] {
	const params = matchOsPage(pathname)?.params ?? {};
	return OS_PAGES.flatMap((page) => {
		if (!page.palette) return [];
		const path = osPagePath(page, params);
		if (!path) return [];
		const chain = osPageParents(page);
		const surface = chain.find((parent) => parent.surfaceId)?.surfaceId;
		return [
			{
				id: `page-${page.id}`,
				title: `Go to ${page.label}`,
				description: [
					chain.map((parent) => parent.label).join(" · "),
					page.description,
				]
					.filter(Boolean)
					.join(" · "),
				icon: surface ? SURFACE_ICONS[surface] : GearSix,
				run: () => open(path),
			},
		];
	});
}

/**
 * "New …" commands. Files are created in the workspace on screen; anywhere
 * else the create dialog asks which workspace to use.
 */
function createCommands(
	start: (kind: PaletteCreateKind) => void,
	inWorkspace: boolean,
): PaletteCommand[] {
	const where = inWorkspace ? "in this workspace" : "in a workspace you choose";
	return [
		{
			id: "create-workspace",
			title: "New workspace",
			description: "Create · a place for your work, documents and apps",
			icon: Plus,
			run: () => start("workspace"),
		},
		{
			id: "create-document",
			title: "New doc",
			description: `Create · a document ${where}`,
			icon: Plus,
			run: () => start("document"),
		},
		{
			id: "create-sheet",
			title: "New sheet",
			description: `Create · a sheet ${where}`,
			icon: Plus,
			run: () => start("sheet"),
		},
		{
			id: "create-presentation",
			title: "New slides",
			description: `Create · slides ${where}`,
			icon: Plus,
			run: () => start("presentation"),
		},
	];
}

function queryTokens(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesCommand(command: PaletteCommand, query: string): boolean {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return true;
	const haystack = `${command.title} ${command.description}`.toLowerCase();
	return tokens.every((token) => haystack.includes(token));
}

/**
 * How well a command answers the query, higher first: the whole name, the
 * start of the name, the starts of words in the name, anywhere in the name,
 * then the description only. 0 means it does not match.
 */
function commandScore(command: PaletteCommand, query: string): number {
	if (!matchesCommand(command, query)) return 0;
	const tokens = queryTokens(query);
	if (tokens.length === 0) return 1;
	const title = command.title.toLowerCase();
	const typed = tokens.join(" ");
	if (title === typed) return 5;
	if (title.startsWith(typed)) return 4;
	const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	if (tokens.every((token) => words.some((word) => word.startsWith(token))))
		return 3;
	if (tokens.every((token) => title.includes(token))) return 2;
	return 1;
}

/**
 * The commands that match, best first. Equally good workspaces are ordered by
 * when the person last opened them; everything else keeps its given order.
 */
function rankCommands(
	commands: readonly PaletteCommand[],
	query: string,
	lastOpenedAt: ReadonlyMap<string, string> = new Map(),
): PaletteCommand[] {
	const opened = (command: PaletteCommand) =>
		(command.workspace && lastOpenedAt.get(command.workspace.id)) || "";
	return commands
		.map((command, index) => ({
			command,
			index,
			score: commandScore(command, query),
		}))
		.filter((entry) => entry.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				opened(right.command).localeCompare(opened(left.command)) ||
				left.index - right.index,
		)
		.map((entry) => entry.command);
}

/** Split text into runs, marking the parts the query matched. */
function highlightParts(
	text: string,
	query: string,
): { text: string; match: boolean }[] {
	const lower = text.toLowerCase();
	const tokens = queryTokens(query);
	// Lowercasing can change the length of unusual text; leave that unmarked.
	if (tokens.length === 0 || lower.length !== text.length)
		return [{ text, match: false }];
	const ranges: [number, number][] = [];
	for (const token of tokens) {
		for (
			let at = lower.indexOf(token);
			at !== -1;
			at = lower.indexOf(token, at + token.length)
		)
			ranges.push([at, at + token.length]);
	}
	ranges.sort((left, right) => left[0] - right[0]);
	const parts: { text: string; match: boolean }[] = [];
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (end <= cursor) continue;
		const from = Math.max(start, cursor);
		if (from > cursor)
			parts.push({ text: text.slice(cursor, from), match: false });
		const last = parts.at(-1);
		if (last?.match) last.text += text.slice(from, end);
		else parts.push({ text: text.slice(from, end), match: true });
		cursor = end;
	}
	if (cursor < text.length)
		parts.push({ text: text.slice(cursor), match: false });
	return parts;
}

function Highlighted({ text, query }: { text: string; query: string }) {
	return (
		<>
			{highlightParts(text, query).map((part, index) =>
				part.match ? (
					<mark
						className="rounded-xs bg-kumo-warning-tint text-inherit"
						key={index}
					>
						{part.text}
					</mark>
				) : (
					part.text
				),
			)}
		</>
	);
}

export function OsCommandPalette({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const locale = useOsLocale();
	const navigate = useNavigate();
	const pathname = useLocation({ select: (location) => location.pathname });
	const [query, setQuery] = useState("");
	// A "New …" command hides the search and shows its dialog in the same
	// place, so the page that opened the palette needs no dialog of its own.
	const [creating, setCreating] = useState<PaletteCreateKind | null>(null);
	const currentPage = matchOsPage(pathname);
	const currentWorkspaceId =
		currentPage?.page.id === "workspace"
			? currentPage.params.workspaceId
			: undefined;
	// The shell mounts the palette on demand, without a Kumo Dialog.Trigger.
	const [returnFocus] = useState(() =>
		typeof document === "undefined" ? null : document.activeElement,
	);
	const stillOpen = useRef(open);
	useEffect(() => {
		stillOpen.current = open;
		if (!open) return;
		return () => {
			stillOpen.current = false;
			requestAnimationFrame(() => {
				if (
					!stillOpen.current &&
					returnFocus instanceof HTMLElement &&
					returnFocus.isConnected
				) {
					returnFocus.focus({ preventScroll: true });
				}
			});
		};
	}, [open, returnFocus]);
	const workspaces = useInfiniteQuery({
		...commandPaletteWorkspacesQueryOptions(PALETTE_LIST_LIMIT),
		enabled: open,
		staleTime: 30_000,
	});
	const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } =
		workspaces;
	useEffect(() => {
		if (open && hasNextPage && !isFetching && !isFetchNextPageError) {
			void fetchNextPage();
		}
	}, [open, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
	const outputs = useQuery({
		...commandPaletteOutputLibraryQueryOptions(PALETTE_LIST_LIMIT),
		enabled: open,
		staleTime: 30_000,
	});
	const apps = useQuery({
		...appListQueryOptions(PALETTE_LIST_LIMIT),
		enabled: open,
		staleTime: 30_000,
	});
	const skills = useQuery({
		...skillCatalogQueryOptions(PALETTE_LIST_LIMIT),
		enabled: open,
		staleTime: 30_000,
	});
	const runs = useQuery({
		...skillRunHistoryQueryOptions(PALETTE_RUNS_LIMIT),
		enabled: open,
		staleTime: 30_000,
	});
	// Decides which Work views are offered; a view whose app is missing or not
	// yet known is left out instead of leading to "not available".
	const workApps = useQuery({
		...workAppsQueryOptions(),
		enabled: open,
		staleTime: 30_000,
	});
	// Only orders workspaces; when it cannot be read they keep their given order.
	const preferences = useQuery({
		...workspacePreferencesQueryOptions(),
		enabled: open,
		staleTime: 30_000,
	});
	const lastOpenedAt = useMemo(
		() =>
			new Map(
				(preferences.data?.items ?? []).flatMap((preference) =>
					preference.lastOpenedAt
						? [[preference.workspaceId, preference.lastOpenedAt] as const]
						: [],
				),
			),
		[preferences.data],
	);
	const resources = [
		{ label: "Workspaces", query: workspaces },
		{ label: OS_COPY.navigation.outputs, query: outputs },
		{ label: "Apps", query: apps },
		{ label: "Skills", query: skills },
		{ label: "Recent runs", query: runs },
	];
	const loadingResources = resources.some(({ query }) => query.isPending);
	const failedResources = resources.filter(({ query }) => query.isError);
	const [retryingResources, setRetryingResources] = useState<
		{ label: string; cached: boolean }[]
	>([]);
	const unavailableResources = retryingResources.length
		? retryingResources
		: failedResources.map(({ label, query }) => ({
				label,
				cached: query.data !== undefined,
			}));
	const retrying =
		retryingResources.length > 0 ||
		failedResources.some(({ query }) => query.isFetching);
	const retryFailedResources = () => {
		if (!open || retrying || failedResources.length === 0) return;
		setRetryingResources(unavailableResources);
		void Promise.allSettled(
			failedResources.map(({ query }) =>
				query.refetch({ cancelRefetch: false }),
			),
		).then(() => setRetryingResources([]));
	};

	const groups = useMemo<PaletteGroup[]>(() => {
		const go = (to: string) => () => {
			void navigate({ to });
		};
		const pages = pageCommands((path) => void navigate({ to: path }), pathname);

		const workspaceCommands: PaletteCommand[] = (
			workspaces.data?.pages.flatMap((page) => page.items) ?? []
		).map((workspace) => ({
			id: `workspace-${workspace.id}`,
			workspace,
			title: workspace.name,
			description: "Workspace · open its apps and documents",
			icon: SquaresFour,
			run: () => {
				void navigate({
					to: "/workspace/$workspaceId",
					params: { workspaceId: workspace.id },
				});
			},
		}));
		const outputCommands: PaletteCommand[] = (outputs.data?.items ?? []).map(
			(item) => {
				const output = item.output;
				const activeWorkspaceIds = new Set(
					item.workspace?.status === "active" ? [item.workspace.id] : [],
				);
				return {
					id: `output-${output.id}`,
					title: output.title,
					description: `${output.kind} · ${output.workspaceId && activeWorkspaceIds.has(output.workspaceId) ? "open collaboratively" : "document"}`,
					icon: Stack,
					run: () => {
						const target = primaryOutputNavigationTarget(
							output,
							activeWorkspaceIds,
						);
						if (target.kind === "workspace") {
							void navigate({
								to: "/workspace/$workspaceId",
								params: { workspaceId: target.workspaceId },
								search: target.search,
							});
							return;
						}
						void navigate({
							to: "/outputs/$outputId",
							params: { outputId: target.outputId },
						});
					},
				};
			},
		);
		const appCommands: PaletteCommand[] = (apps.data?.data ?? []).map(
			(app) => ({
				id: `app-${app.id}`,
				title: app.name,
				description: `${app.slug} · app`,
				icon: AppWindow,
				run: () =>
					void navigate({ to: "/apps/$appId", params: { appId: app.id } }),
			}),
		);
		const skillCommands: PaletteCommand[] = (skills.data?.entries ?? []).map(
			(skill) => ({
				id: `skill-${skill.id}`,
				title: skill.title,
				description: `${skill.slug ?? skill.id.slice(0, 8)} · skill`,
				icon: Lightning,
				run: go("/skills"),
			}),
		);
		const runCommands: PaletteCommand[] = (runs.data?.runs ?? []).map(
			(run) => ({
				id: `run-${run.id}`,
				title: run.skillSlug ?? `Skill ${run.skillId.slice(0, 8)}`,
				description: `${run.status} · automation run`,
				icon: Pulse,
				run: () =>
					void navigate({
						to: "/work/runs/$runId",
						params: { runId: run.id },
					}),
			}),
		);

		const workViews = openableWorkViews(
			(workApps.data?.items ?? []).map((item) => ({
				gadget: item.gadget,
				manifest: item.currentRevision.manifest,
			})),
		);
		const workViewItems = workViewCommands((view) => {
			if (view.to === "/work")
				void navigate({ to: view.to, search: view.search });
			else void navigate({ to: view.to });
		}, workViews);

		return [
			{
				id: "create",
				label: "Create",
				items: createCommands(setCreating, currentWorkspaceId !== undefined),
			},
			{ id: "pages", label: "OS", items: pages },
			{ id: "work-views", label: "Work views", items: workViewItems },
			{
				id: "workspaces",
				label: "Workspaces and Apps",
				items: workspaceCommands,
			},
			{
				id: "outputs",
				label: OS_COPY.navigation.outputs,
				items: outputCommands,
			},
			{ id: "apps", label: "Apps", items: appCommands },
			{ id: "skills", label: "Skills", items: skillCommands },
			{ id: "runs", label: "Recent runs", items: runCommands },
		];
	}, [
		apps.data,
		currentWorkspaceId,
		navigate,
		pathname,
		locale,
		outputs.data,
		runs.data,
		skills.data,
		workApps.data,
		workspaces.data,
	]);

	const filteredGroups = useMemo(() => {
		if (queryTokens(query).length === 0) {
			// Nothing typed yet: lead with the workspaces opened most recently.
			const recent = rankCommands(
				groups
					.find((group) => group.id === "workspaces")!
					.items.filter(
						(item) => item.workspace && lastOpenedAt.has(item.workspace.id),
					),
				"",
				lastOpenedAt,
			).slice(0, PALETTE_RECENT_LIMIT);
			return [
				{ id: "recent-workspaces", label: "Recent workspaces", items: recent },
				...groups.map((group) =>
					group.id === "workspaces"
						? {
								...group,
								items: group.items.filter((item) => !recent.includes(item)),
							}
						: group,
				),
			].filter((group) => group.items.length > 0);
		}
		// The group holding the best match comes first.
		return groups
			.map((group, index) => {
				const items = rankCommands(group.items, query, lastOpenedAt);
				return {
					group: { ...group, items },
					index,
					best: items[0] ? commandScore(items[0], query) : 0,
				};
			})
			.filter((entry) => entry.best > 0)
			.sort((left, right) => right.best - left.best || left.index - right.index)
			.map((entry) => entry.group);
	}, [groups, lastOpenedAt, query]);

	const select = (command: PaletteCommand) => {
		setQuery("");
		if (command.id.startsWith("create-")) {
			// Stay mounted: the dialog replaces the search until it is done.
			command.run();
			return;
		}
		onOpenChange(false);
		command.run();
	};
	const finishCreating = () => {
		setCreating(null);
		onOpenChange(false);
	};

	if (creating === "workspace")
		return (
			<WorkspaceFormDialog
				mode="create"
				open
				onOpenChange={(nextOpen) => {
					if (!nextOpen) finishCreating();
				}}
				onSaved={(workspace) =>
					void navigate({
						to: "/workspace/$workspaceId",
						params: { workspaceId: workspace.id },
					})
				}
			/>
		);
	if (creating)
		return (
			<CreateOutputAppDialog
				kind={creating}
				workspaceId={currentWorkspaceId}
				onClose={finishCreating}
				onCreated={(gadget) =>
					void navigate({
						to: "/workspace/$workspaceId",
						params: { workspaceId: gadget.workspaceId },
						search: {
							workpiece: canvasDocKey({ type: "gadget", id: gadget.id }),
							pane: "workpiece",
						},
					})
				}
				onOpenOutput={(output) =>
					void navigate({
						to: "/outputs/$outputId",
						params: { outputId: output.id },
					})
				}
			/>
		);

	return (
		<CommandPalette.Root<PaletteGroup, PaletteCommand>
			filter={() => true}
			getSelectableItems={(items) => items.flatMap((group) => group.items)}
			itemToStringValue={(group) => group.label}
			items={filteredGroups}
			onOpenChange={(nextOpen) => {
				onOpenChange(nextOpen);
				if (!nextOpen) setQuery("");
			}}
			onSelect={select}
			onValueChange={setQuery}
			open={open}
			value={query}
		>
			<CommandPaletteTitle className="sr-only">
				Quick search
			</CommandPaletteTitle>
			<CommandPalette.Input
				aria-label="Search OS pages and resources"
				autoComplete="off"
				className="type-tedix-control"
				leading={<MagnifyingGlass size={16} className="text-kumo-subtle" />}
				placeholder="Search pages, workspaces, documents, apps, skills…"
			/>
			<CommandPalette.List>
				{unavailableResources.length > 0 ? (
					<Alert
						role="status"
						aria-label="Resource availability"
						variant="warning"
						className="mb-2"
					>
						<AlertTitle>
							{unavailableResources.length === resources.length
								? "Resources unavailable"
								: "Some resources unavailable"}
						</AlertTitle>
						<AlertDescription>
							Could not load:{" "}
							{unavailableResources.map(({ label }) => label).join(", ")}.
							{unavailableResources.some(({ cached }) => cached)
								? " Saved results may be out of date."
								: " Pages and available results still work."}
						</AlertDescription>
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="mt-2 justify-self-start"
							disabled={retrying}
							onClick={retryFailedResources}
						>
							{retrying ? "Retrying resources…" : "Retry unavailable resources"}
						</Button>
					</Alert>
				) : null}
				{loadingResources ? (
					<div role="status" aria-label="Loading resources">
						<CommandPalette.Loading />
					</div>
				) : null}
				<CommandPalette.Results>
					{(group: PaletteGroup) => (
						<CommandPalette.Group key={group.id} items={group.items}>
							<CommandPalette.GroupLabel>
								{group.label}
							</CommandPalette.GroupLabel>
							<CommandPalette.Items>
								{(item: PaletteCommand) => {
									const Icon = item.icon;
									return (
										<CommandPalette.Item
											key={item.id}
											onClick={() => select(item)}
											value={item}
										>
											{item.workspace ? (
												<EntityAvatar
													id={item.workspace.id}
													name={item.workspace.name}
													image={item.workspace.iconUrl}
													imageFit="contain"
													kind="workspace"
													role={
														item.workspace.visibility === "private"
															? "private"
															: undefined
													}
													className="size-6 rounded-md"
												/>
											) : (
												<Icon size={16} className="shrink-0 text-kumo-subtle" />
											)}
											<div className="min-w-0">
												<div className="font-medium text-kumo-default">
													<Highlighted text={item.title} query={query} />
												</div>
												<div className="truncate text-kumo-subtle text-xs">
													<Highlighted text={item.description} query={query} />
												</div>
											</div>
										</CommandPalette.Item>
									);
								}}
							</CommandPalette.Items>
						</CommandPalette.Group>
					)}
				</CommandPalette.Results>
				{loadingResources ? null : (
					<CommandPalette.Empty>
						{unavailableResources.length > 0
							? "No matches in available pages or resources"
							: "No matching pages or resources"}
					</CommandPalette.Empty>
				)}
			</CommandPalette.List>
			<CommandPalette.Footer>
				<span>
					{filteredGroups.reduce((sum, group) => sum + group.items.length, 0)}{" "}
					results
				</span>
				{/* A phone has no Escape key, and with its keyboard open the search
				    covers the page behind it, so closing needs its own button. */}
				<Button
					className="sm:hidden"
					onClick={() => onOpenChange(false)}
					size="sm"
					variant="ghost"
				>
					Close
				</Button>
				<span className="flex items-center gap-3 max-sm:hidden">
					<span className="flex items-center gap-1">
						<Kbd>↑↓</Kbd> navigate
					</span>
					<span className="flex items-center gap-1">
						<Kbd>↵</Kbd> open
					</span>
					<span className="flex items-center gap-1">
						<Kbd>esc</Kbd> close
					</span>
				</span>
			</CommandPalette.Footer>
		</CommandPalette.Root>
	);
}

export {
	commandScore,
	createCommands,
	highlightParts,
	matchesCommand,
	pageCommands,
	rankCommands,
	workViewCommands,
};

import { EntityAvatar } from "@/shared/entity-avatar";
import {
	AppWindow,
	GearSix,
	Lightning,
	MagnifyingGlass,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { CommandPalette } from "@/components/kumo/command-palette";
import { Kbd } from "@/components/kumo/kbd";
import {
	appListQueryOptions,
	commandPaletteOutputLibraryQueryOptions,
	commandPaletteWorkspacesQueryOptions,
	skillCatalogQueryOptions,
	skillRunHistoryQueryOptions,
} from "@/lib/os-query-options";
import { primaryOutputNavigationTarget } from "@/lib/output-navigation";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { WORK_VIEWS, type WorkView } from "@/lib/work-views";

// Other resource groups remain bounded; workspace search loads every page.
const PALETTE_LIST_LIMIT = 12;
const PALETTE_RUNS_LIMIT = 8;

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
function workViewCommands(open: (view: WorkView) => void): PaletteCommand[] {
	return WORK_VIEWS.map((view) => ({
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

function matchesCommand(command: PaletteCommand, query: string): boolean {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return true;
	const haystack = `${command.title} ${command.description}`.toLowerCase();
	return tokens.every((token) => haystack.includes(token));
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

		const workViewItems = workViewCommands((view) => {
			if (view.to === "/work")
				void navigate({ to: view.to, search: view.search });
			else void navigate({ to: view.to });
		});

		return [
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
		navigate,
		pathname,
		locale,
		outputs.data,
		runs.data,
		skills.data,
		workspaces.data,
	]);

	const filteredGroups = useMemo(
		() =>
			groups
				.map((group) => ({
					...group,
					items: group.items.filter((item) => matchesCommand(item, query)),
				}))
				.filter((group) => group.items.length > 0),
		[groups, query],
	);

	const select = (command: PaletteCommand) => {
		onOpenChange(false);
		setQuery("");
		command.run();
	};

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
			<CommandPalette.Input
				aria-label="Search OS pages and resources"
				autoComplete="off"
				className="type-tedix-control"
				leading={<MagnifyingGlass size={16} className="text-kumo-subtle" />}
				placeholder="Search pages, workspaces, outputs, apps, skills…"
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
													{item.title}
												</div>
												<div className="truncate text-kumo-subtle text-xs">
													{item.description}
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
				<span className="flex items-center gap-3">
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

export { matchesCommand, pageCommands, workViewCommands };

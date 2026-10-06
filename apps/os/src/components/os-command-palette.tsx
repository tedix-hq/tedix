import {
	AppWindow,
	GearSix,
	Lightning,
	MagnifyingGlass,
	Pulse,
	ShieldCheck,
	SquaresFour,
	Stack,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { OS_NAVIGATION } from "@/lib/os-navigation";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
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

// The palette shows a bounded slice of each domain, not the surface page size.
const PALETTE_LIST_LIMIT = 12;
const PALETTE_RUNS_LIMIT = 8;

type PaletteCommand = {
	id: string;
	title: string;
	description: string;
	icon: ComponentType<{ size?: number; className?: string }>;
	run: () => void;
};

type PaletteGroup = {
	id: string;
	label: string;
	items: PaletteCommand[];
};

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
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const workspaces = useQuery({
		...commandPaletteWorkspacesQueryOptions(PALETTE_LIST_LIMIT),
		enabled: open,
		staleTime: 30_000,
	});
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

	const groups = useMemo<PaletteGroup[]>(() => {
		const go = (to: string) => () => {
			void navigate({ to });
		};
		const pageCommands: PaletteCommand[] = OS_NAVIGATION.map((item) => ({
			id: `page-${item.id}`,
			title: item.label,
			description: item.description,
			icon: SURFACE_ICONS[item.id],
			run: go(item.path),
		}));
		pageCommands.splice(2, 0, {
			id: "page-workspaces",
			title: "Workspaces",
			description:
				"Browse favorites, recent work, and governed workspace templates",
			icon: SquaresFour,
			run: go("/workspaces"),
		});
		pageCommands.push(
			{
				id: "page-settings",
				title: "Settings",
				description:
					"Appearance, identity, harnesses, and personal preferences",
				icon: GearSix,
				run: go("/account/settings"),
			},
			{
				id: "page-admin",
				title: "Admin settings",
				description: "Tenant policy, access, AI, cost, and delivery controls",
				icon: ShieldCheck,
				run: go("/admin"),
			},
		);

		const workspaceCommands: PaletteCommand[] = (
			workspaces.data?.items ?? []
		).map((workspace) => ({
			id: `workspace-${workspace.id}`,
			title: workspace.name,
			description: "Workspace · open its Gadgets and outputs in Canvas",
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
					description: `${output.kind} · ${output.workspaceId && activeWorkspaceIds.has(output.workspaceId) ? "open collaboratively" : "governed output"}`,
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
				description: `${app.slug} · MCP app`,
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

		return [
			{ id: "pages", label: "OS", items: pageCommands },
			{
				id: "workspaces",
				label: "Workspaces and Gadgets",
				items: workspaceCommands,
			},
			{ id: "outputs", label: "Outputs", items: outputCommands },
			{ id: "apps", label: "MCP apps", items: appCommands },
			{ id: "skills", label: "Skills", items: skillCommands },
			{ id: "runs", label: "Recent runs", items: runCommands },
		];
	}, [
		apps.data,
		navigate,
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
											<Icon size={16} className="shrink-0 text-kumo-subtle" />
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
				<CommandPalette.Empty>
					No matching pages or resources
				</CommandPalette.Empty>
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

export { matchesCommand };

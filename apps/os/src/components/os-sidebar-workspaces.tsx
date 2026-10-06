import { ClockCounterClockwise, Star } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	SidebarCollapsible,
	SidebarCollapsibleContent,
	SidebarCollapsibleTrigger,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuChevron,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	useSidebar,
} from "@/components/kumo/sidebar";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	activeWorkspacesQueryOptions,
	workspacePreferencesQueryOptions,
} from "@/lib/os-query-options";
import {
	groupWorkspaceLibrary,
	type WorkspaceLibraryEntry,
	workspaceInitials,
} from "@/lib/workspace-library";

const SIDEBAR_LIST_LIMIT = 6;

function WorkspaceMark({ name }: { name: string }) {
	return (
		<span className="grid size-6 shrink-0 place-items-center rounded-md bg-kumo-fill text-[10px] font-medium text-kumo-subtle">
			{workspaceInitials(name)}
		</span>
	);
}

function SidebarWorkspaceRow({ entry }: { entry: WorkspaceLibraryEntry }) {
	const navigate = useNavigate();
	return (
		<SidebarMenuSubButton
			onClick={() =>
				void navigate({
					to: "/workspace/$workspaceId",
					params: { workspaceId: entry.workspace.id },
				})
			}
		>
			<WorkspaceMark name={entry.workspace.name} />
			<span className="min-w-0 flex-1 truncate text-tedix-control">
				{entry.workspace.name}
			</span>
			{entry.preference?.favorite ? (
				<Star
					aria-label="Favorite"
					className="shrink-0 text-kumo-link"
					size={12}
					weight="fill"
				/>
			) : null}
		</SidebarMenuSubButton>
	);
}

function SidebarWorkspaceSection({
	entries,
	icon: Icon,
	label,
}: {
	entries: WorkspaceLibraryEntry[];
	icon: typeof Star;
	label: string;
}) {
	return (
		<SidebarMenuItem>
			<SidebarCollapsible>
				<SidebarCollapsibleTrigger
					render={
						<SidebarMenuButton icon={Icon} tooltip={label}>
							{label}
							<SidebarMenuChevron />
						</SidebarMenuButton>
					}
				/>
				<SidebarCollapsibleContent>
					<SidebarMenuSub aria-label={label}>
						{entries.slice(0, SIDEBAR_LIST_LIMIT).map((entry) => (
							<SidebarWorkspaceRow key={entry.workspace.id} entry={entry} />
						))}
					</SidebarMenuSub>
				</SidebarCollapsibleContent>
			</SidebarCollapsible>
		</SidebarMenuItem>
	);
}

export function OsSidebarWorkspaces() {
	const navigate = useNavigate();
	const { state } = useSidebar();
	const collapsed = state === "collapsed";
	const workspaces = useQuery(activeWorkspacesQueryOptions());
	const preferences = useQuery(workspacePreferencesQueryOptions());
	const groups = groupWorkspaceLibrary(
		workspaces.data?.items ?? [],
		preferences.data?.items ?? [],
		"",
	);

	if (workspaces.isPending || preferences.isPending)
		return (
			<SidebarGroup>
				<ListSkeleton rows={3} rowClassName="h-8" />
			</SidebarGroup>
		);
	if (workspaces.isError || preferences.isError)
		return (
			<SidebarGroup>
				<p className="m-0 px-3 text-kumo-danger text-tedix-label">
					Workspace shortcuts unavailable.
				</p>
			</SidebarGroup>
		);
	if (!groups.favorites.length && !groups.recent.length) return null;

	if (collapsed) {
		const compact = [...groups.favorites, ...groups.recent]
			.filter(
				(entry, index, entries) =>
					entries.findIndex(
						(candidate) => candidate.workspace.id === entry.workspace.id,
					) === index,
			)
			.slice(0, SIDEBAR_LIST_LIMIT);
		return (
			<SidebarGroup>
				<SidebarMenu aria-label="Workspaces">
					{compact.map((entry) => (
						<SidebarMenuButton
							aria-label={`Open ${entry.workspace.name}`}
							// The 24px mark goes in the ICON slot, never in the label:
							// the label is what Kumo squeezes to zero on a collapsed
							// rail, so a mark rendered as a child would survive as
							// visible text. Padding centres the wider mark in the same
							// 40px row (40 - 2x8 = 24, exactly the chip).
							className="group-data-[state=collapsed]/sidebar:px-2"
							icon={<WorkspaceMark name={entry.workspace.name} />}
							key={entry.workspace.id}
							onClick={() =>
								void navigate({
									to: "/workspace/$workspaceId",
									params: { workspaceId: entry.workspace.id },
								})
							}
							tooltip={entry.workspace.name}
						/>
					))}
				</SidebarMenu>
			</SidebarGroup>
		);
	}

	const recent = groups.recent.filter((entry) => !entry.preference?.favorite);
	return (
		<SidebarGroup>
			{groups.favorites.length ? (
				<>
					<SidebarGroupLabel>Pinned workspaces</SidebarGroupLabel>
					<SidebarMenu aria-label="Pinned workspaces">
						{groups.favorites.slice(0, SIDEBAR_LIST_LIMIT).map((entry) => (
							<SidebarMenuButton
								key={entry.workspace.id}
								icon={<WorkspaceMark name={entry.workspace.name} />}
								tooltip={entry.workspace.name}
								onClick={() =>
									void navigate({
										to: "/workspace/$workspaceId",
										params: { workspaceId: entry.workspace.id },
									})
								}
							>
								{entry.workspace.name}
							</SidebarMenuButton>
						))}
					</SidebarMenu>
				</>
			) : null}
			{recent.length ? (
				<SidebarMenu aria-label="Workspace history">
					<SidebarWorkspaceSection
						entries={recent}
						icon={ClockCounterClockwise}
						label="Recent workspaces"
					/>
				</SidebarMenu>
			) : null}
		</SidebarGroup>
	);
}

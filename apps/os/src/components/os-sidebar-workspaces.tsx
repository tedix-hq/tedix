import {
	ClockCounterClockwise,
	SquaresFour,
	Star,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { EntityAvatar } from "@/shared/entity-avatar";
import {
	SidebarCollapsible,
	SidebarCollapsibleContent,
	SidebarCollapsibleTrigger,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarLoading,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuChevron,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	useSidebar,
} from "@/components/kumo/sidebar";
import {
	activeWorkspacesQueryOptions,
	workspacePreferencesQueryOptions,
} from "@/lib/os-query-options";
import {
	groupWorkspaceLibrary,
	type WorkspaceLibraryEntry,
} from "@/lib/workspace-library";

const SIDEBAR_LIST_LIMIT = 6;

function WorkspaceMark({
	workspace,
}: {
	workspace: WorkspaceLibraryEntry["workspace"];
}) {
	return (
		<EntityAvatar
			id={workspace.id}
			name={workspace.name}
			role={workspace.visibility === "private" ? "private" : undefined}
			image={workspace.iconUrl}
			imageFit="contain"
			kind="workspace"
			className="size-6 rounded-md"
		/>
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
			<WorkspaceMark workspace={entry.workspace} />
			<span className="min-w-0 flex-1 truncate text-tedix-control">
				{entry.workspace.name}
			</span>
		</SidebarMenuSubButton>
	);
}

/** Names the shortcuts a group leaves out and opens the full library. */
function SidebarWorkspaceOverflow({ remaining }: { remaining: number }) {
	const navigate = useNavigate();
	return (
		<SidebarMenuSubButton onClick={() => void navigate({ to: "/workspaces" })}>
			<span className="min-w-0 flex-1 truncate text-tedix-control">
				Show all workspaces
			</span>
			<span className="shrink-0 text-kumo-subtle text-tedix-label">
				{remaining} more
			</span>
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
						{entries.length > SIDEBAR_LIST_LIMIT ? (
							<SidebarWorkspaceOverflow
								remaining={entries.length - SIDEBAR_LIST_LIMIT}
							/>
						) : null}
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
				<SidebarLoading label="Loading workspace shortcuts" />
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
		const shortcuts = [...groups.favorites, ...groups.recent].filter(
			(entry, index, entries) =>
				entries.findIndex(
					(candidate) => candidate.workspace.id === entry.workspace.id,
				) === index,
		);
		const compact = shortcuts.slice(
			0,
			Math.max(groups.favorites.length, SIDEBAR_LIST_LIMIT),
		);
		const remaining = shortcuts.length - compact.length;
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
							icon={<WorkspaceMark workspace={entry.workspace} />}
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
					{remaining > 0 ? (
						<SidebarMenuButton
							aria-label={`Show all workspaces, ${remaining} more`}
							icon={SquaresFour}
							onClick={() => void navigate({ to: "/workspaces" })}
							tooltip={`Show all workspaces (${remaining} more)`}
						/>
					) : null}
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
						{groups.favorites.map((entry) => (
							<SidebarMenuButton
								key={entry.workspace.id}
								icon={<WorkspaceMark workspace={entry.workspace} />}
								tooltip={entry.workspace.name}
								title={entry.workspace.name}
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

import { UnreadDot } from "@/components/unread-badge";
import {
	WorkspaceRowMenu,
	type WorkspaceRowPin,
} from "@/components/workspace-row-menu";
import { WorkspaceMutedIcon } from "@/components/workspace-muted-icon";
import { WorkspaceUnreadBadge } from "@/components/workspace-unread-badge";
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
import { useSetWorkspaceFavorite } from "@/lib/workspace-favorite";
import {
	groupWorkspaceLibrary,
	type WorkspaceLibraryEntry,
} from "@/lib/workspace-library";
import { useWorkspaceUnreadCount } from "@/lib/workspace-unread";

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

/** The mark on the narrow rail, with a dot when the workspace has something new. */
function CollapsedWorkspaceMark({
	workspace,
}: {
	workspace: WorkspaceLibraryEntry["workspace"];
}) {
	const unread = useWorkspaceUnreadCount(workspace.id);
	return (
		<span className="relative flex shrink-0">
			<WorkspaceMark workspace={workspace} />
			{unread > 0 ? (
				<span className="absolute -top-0.5 -right-0.5 flex rounded-full ring-2 ring-kumo-elevated">
					<UnreadDot label={`${unread} unread in ${workspace.name}`} />
				</span>
			) : null}
		</span>
	);
}

// The "⋯" button sits over the right end of the row and shows on hover, on
// keyboard focus, while its menu is open, and always on touch screens.
const ROW_ACTIONS_BUTTON =
	"absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/workspace-row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 coarse:opacity-100";

/**
 * One workspace in the open sidebar: its mark, name and unread count, with
 * its actions on a "⋯" button and on right-click.
 */
function SidebarWorkspaceRow({
	entry,
	pin,
}: {
	entry: WorkspaceLibraryEntry;
	pin: WorkspaceRowPin;
}) {
	const navigate = useNavigate();
	return (
		<SidebarMenuItem>
			<WorkspaceRowMenu
				workspace={entry.workspace}
				pin={pin}
				className="group/workspace-row relative"
				buttonClassName={ROW_ACTIONS_BUTTON}
			>
				<SidebarMenuButton
					className="pe-9"
					icon={<WorkspaceMark workspace={entry.workspace} />}
					title={entry.workspace.name}
					onClick={() =>
						void navigate({
							to: "/workspace/$workspaceId",
							params: { workspaceId: entry.workspace.id },
						})
					}
				>
					<span className="min-w-0 flex-1 truncate">
						{entry.workspace.name}
					</span>
					<WorkspaceMutedIcon workspaceId={entry.workspace.id} />
					<WorkspaceUnreadBadge
						workspaceId={entry.workspace.id}
						name={entry.workspace.name}
					/>
				</SidebarMenuButton>
			</WorkspaceRowMenu>
		</SidebarMenuItem>
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
	pinFor,
}: {
	entries: WorkspaceLibraryEntry[];
	icon: typeof Star;
	label: string;
	pinFor: (entry: WorkspaceLibraryEntry) => WorkspaceRowPin;
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
							<SidebarWorkspaceRow
								key={entry.workspace.id}
								entry={entry}
								pin={pinFor(entry)}
							/>
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
	const favorite = useSetWorkspaceFavorite();
	const pinFor = (entry: WorkspaceLibraryEntry): WorkspaceRowPin => ({
		pinned: entry.preference?.favorite ?? false,
		disabled: favorite.isPending,
		onToggle: () =>
			favorite.mutate({
				workspaceId: entry.workspace.id,
				favorite: !(entry.preference?.favorite ?? false),
			}),
	});
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
						<SidebarMenuItem key={entry.workspace.id}>
							{/* No room for a "⋯" button on the rail; right-click opens
							    the same menu. */}
							<WorkspaceRowMenu
								workspace={entry.workspace}
								pin={pinFor(entry)}
								showButton={false}
							>
								<SidebarMenuButton
									aria-label={`Open ${entry.workspace.name}`}
									// The 24px mark goes in the ICON slot, never in the label:
									// the label is what Kumo squeezes to zero on a collapsed
									// rail, so a mark rendered as a child would survive as
									// visible text. Padding centres the wider mark in the same
									// 40px row (40 - 2x8 = 24, exactly the chip).
									className="group-data-[state=collapsed]/sidebar:px-2"
									icon={<CollapsedWorkspaceMark workspace={entry.workspace} />}
									onClick={() =>
										void navigate({
											to: "/workspace/$workspaceId",
											params: { workspaceId: entry.workspace.id },
										})
									}
									tooltip={entry.workspace.name}
								/>
							</WorkspaceRowMenu>
						</SidebarMenuItem>
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
							<SidebarWorkspaceRow
								key={entry.workspace.id}
								entry={entry}
								pin={pinFor(entry)}
							/>
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
						pinFor={pinFor}
					/>
				</SidebarMenu>
			) : null}
		</SidebarGroup>
	);
}

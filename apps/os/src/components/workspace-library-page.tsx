import { Archive, Clock, SquaresFour, Star } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CanvasWorkspaceControls } from "@/components/canvas-workspace-controls";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	Collection,
	Page,
	PageActions,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { SearchInput } from "@/components/kumo/search-input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	activeWorkspacesQueryOptions,
	archivedWorkspacesQueryOptions,
	osQuery,
	osQueryKeys,
	workspacePreferencesQueryOptions,
} from "@/lib/os-query-options";
import {
	formatWorkspaceLastOpened,
	groupWorkspaceLibrary,
	workspaceInitials,
} from "@/lib/workspace-library";
import { useState } from "react";

/** Initial workspace window; larger loaded libraries expand in 15-row steps. */
export const WORKSPACES_VISIBLE_PAGE_SIZE = 15;

type LibraryView = "active" | "archived";

const LIBRARY_VIEWS = [
	{ value: "active", label: "Active" },
	{ value: "archived", label: "Archived" },
] as const;

export function WorkspaceLibraryPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [view, setView] = useState<LibraryView>("active");
	const [search, setSearch] = useState("");
	const [visibleLimit, setVisibleLimit] = useState(
		WORKSPACES_VISIBLE_PAGE_SIZE,
	);
	const workspaces = useQuery(activeWorkspacesQueryOptions());
	const preferences = useQuery(workspacePreferencesQueryOptions());
	const favorite = useMutation({
		...osQuery.osWorkspaces.workspacePreferences.setFavorite.mutationOptions(),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspacePreferences(),
			}),
	});
	const groups = groupWorkspaceLibrary(
		workspaces.data?.items ?? [],
		preferences.data?.items ?? [],
		search,
	);
	const displayedWorkspaces = groups.all.slice(0, visibleLimit);
	const changeSearch = (value: string) => {
		setVisibleLimit(WORKSPACES_VISIBLE_PAGE_SIZE);
		setSearch(value);
	};

	return (
		<Page width="lg" className="workspaces-surface">
			<PageHeader>
				<PageHeading>
					<PageTitle>Workspaces</PageTitle>
					<PageDescription>
						Keep your conversations, work, and resources together.
					</PageDescription>
				</PageHeading>
				<PageActions>
					<CanvasWorkspaceControls
						onArchived={() => undefined}
						onSelected={(workspaceId) =>
							void navigate({
								to: "/workspace/$workspaceId",
								params: { workspaceId },
							})
						}
					/>
				</PageActions>
			</PageHeader>

			<SegmentedControl
				ariaLabel="Workspace status"
				compact
				onValueChange={(next) => {
					changeSearch("");
					setView(next);
				}}
				options={LIBRARY_VIEWS}
				value={view}
			/>

			{view === "archived" ? <ArchivedWorkspaces /> : null}
			{view === "active" && workspaces.isPending ? (
				<ListSkeleton rows={4} />
			) : null}
			{view === "active" && workspaces.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Workspaces are unavailable</AlertTitle>
					<AlertDescription>{workspaces.error.message}</AlertDescription>
				</Alert>
			) : null}
			{view === "active" &&
			workspaces.data &&
			workspaces.data.items.length > 0 ? (
				<div className="grid gap-4">
					<SearchInput
						aria-label="Search workspaces"
						containerClassName="w-full sm:max-w-md"
						onChange={(event) => changeSearch(event.target.value)}
						placeholder="Search workspaces…"
						value={search}
					/>
					{groups.all.length > 0 ? (
						<>
							<Collection aria-label="Workspaces">
								{displayedWorkspaces.map(({ workspace, preference }) => {
									const lastOpened = formatWorkspaceLastOpened(
										preference?.lastOpenedAt ?? null,
									);
									return (
										<li
											className="group flex min-w-0 items-center gap-1"
											key={workspace.id}
										>
											<Link
												className="min-w-0 flex-1 justify-start gap-3 px-3 py-2.5 text-left"
												href={`/workspace/${workspace.id}`}
												variant="collection"
											>
												<Text
													as="span"
													role="label"
													weight="medium"
													tone="secondary"
													className="grid size-9 shrink-0 place-items-center rounded-lg bg-kumo-fill"
												>
													{workspaceInitials(workspace.name)}
												</Text>
												<span className="grid min-w-0 flex-1 gap-0.5">
													<Text
														as="strong"
														role="body"
														weight="medium"
														tone="strong"
														className="truncate"
													>
														{workspace.name}
													</Text>
													<Text
														as="span"
														role="label"
														tone="secondary"
														className="truncate"
													>
														{workspace.description || "No description"}
													</Text>
												</span>
												{lastOpened ? (
													<Text
														as="span"
														role="label"
														className="hidden shrink-0 items-center gap-1 text-kumo-inactive sm:flex"
													>
														<Clock size={11} />{" "}
														{lastOpened.replace("Opened ", "")}
													</Text>
												) : null}
											</Link>
											<Button
												aria-label={`${preference?.favorite ? "Remove" : "Add"} ${workspace.name} ${preference?.favorite ? "from" : "to"} favorites`}
												className={
													preference?.favorite ? "text-kumo-link" : undefined
												}
												onClick={() =>
													favorite.mutate({
														workspaceId: workspace.id,
														favorite: !(preference?.favorite ?? false),
													})
												}
												size="icon-sm"
												variant="ghost"
											>
												<Star
													size={15}
													weight={preference?.favorite ? "fill" : "regular"}
												/>
											</Button>
										</li>
									);
								})}
							</Collection>
							{groups.all.length > WORKSPACES_VISIBLE_PAGE_SIZE ? (
								<div
									aria-live="polite"
									className="flex flex-col items-center justify-between gap-2 sm:flex-row"
								>
									<Text as="p" role="label" tone="secondary">
										Showing {displayedWorkspaces.length} of {groups.all.length}{" "}
										workspaces
									</Text>
									{displayedWorkspaces.length < groups.all.length ? (
										<Button
											className="w-full sm:w-auto"
											onClick={() =>
												setVisibleLimit((limit) =>
													Math.min(
														limit + WORKSPACES_VISIBLE_PAGE_SIZE,
														groups.all.length,
													),
												)
											}
											variant="outline"
										>
											Show more
										</Button>
									) : null}
								</div>
							) : null}
						</>
					) : (
						<Empty appearance="quiet">
							<EmptyDescription>
								No workspaces match “{search.trim()}”.
							</EmptyDescription>
						</Empty>
					)}
					{workspaces.data.truncated ? (
						<Text role="body" tone="secondary" className="m-0">
							Showing the first {workspaces.data.items.length}{" "}
							{workspaces.data.items.length === 1 ? "workspace" : "workspaces"}
							{" — more exist beyond this page."}
						</Text>
					) : null}
				</div>
			) : null}
			{view === "active" &&
			workspaces.data &&
			workspaces.data.items.length === 0 ? (
				<Empty appearance="quiet">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<SquaresFour size={20} />
						</EmptyMedia>
						<EmptyTitle>No workspaces yet</EmptyTitle>
						<EmptyDescription>
							Create a workspace or start from a template.
						</EmptyDescription>
					</EmptyHeader>
					<Button
						onClick={() => void navigate({ to: "/blueprints" })}
						size="sm"
						variant="outline"
					>
						Browse templates
					</Button>
				</Empty>
			) : null}
		</Page>
	);
}

/**
 * Archived workspaces and the way back. Archiving changes only the workspace's
 * own status, so a restore returns its outputs, gadgets and resources as they
 * were; the shared `workspaces()` key refreshes every list at once.
 */
function ArchivedWorkspaces() {
	const queryClient = useQueryClient();
	const archived = useQuery(archivedWorkspacesQueryOptions());
	const restore = useMutation({
		...osQuery.osWorkspaces.workspaces.restore.mutationOptions(),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() }),
	});

	if (archived.isPending) return <ListSkeleton rows={4} />;
	if (archived.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Archived workspaces are unavailable</AlertTitle>
				<AlertDescription>{archived.error.message}</AlertDescription>
			</Alert>
		);
	}
	if (archived.data.items.length === 0) {
		return (
			<Empty appearance="quiet">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Archive size={20} />
					</EmptyMedia>
					<EmptyTitle>No archived workspaces</EmptyTitle>
					<EmptyDescription>
						Archived workspaces appear here, and you can restore them with their
						outputs and gadgets.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	return (
		<div className="grid gap-4">
			{restore.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Could not restore the workspace</AlertTitle>
					<AlertDescription>{restore.error.message}</AlertDescription>
				</Alert>
			) : null}
			<Collection aria-label="Archived workspaces">
				{archived.data.items.map((workspace) => {
					const restoring =
						restore.isPending &&
						restore.variables?.workspaceId === workspace.id;
					return (
						<li
							className="flex min-w-0 items-center gap-3 px-3 py-2.5"
							key={workspace.id}
						>
							<Text
								as="span"
								role="label"
								weight="medium"
								tone="secondary"
								className="grid size-9 shrink-0 place-items-center rounded-lg bg-kumo-fill"
							>
								{workspaceInitials(workspace.name)}
							</Text>
							<span className="grid min-w-0 flex-1 gap-0.5">
								<Text
									as="strong"
									role="body"
									weight="medium"
									tone="strong"
									className="truncate"
								>
									{workspace.name}
								</Text>
								<Text
									as="span"
									role="label"
									tone="secondary"
									className="truncate"
								>
									Archived {new Date(workspace.updatedAt).toLocaleDateString()}
								</Text>
							</span>
							<Button
								aria-label={`Restore ${workspace.name}`}
								disabled={restoring}
								onClick={() => restore.mutate({ workspaceId: workspace.id })}
								size="sm"
								variant="outline"
							>
								{restoring ? "Restoring…" : "Restore"}
							</Button>
						</li>
					);
				})}
			</Collection>
			{archived.data.truncated ? (
				<Text role="body" tone="secondary" className="m-0">
					Showing the first {archived.data.items.length} archived workspaces.
				</Text>
			) : null}
		</div>
	);
}

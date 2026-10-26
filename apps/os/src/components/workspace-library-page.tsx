import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { WorkspaceListRow } from "./workspace-list-row";
import { EntityAvatar } from "@/components/entity-avatar";
import {
	Archive,
	Clock,
	Lock,
	Question,
	SquaresFour,
	Star,
} from "@phosphor-icons/react";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CanvasWorkspaceControls } from "@/components/canvas-workspace-controls";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
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
import { SharedWorkspacesList } from "@/components/shared-workspaces-list";
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
} from "@/lib/workspace-library";
import { useEffect, useRef, useState } from "react";

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
	const [restoredAt, setRestoredAt] = useState<ReadonlyMap<string, string>>(
		new Map(),
	);
	const favoriteInFlight = useRef(false);
	const [visibleLimit, setVisibleLimit] = useState(
		WORKSPACES_VISIBLE_PAGE_SIZE,
	);
	// The list query carries the debounced search so matching runs server-side
	// across every workspace the member can open, not only the loaded page.
	const [debouncedSearch, setDebouncedSearch] = useState("");
	useEffect(() => {
		const timeout = window.setTimeout(() => setDebouncedSearch(search), 250);
		return () => window.clearTimeout(timeout);
	}, [search]);
	const normalizedSearch = debouncedSearch.trim() || undefined;
	const workspaces = useQuery({
		...activeWorkspacesQueryOptions(normalizedSearch),
		placeholderData: keepPreviousData,
	});
	// Only a search the server has answered may claim "no match"; while the
	// debounce or the request is still open the loaded rows keep filtering.
	const searchSettled =
		search.trim() === debouncedSearch.trim() && !workspaces.isFetching;
	const preferences = useQuery(workspacePreferencesQueryOptions());
	const [favoriteRefreshFailed, setFavoriteRefreshFailed] = useState(false);
	const favorite = useMutation({
		...osQuery.osWorkspaces.workspacePreferences.setFavorite.mutationOptions(),
		onMutate: async ({ workspaceId, favorite }) => {
			const options = workspacePreferencesQueryOptions();
			await queryClient.cancelQueries(options);
			const previous = queryClient.getQueryData(options.queryKey);
			queryClient.setQueryData(options.queryKey, (old) => ({
				items: [
					...(old?.items ?? []).filter(
						(item) => item.workspaceId !== workspaceId,
					),
					{
						workspaceId,
						favorite,
						lastOpenedAt:
							old?.items.find((item) => item.workspaceId === workspaceId)
								?.lastOpenedAt ?? null,
						updatedAt: new Date().toISOString(),
					},
				],
			}));
			return { previous };
		},
		onError: (_error, _input, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					workspacePreferencesQueryOptions().queryKey,
					context.previous,
				);
			}
		},
		onSettled: () => {
			favoriteInFlight.current = false;
		},
		onSuccess: async ({ preference }) => {
			try {
				queryClient.setQueryData(
					workspacePreferencesQueryOptions().queryKey,
					(previous) =>
						previous
							? {
									items: [
										...previous.items.filter(
											(item) => item.workspaceId !== preference.workspaceId,
										),
										preference,
									],
								}
							: previous,
				);
				await queryClient.invalidateQueries(
					{ queryKey: osQueryKeys.workspacePreferences() },
					{ throwOnError: true },
				);
			} catch {
				setFavoriteRefreshFailed(true);
			}
		},
	});
	const favoritesKnown = preferences.isSuccess && !favoriteRefreshFailed;
	const retryFavorites = async () => {
		const result = await preferences.refetch();
		if (result.isSuccess) setFavoriteRefreshFailed(false);
	};
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
		<Page width="lg">
			<div className="grid min-w-0 gap-4">
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
				{view === "active" &&
				workspaces.data &&
				(workspaces.data.items.length > 0 || normalizedSearch) ? (
					<SearchInput
						aria-label="Search workspaces"
						containerClassName="w-full sm:max-w-md"
						onChange={(event) => changeSearch(event.target.value)}
						placeholder="Search workspaces…"
						value={search}
					/>
				) : null}
			</div>

			{view === "active" ? <SharedWorkspacesList /> : null}
			{view === "archived" ? (
				<ArchivedWorkspaces
					restoredAt={restoredAt}
					onRestored={(id, updatedAt) =>
						setRestoredAt((previous) => new Map(previous).set(id, updatedAt))
					}
				/>
			) : null}
			{view === "active" && workspaces.isPending ? (
				<ListSkeleton rows={4} />
			) : null}
			{view === "active" && workspaces.isError ? (
				<Alert variant={workspaces.data ? "warning" : "destructive"}>
					<AlertTitle>
						{workspaces.data
							? "Workspaces could not refresh"
							: "Workspaces are unavailable"}
					</AlertTitle>
					<AlertDescription className="break-words">
						{workspaces.data ? "Showing previously loaded workspaces. " : null}
						{workspaces.error.message}
					</AlertDescription>
					<Button
						disabled={workspaces.isFetching}
						onClick={() => void workspaces.refetch()}
						variant="outline"
					>
						Retry workspaces
					</Button>
				</Alert>
			) : null}
			{view === "active" &&
			(preferences.isPending ||
				preferences.isError ||
				favoriteRefreshFailed ||
				favorite.isPending ||
				favorite.isError ||
				favorite.isSuccess) ? (
				<div className="grid gap-4" aria-live="polite">
					{preferences.isPending ? (
						<Text role="body" tone="secondary">
							Loading favorites… Workspace browsing is available.
						</Text>
					) : null}
					{preferences.isError || favoriteRefreshFailed ? (
						<Alert variant="warning">
							<AlertTitle>
								{favoriteRefreshFailed
									? "Favorite saved; favorites could not refresh"
									: "Favorites are unavailable"}
							</AlertTitle>
							<AlertDescription className="break-words">
								Favorite state is unverified. You can still open workspaces.{" "}
								{preferences.error?.message}
							</AlertDescription>
							<Button
								disabled={preferences.isFetching}
								onClick={() => void retryFavorites()}
								variant="outline"
							>
								Retry favorites
							</Button>
						</Alert>
					) : null}
					{favorite.isPending ? (
						<Text role="body" tone="secondary">
							Saving favorite…
						</Text>
					) : null}
					{favorite.isError ? (
						<Alert variant="destructive">
							<AlertTitle>Could not save favorite</AlertTitle>
							<AlertDescription className="break-words">
								{favorite.error.message}
							</AlertDescription>
						</Alert>
					) : null}
					{favorite.isSuccess && !favoriteRefreshFailed ? (
						<Text role="body" tone="secondary">
							Favorite saved.
						</Text>
					) : null}
				</div>
			) : null}
			{view === "active" &&
			workspaces.data &&
			(workspaces.data.items.length > 0 || normalizedSearch) ? (
				<div className="grid gap-4">
					{groups.all.length > 0 ? (
						<>
							<Collection aria-label="Workspaces">
								{displayedWorkspaces.map(({ workspace, preference }) => {
									const lastOpened = formatWorkspaceLastOpened(
										preference?.lastOpenedAt ?? null,
									);
									return (
										<WorkspaceListRow
											className="group gap-1 p-0"
											key={workspace.id}
										>
											<Link
												className="min-w-0 flex-1 justify-start gap-3 px-3 py-3 text-left"
												href={`/workspace/${workspace.id}`}
												variant="collection"
											>
												<WorkspaceIdentity
													workspace={workspace}
													description={
														workspace.description || "No description"
													}
												/>
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
												aria-label={
													favoritesKnown
														? `${preference?.favorite ? "Remove" : "Add"} ${workspace.name} ${preference?.favorite ? "from" : "to"} favorites`
														: `Favorites unavailable for ${workspace.name}`
												}
												aria-pressed={
													favoritesKnown
														? (preference?.favorite ?? false)
														: undefined
												}
												title={
													favoritesKnown
														? `${preference?.favorite ? "Remove from" : "Add to"} favorites`
														: "Favorite state is unverified"
												}
												disabled={!favoritesKnown || favorite.isPending}
												className={
													favoritesKnown && preference?.favorite
														? "text-kumo-link"
														: "text-kumo-subtle"
												}
												onClick={() => {
													if (!favoritesKnown || favoriteInFlight.current)
														return;
													favoriteInFlight.current = true;
													favorite.mutate({
														workspaceId: workspace.id,
														favorite: !(preference?.favorite ?? false),
													});
												}}
												size="icon-sm"
												variant="ghost"
											>
												{favoritesKnown ? (
													<Star
														size={15}
														weight={preference?.favorite ? "fill" : "regular"}
													/>
												) : (
													<Question size={15} />
												)}
											</Button>
										</WorkspaceListRow>
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
					) : workspaces.isSuccess && searchSettled ? (
						<Empty
							appearance="quiet"
							title="No matching workspaces"
							description={`No workspaces match “${normalizedSearch ?? search.trim()}”.`}
						/>
					) : null}
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
			workspaces.isSuccess &&
			workspaces.data.items.length === 0 &&
			!normalizedSearch ? (
				<Empty
					appearance="quiet"
					icon={<SquaresFour size={20} />}
					title={
						workspaces.data.truncated
							? "No workspaces in this loaded page"
							: "No workspaces yet"
					}
					description={
						workspaces.data.truncated
							? "More workspaces may exist beyond this page."
							: "Create a workspace or start from a template."
					}
				>
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
function ArchivedWorkspaces({
	restoredAt,
	onRestored,
}: {
	restoredAt: ReadonlyMap<string, string>;
	onRestored: (id: string, updatedAt: string) => void;
}) {
	const queryClient = useQueryClient();
	const archived = useQuery(archivedWorkspacesQueryOptions());
	const [restoreRefreshFailed, setRestoreRefreshFailed] = useState(false);
	const restoreInFlight = useRef(false);
	const restore = useMutation({
		...osQuery.osWorkspaces.workspaces.restore.mutationOptions(),
		onSettled: () => {
			restoreInFlight.current = false;
		},
		onSuccess: async ({ workspace }, variables) => {
			onRestored(variables.workspaceId, workspace.updatedAt);
			try {
				queryClient.setQueryData(
					archivedWorkspacesQueryOptions().queryKey,
					(previous) =>
						previous
							? {
									...previous,
									items: previous.items.filter(
										(workspace) => workspace.id !== variables.workspaceId,
									),
								}
							: previous,
				);
				await queryClient.invalidateQueries(
					{ queryKey: osQueryKeys.workspaces() },
					{ throwOnError: true },
				);
				setRestoreRefreshFailed(false);
			} catch {
				setRestoreRefreshFailed(true);
			}
		},
	});
	const retryArchive = async () => {
		const result = await archived.refetch();
		if (result.isSuccess) setRestoreRefreshFailed(false);
	};

	const visibleArchived =
		archived.data?.items.filter((workspace) => {
			const confirmedRestore = restoredAt.get(workspace.id);
			return (
				!confirmedRestore ||
				Date.parse(workspace.updatedAt) > Date.parse(confirmedRestore)
			);
		}) ?? [];
	if (archived.isPending) return <ListSkeleton rows={4} />;

	return (
		<div className="grid gap-4">
			{archived.isError || restoreRefreshFailed ? (
				<Alert variant="warning">
					<AlertTitle>
						{restoreRefreshFailed
							? "Workspace restored; some workspace lists could not refresh"
							: archived.data
								? "Archived workspaces could not refresh"
								: "Archived workspaces are unavailable"}
					</AlertTitle>
					<AlertDescription className="break-words">
						{archived.data ? "Showing previously loaded workspaces. " : null}
						{archived.error?.message}
					</AlertDescription>
					<Button
						disabled={archived.isFetching}
						onClick={() => void retryArchive()}
						variant="outline"
					>
						Retry archived workspaces
					</Button>
				</Alert>
			) : null}
			{restore.isSuccess && !restoreRefreshFailed ? (
				<Text role="body" tone="secondary">
					Workspace restored.
				</Text>
			) : null}
			{archived.isSuccess &&
			!restoreRefreshFailed &&
			archived.data.items.length === 0 ? (
				<Empty
					appearance="quiet"
					icon={<Archive size={20} />}
					title={
						archived.data.truncated
							? "No archived workspaces in this loaded page"
							: "No archived workspaces"
					}
					description={
						archived.data.truncated
							? "More archived workspaces may exist beyond this page."
							: "Archived workspaces appear here, and you can restore them with their outputs and apps."
					}
				></Empty>
			) : null}
			{restore.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Could not restore the workspace</AlertTitle>
					<AlertDescription>{restore.error.message}</AlertDescription>
				</Alert>
			) : null}
			{restoredAt.size > 0 && visibleArchived.length === 0 ? (
				<Text role="body" tone="secondary">
					Restored workspaces are no longer in this archive list.
				</Text>
			) : null}
			{visibleArchived.length > 0 ? (
				<Collection aria-label="Archived workspaces">
					{visibleArchived.map((workspace) => {
						const restoring =
							restore.isPending &&
							restore.variables?.workspaceId === workspace.id;
						return (
							<WorkspaceListRow key={workspace.id}>
								<WorkspaceIdentity
									workspace={workspace}
									description={`Archived ${new Date(workspace.updatedAt).toLocaleDateString()}`}
								/>
								<Button
									aria-label={`Restore ${workspace.name}`}
									disabled={
										restore.isPending ||
										restoreRefreshFailed ||
										archived.isError
									}
									onClick={() => {
										if (restoreInFlight.current) return;
										restoreInFlight.current = true;
										restore.mutate({ workspaceId: workspace.id });
									}}
									size="sm"
									variant="outline"
								>
									{restoring ? "Restoring…" : "Restore"}
								</Button>
							</WorkspaceListRow>
						);
					})}
				</Collection>
			) : null}
			{archived.data?.truncated ? (
				<Text role="body" tone="secondary" className="m-0">
					{visibleArchived.length > 0 ? (
						<>Showing the first {visibleArchived.length} archived workspaces.</>
					) : (
						"Archive results are limited to the loaded page. Refresh to check for more."
					)}
				</Text>
			) : null}
		</div>
	);
}

/** A private workspace is visible only to the member who owns it. */
function PrivateWorkspaceBadge() {
	return (
		<Text
			as="span"
			role="label"
			tone="secondary"
			className="flex shrink-0 items-center gap-1"
			title="Private: only you and your own tedis and agents can see this workspace"
		>
			<Lock size={11} aria-hidden="true" />
			Only you
		</Text>
	);
}

function WorkspaceIdentity({
	workspace,
	description,
}: {
	workspace: Pick<OsWorkspace, "id" | "name" | "visibility">;
	description: string;
}) {
	return (
		<>
			<EntityAvatar
				id={workspace.id}
				name={workspace.name}
				role={workspace.visibility === "private" ? "private" : undefined}
				kind="workspace"
				className="size-9"
			/>
			<span className="grid min-w-0 flex-1 gap-0.5">
				<span className="flex min-w-0 flex-wrap items-center gap-2">
					<Text
						as="strong"
						role="body"
						weight="medium"
						tone="strong"
						className="break-words [overflow-wrap:anywhere]"
					>
						{workspace.name}
					</Text>
					{workspace.visibility === "private" ? (
						<PrivateWorkspaceBadge />
					) : null}
				</span>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="break-words [overflow-wrap:anywhere]"
				>
					{description}
				</Text>
			</span>
		</>
	);
}

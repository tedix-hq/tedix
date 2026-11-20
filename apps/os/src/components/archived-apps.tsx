import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	Alert,
	AlertDescription,
	AlertTitle,
	LoadError,
} from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";

export function ArchivedApps() {
	const queryClient = useQueryClient();
	const workspaces = useQuery(
		osQuery.osWorkspaces.workspaces.list.queryOptions({
			input: { limit: 200 },
		}),
	);
	const lists = useQueries({
		queries: (workspaces.data?.items ?? []).map((workspace) =>
			osQuery.osWorkspaces.gadgets.list.queryOptions({
				input: { workspaceId: workspace.id, status: "archived", limit: 200 },
			}),
		),
	});
	const restore = useMutation({
		...osQuery.osWorkspaces.gadgets.restore.mutationOptions(),
		onSuccess: async (_, input) => {
			queryClient.setQueryData(
				osQuery.osWorkspaces.gadgets.list.queryOptions({
					input: {
						workspaceId: input.workspaceId,
						status: "archived",
						limit: 200,
					},
				}).queryKey,
				(previous) =>
					previous
						? {
								...previous,
								items: previous.items.filter(
									(app) => app.id !== input.gadgetId,
								),
							}
						: previous,
			);
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() });
		},
	});
	const failed = workspaces.isError || lists.some((list) => list.isError);
	const pending = workspaces.isPending || lists.some((list) => list.isPending);
	const items = lists.flatMap((list, index) =>
		(list.data?.items ?? []).map((app) => ({
			app,
			workspace: workspaces.data!.items[index]!,
		})),
	);
	return (
		<section aria-label="Archived apps" className="space-y-3">
			<Text role="section" as="h2">
				Archived apps
			</Text>
			{pending ? <ListSkeleton rows={2} /> : null}
			{failed ? (
				<LoadError
					title="Archived apps could not load"
					onRetry={() => {
						void workspaces.refetch();
						for (const list of lists) void list.refetch();
					}}
				/>
			) : null}
			{restore.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Could not restore the app</AlertTitle>
					<AlertDescription>{restore.error.message}</AlertDescription>
				</Alert>
			) : null}
			{restore.isSuccess ? <Text>App restored.</Text> : null}
			{!pending && !failed && items.length === 0 ? (
				<Text tone="secondary">No archived apps in the loaded workspaces.</Text>
			) : null}
			<ul className="space-y-2">
				{items.map(({ app, workspace }) => (
					<li
						key={app.id}
						className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
					>
						<div>
							<Text>{app.name}</Text>
							<Text tone="secondary">
								{workspace.name}
								{workspace.status === "archived" ? " · Archived workspace" : ""}
							</Text>
						</div>
						<Button
							variant="secondary"
							disabled={restore.isPending || failed}
							aria-label={`Restore ${app.name}`}
							onClick={() =>
								restore.mutate({ workspaceId: workspace.id, gadgetId: app.id })
							}
						>
							Restore
						</Button>
					</li>
				))}
			</ul>
			{workspaces.data?.truncated ||
			lists.some((list) => list.data?.truncated) ? (
				<Text tone="secondary">
					More archived apps may exist beyond this loaded page.
				</Text>
			) : null}
		</section>
	);
}

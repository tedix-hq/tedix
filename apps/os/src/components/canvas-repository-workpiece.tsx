import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { WorkRepositoryReview } from "@/components/work-repository-review";
import {
	osQuery,
	workItemDetailQueryOptions,
	type WorkFactoryCursor,
} from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

/** Canvas displays the existing Work's repository; it creates no execution authority. */
export function CanvasRepositoryWorkpiece({
	workspaceId,
	workItemId,
	attemptId,
}: {
	workspaceId: string;
	workItemId: string;
	attemptId: string;
}) {
	const authority = useOsOperationalContext().data?.authority;
	const allowed = Boolean(
		(authority?.role === "owner" || authority?.role === "admin") &&
		authority.permissions.includes("secrets:manage"),
	);
	const work = useQuery({
		...workItemDetailQueryOptions(workItemId),
		enabled: allowed,
	});
	const belongs = work.data?.workItem.provenance?.workspaceId === workspaceId;
	const attempts = useInfiniteQuery({
		...osQuery.workItems.listAttempts.infiniteOptions({
			input: (cursor: WorkFactoryCursor | undefined) => ({
				id: workItemId,
				limit: 50,
				cursor,
			}),
			initialPageParam: undefined as WorkFactoryCursor | undefined,
			getNextPageParam: (page) => page.nextCursor ?? undefined,
		}),
		enabled: allowed && belongs,
	});
	const attempt = attempts.data?.pages
		.flatMap((page) => page.data)
		.find((row) => row.id === attemptId);
	if (!allowed)
		return (
			<Text>
				Repository review requires owner or admin access and secrets management
				permission.
			</Text>
		);
	if (work.isPending) return <Text>Loading coding work…</Text>;
	if (work.isError || !belongs)
		return <Text>This coding Work is unavailable in this workspace.</Text>;
	return (
		<section
			className="grid min-w-0 gap-3 p-4"
			aria-label="Repository workpiece"
		>
			<Text>{work.data.workItem.title}</Text>
			<Link href={`/work/items/${workItemId}`}>Open Work</Link>
			{attempt ? (
				<WorkRepositoryReview workItemId={workItemId} attempt={attempt} />
			) : attempts.isError ? (
				<Text>Repository session unavailable.</Text>
			) : attempts.isPending ? (
				<Text>Loading repository session…</Text>
			) : attempts.hasNextPage ? (
				<Button
					disabled={attempts.isFetchingNextPage}
					onClick={() => void attempts.fetchNextPage()}
				>
					Find session in older work history
				</Button>
			) : (
				<Text>This repository session is not recorded on this Work.</Text>
			)}
		</section>
	);
}

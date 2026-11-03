import { useEffect, useRef } from "react";
import {
	WorkspaceVerificationPausedContext,
	useWorkspaceVerificationPaused,
	isWorkspaceAccessDenied,
} from "@/lib/workspace-verification";
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
	const authorityQuery = useOsOperationalContext();
	const authority = authorityQuery.data?.authority;
	const inheritedPause = useWorkspaceVerificationPaused();
	const retainedReview = useRef<string | null>(null);
	const scope = `${workItemId}:${attemptId}`;
	const allowed = Boolean(
		(authority?.role === "owner" || authority?.role === "admin") &&
		authority.permissions.includes("secrets:manage"),
	);
	const work = useQuery({
		...workItemDetailQueryOptions(workItemId),
		enabled: allowed && !inheritedPause,
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
		enabled: allowed && belongs && !inheritedPause,
	});
	const attempt = attempts.data?.pages
		.flatMap((page) => page.data)
		.find((row) => row.id === attemptId);
	const denied = [work, attempts, authorityQuery].some(
		(query) => query.isError && isWorkspaceAccessDenied(query.error),
	);
	const transient =
		!denied && (work.isError || attempts.isError || authorityQuery.isError);
	const paused = inheritedPause || transient;
	useEffect(() => {
		if (allowed && belongs && attempt && !paused)
			retainedReview.current = scope;
		if (denied || !allowed || !belongs) retainedReview.current = null;
	}, [allowed, belongs, attempt, paused, denied, scope]);
	if (!allowed)
		return (
			<Text>
				Repository review requires owner or admin access and secrets management
				permission.
			</Text>
		);
	if (work.isPending) return <Text>Loading coding work…</Text>;
	if (
		!work.data ||
		denied ||
		!belongs ||
		(transient && retainedReview.current !== scope)
	)
		return <Text>This coding Work is unavailable in this workspace.</Text>;
	return (
		<WorkspaceVerificationPausedContext.Provider value={paused}>
			{transient && (
				<div role="alert">
					<Text>
						Coding work could not be verified. Editing is paused; your open code
						is kept here.
					</Text>
					<Button
						size="sm"
						onClick={() => {
							void work.refetch();
							void attempts.refetch();
							void authorityQuery.refetch();
						}}
					>
						Verify coding work again
					</Button>
				</div>
			)}
			<div
				className="contents"
				inert={paused}
				data-repository-verification-paused={paused || undefined}
			>
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
			</div>
		</WorkspaceVerificationPausedContext.Provider>
	);
}

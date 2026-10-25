import { useQuery } from "@tanstack/react-query";
import {
	DelegationWorkCard,
	type DelegationWork,
} from "@/components/chat-cards";
import { delegationLiveState } from "@/lib/delegation-activity";
import { homeChildRunActivityQueryOptions } from "@/lib/os-query-options";
import { useNow } from "@/lib/use-now";

/** How often a running delegation re-reads its delegated tedi's events. */
const ACTIVITY_POLL_MS = 5_000;

/**
 * A running delegation with its live state: the parent run's progress and
 * timing plus the delegated tedi's own newest events, re-read while it runs.
 * A failed activity read degrades to the parent-run state; it never hides the
 * card or its controls.
 */
export function LiveDelegationCard({
	work,
	tediName,
	onStop,
	onRetry,
	pending,
}: {
	work: DelegationWork;
	tediName?: string | null;
	onStop?: () => void;
	onRetry?: () => void;
	pending?: boolean;
}) {
	const active =
		work.status === "queued" ||
		work.status === "running" ||
		work.status === "requires_approval";
	const activity = useQuery({
		...homeChildRunActivityQueryOptions(
			work.delegatedTediId ?? "",
			work.childRunId ?? "",
		),
		enabled: Boolean(work.delegatedTediId && work.childRunId),
		refetchInterval: active ? ACTIVITY_POLL_MS : false,
		retry: false,
	});
	const now = useNow(active);
	const evidence = activity.data?.evidence;
	const live = delegationLiveState({
		run: {
			status: work.status,
			createdAt: work.timing?.createdAt ?? new Date(now).toISOString(),
			startedAt: work.timing?.startedAt,
			completedAt: work.timing?.completedAt,
			updatedAt: work.timing?.updatedAt,
			progress: work.timing?.progress,
			usage: work.timing?.usage,
		},
		events: evidence?.events,
		latestEventAt: evidence?.latestEventAt,
		now,
	});
	return (
		<DelegationWorkCard
			work={work}
			tediName={tediName}
			live={live}
			onStop={onStop}
			onRetry={onRetry}
			pending={pending}
		/>
	);
}

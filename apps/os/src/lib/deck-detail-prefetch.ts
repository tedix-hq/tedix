import type { QueryClient } from "@tanstack/react-query";
import {
	osQuery,
	workInteractionDetailQueryOptions,
} from "@/lib/os-query-options";

export const DECK_DETAIL_WINDOW = 4;
type Job = { users: number; started: boolean };
type Queue = { jobs: Map<string, Job>; running: boolean };
const queues = new WeakMap<QueryClient, Queue>();
const detailOptions = (id: string) =>
	id.startsWith("approval:")
		? osQuery.tediApprovals.getById.queryOptions({
				input: { id: id.slice("approval:".length) },
			})
		: workInteractionDetailQueryOptions(id);

/** Mounted decks share one speculative request; visible detail reads take priority. */
export function prefetchDeckDetails(
	client: QueryClient,
	ids: readonly string[],
) {
	let queue = queues.get(client);
	if (!queue) queues.set(client, (queue = { jobs: new Map(), running: false }));
	const owned = [...new Set(ids)]
		.slice(0, DECK_DETAIL_WINDOW)
		.filter((id) => !id.startsWith("work-approval:"))
		.map((id) => {
			let job = queue.jobs.get(id);
			if (job) job.users++;
			else queue.jobs.set(id, (job = { users: 1, started: false }));
			return { id, job };
		});
	const pump = async () => {
		if (queue.running) return;
		queue.running = true;
		try {
			for (const [id, job] of queue.jobs) {
				if (!job.users) continue;
				job.started = true;
				if (id.startsWith("approval:"))
					await client.prefetchQuery({
						...osQuery.tediApprovals.getById.queryOptions({
							input: { id: id.slice("approval:".length) },
						}),
						staleTime: 60_000,
					});
				else
					await client.prefetchQuery({
						...workInteractionDetailQueryOptions(id),
						staleTime: 60_000,
					});
				if (queue.jobs.get(id) === job) queue.jobs.delete(id);
			}
		} finally {
			queue.running = false;
		}
	};
	void pump();
	return () => {
		for (const { id, job } of owned) {
			if (--job.users > 0 || queue.jobs.get(id) !== job) continue;
			queue.jobs.delete(id);
			const options = detailOptions(id);
			const query = client.getQueryCache().find(options);
			if (job.started && query?.getObserversCount() === 0)
				void client.cancelQueries({ queryKey: options.queryKey, exact: true });
		}
	};
}

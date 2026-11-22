import { useEffect } from "react";
import {
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { userProfileQueryOptions } from "@/lib/os-query-options";

type Routing = Parameters<
	typeof osApi.learningFeedback.recordDeckRoutings
>[0]["routes"][number];
const receipts = new WeakMap<QueryClient, Set<string>>();

/** Record both admitted and withheld cards without treating routing as a human vote. */
export function useDeckRoutingAudit(rows: readonly Routing[]) {
	const client = useQueryClient();
	const profile = useQuery({
		...userProfileQueryOptions(),
		enabled: rows.length > 0,
	});
	const userId = profile.data?.id;
	const recorded = receipts.get(client) ?? new Set<string>();
	receipts.set(client, recorded);
	const decisions = JSON.stringify(rows);
	useEffect(() => {
		if (!userId) return;
		let active = true;
		const record = async () => {
			const pending = new Map<string, Routing>();
			for (const row of JSON.parse(decisions) as Routing[]) {
				const key = `tedix:deck-routing:v2:${JSON.stringify([userId, row.id])}`;
				if (recorded.has(key)) continue;
				try {
					if (localStorage.getItem(key)) continue;
				} catch {
					// Restricted storage still gets per-QueryClient deduplication.
				}
				pending.set(key, row);
			}
			const entries = [...pending];
			for (let start = 0; start < entries.length; start += 100) {
				if (!active) break;
				const batch = entries.slice(start, start + 100);
				for (const [key] of batch) recorded.add(key);
				try {
					await osApi.learningFeedback.recordDeckRoutings({
						routes: batch.map(([, row]) => row),
					});
					for (const [key] of batch) {
						try {
							localStorage.setItem(key, "1");
						} catch {
							// Keep the in-memory receipt when storage is full or disabled.
						}
					}
				} catch {
					for (const [key] of batch) recorded.delete(key);
					break;
				}
			}
		};
		// Recheck persistent receipts inside the lock shared by this person's tabs.
		void (navigator.locks
			? navigator.locks.request(`tedix:deck-routing:${userId}`, record)
			: record());
		return () => {
			active = false;
		};
	}, [decisions, recorded, userId]);
}

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";

type Routing = {
	id: string;
	destination: string;
	reason: string;
	policyVersion: number;
	classId: string;
};

const receipts = new WeakMap<QueryClient, Set<string>>();

/** Record both admitted and withheld cards without treating routing as a human vote. */
export function useDeckRoutingAudit(rows: readonly Routing[]) {
	const client = useQueryClient();
	const recorded = receipts.get(client) ?? new Set<string>();
	receipts.set(client, recorded);
	const decisions = JSON.stringify(
		rows.map(({ id, destination, reason, policyVersion, classId }) => ({
			id,
			destination,
			reason,
			policyVersion,
			classId,
		})),
	);
	useEffect(() => {
		let active = true;
		void (async () => {
			for (const row of JSON.parse(decisions) as Routing[]) {
				if (!active) break;
				const key = JSON.stringify(row);
				if (recorded.has(key)) continue;
				recorded.add(key);
				try {
					const digest = await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(key),
					);
					const hash = Array.from(new Uint8Array(digest), (byte) =>
						byte.toString(16).padStart(2, "0"),
					).join("");
					await osApi.learningFeedback.recordInteraction({
						clientEventId: `deck-routing:${hash}`,
						scope: { kind: "personal" },
						surface: "decision_deck_routing",
						eventKind: "delivered",
						issueKey: `deck:${row.classId}`,
						targetType: "deck_candidate",
						targetId: row.id,
						metadata: {
							destination: row.destination,
							routingReason: row.reason,
							policyVersion: row.policyVersion,
							decisionClass: row.classId,
							classId: row.classId,
						},
					});
				} catch {
					recorded.delete(key);
				}
			}
		})();
		return () => {
			active = false;
		};
	}, [decisions, recorded]);
}

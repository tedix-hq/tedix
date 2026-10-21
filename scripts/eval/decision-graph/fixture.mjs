export function fixture() {
	const observedAt = "2026-10-21T12:00:00.000Z";
	const rows = [],
		labels = [];
	/** @type {Record<string, import("@tedix/api-contract/schemas/decision-graph").DecisionContext>} */
	const contexts = {};
	const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	function card(n, createdAt = "2026-10-20T12:00:00.000Z") {
		const request = {
			id: id(n),
			kind: "question",
			subject: `Cedar task ${n}`,
			prompt: `Which option for task ${n}? Recommend option one.`,
			creatorType: "external_agent",
			creatorId: id(999),
			workItemId: id(1000 + n),
			dueAt: null,
			expiresAt: null,
			requestedAt: createdAt,
			metadata: {},
		};
		rows.push({
			request,
			effectiveState: "open",
			workItem: { disposition: "accepted" },
		});
		contexts[request.id] = {
			cardId: request.id,
			chain: [],
			duplicates: [],
			blocksCount: 0,
		};
		return request.id;
	}
	function link(cardId, n, kind) {
		const node = {
			kind: kind === "supersedes" ? "deck_card" : "decision",
			id: id(n),
		};
		return {
			node,
			edge: {
				id: id(n + 5000),
				kind,
				from: kind === "supersedes" ? node : { kind: "deck_card", id: cardId },
				to: kind === "supersedes" ? { kind: "deck_card", id: cardId } : node,
				source: "fixture",
				confidence: 1,
				evidenceRef: `fixture:${n}`,
				note: "Fictional recorded fact",
				occurredAt: "2026-10-19T12:00:00.000Z",
				createdAt: observedAt,
			},
		};
	}
	for (let i = 0; i < 20; i++) {
		const decided = card(i + 1),
			older = card(i + 21),
			newer = card(i + 41, "2026-10-21T08:00:00.000Z"),
			stale = card(i + 61);
		contexts[decided].priorDecision = link(decided, i + 201, "decided_by");
		contexts[older].duplicates = [newer];
		contexts[newer].duplicates = [older];
		contexts[newer].blocksCount = i;
		contexts[stale].supersededBy = link(stale, i + 301, "supersedes");
		for (const [cardId, rule] of [
			[decided, "already_decided"],
			[older, "duplicate"],
			[stale, "stale"],
		])
			labels.push({
				cardId,
				rule,
				correct: i !== 19,
				evidenceRef: `fixture-owner-feedback:${i}:${rule}`,
				sourceType: "fixture_owner_feedback",
				observedAt,
				note:
					i === 19
						? "Fictional counterexample: owner kept the ask."
						: "Fictional owner record independently confirms the rule.",
			});
	}
	return {
		snapshot: {
			mode: "fixture",
			observedAt,
			timeZone: "UTC",
			rows,
			contexts,
			currentIds: rows.map((r) => r.request.id),
			baselineConfigSource: "versioned defaults; fictional fixture",
			coverage: { historyComplete: true, currentComplete: true, pages: 1 },
		},
		labels,
	};
}

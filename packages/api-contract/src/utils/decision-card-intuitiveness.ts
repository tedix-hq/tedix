/** Only explicit, personally attributed decision observations count. Unknown history stays unknown. */
export function decisionCardIntuitiveness(
	events: readonly {
		id: string;
		surface: string;
		actorId?: string | null;
		scopeKind: string;
		scopeId?: string | null;
		targetId?: string | null;
		eventKind: string;
		metadata?: Record<string, unknown> | null;
	}[],
	personId: string | null,
) {
	const observations = new Map<string, { classId: string; alone: boolean }>();
	for (const event of events) {
		const meta = event.metadata;
		if (
			!personId ||
			event.scopeKind !== "personal" ||
			event.scopeId !== personId ||
			event.actorId !== personId ||
			!["decision_deck_action", "decision_deck"].includes(event.surface) ||
			!["accepted", "rejected", "edited"].includes(event.eventKind) ||
			["later", "skip"].includes(String(meta?.decisionChoice)) ||
			typeof meta?.railOpenedBeforeDecision !== "boolean"
		)
			continue;
		observations.set(
			event.surface === "decision_deck"
				? `${event.targetId}:${meta.rowIndex}`
				: (event.targetId ?? event.id),
			{
				classId: String(meta.decisionClass ?? "decision"),
				alone: !meta.railOpenedBeforeDecision,
			},
		);
	}
	const classes = new Map<
		string,
		{ classId: string; decisions: number; fromCard: number }
	>();
	for (const observation of observations.values()) {
		const row = classes.get(observation.classId) ?? {
			classId: observation.classId,
			decisions: 0,
			fromCard: 0,
		};
		row.decisions++;
		if (observation.alone) row.fromCard++;
		classes.set(row.classId, row);
	}
	const decisions = observations.size;
	const fromCard = [...observations.values()].filter((row) => row.alone).length;
	return {
		decisions,
		fromCard,
		percent: decisions ? Math.round((100 * fromCard) / decisions) : null,
		classes: [...classes.values()].map((row) => ({
			...row,
			needsBetterSummary: row.fromCard / row.decisions < 0.8,
		})),
	};
}

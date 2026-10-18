import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getDecisionLearningConfig,
	getDecisionExposure,
	insertDecisionExposure,
	insertDecisionOutcomeLabel,
	listDecisionInstrumentationSources,
	listDecisionInstrumentation,
	listUnlabelledDecisionResponses,
	listUnlabelledDecisionApprovals,
	listUnlabelledDecisionDeferrals,
	listDueDecisionLabels,
	getDecisionLabelEvidence,
	pruneDecisionInstrumentation,
	getDecisionDeferralTime,
} from "@tedix/db/queries/decision-learning";
import { listDecisionCardPresentations } from "@tedix/db/queries/work-items/card-presentation";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import type {
	DecisionExposureInput,
	DecisionSnapshot,
	DecisionOutcome,
} from "@tedix/api-contract/schemas/decision-learning";

export async function recordDecisionExposure(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		mayReadApprovals: boolean;
		input: DecisionExposureInput;
	},
	now = new Date(),
) {
	const { input } = p;
	const id = `${p.organizationId}:${p.actorId}:${input.clientEventId}`;
	const existing = await getDecisionExposure(db, {
		organizationId: p.organizationId,
		actorId: p.actorId,
		id,
	});
	if (existing) {
		if (JSON.stringify(existing.context) !== JSON.stringify(input))
			throw new Error("Exposure id was already used for different context");
		return { id: existing.id };
	}
	if (
		new Set(input.candidates.map((c) => c.cardId)).size !==
			input.candidates.length ||
		input.candidates.filter((c) => c.reason === "shown").length !== 1 ||
		input.candidateCount < input.candidates.length ||
		!input.candidates.some(
			(c) => c.cardId === input.cardId && c.reason === "shown",
		) ||
		(input.candidateSetComplete &&
			input.candidateCount !== input.candidates.length)
	)
		throw new Error("Invalid candidate inventory");
	const sources = await listDecisionInstrumentationSources(db, {
		...p,
		cardIds: [
			...new Set([input.cardId, ...input.candidates.map((c) => c.cardId)]),
		],
	});
	const valid = new Set([
		...sources.interactions.map((r) => r.id),
		...sources.proposals.map((r) => `work-approval:${r.id}`),
		...sources.approvals.map((r) => `approval:${r.id}`),
	]);
	if (
		!valid.has(input.cardId) ||
		input.candidates.some((c) => !valid.has(c.cardId))
	)
		throw new Error("Decision source is unavailable to this person");
	const request = sources.interactions.find((r) => r.id === input.cardId);
	const proposal = sources.proposals.find(
		(r) => `work-approval:${r.id}` === input.cardId,
	);
	const approval = sources.approvals.find(
		(r) => `approval:${r.id}` === input.cardId,
	);
	if (
		(request && request.version !== input.sourceVersion) ||
		(proposal && proposal.version !== input.sourceVersion)
	)
		throw new Error("Card changed before exposure was recorded");
	const envelope = DecisionEnvelopeSchema.safeParse(
		request?.metadata.decisionDeck,
	).data;
	const [displayCopy] = await listDecisionCardPresentations(db, {
		orgId: p.organizationId,
		personId: p.actorId,
		requests: request ? [request] : [],
	});
	const presentation = DecisionCardPresentationSchema.safeParse(
		displayCopy?.presentation ?? request?.metadata.cardPresentation,
	).data;
	const linkedWork = sources.items.find(
		(w) => w.id === (request?.workItemId ?? proposal?.workItemId),
	);
	const snapshot: DecisionSnapshot = {
		classId:
			envelope?.classId ??
			(typeof request?.metadata.decisionClass === "string"
				? request.metadata.decisionClass
				: (request?.kind ?? "approval")),
		projectId: linkedWork?.projectId ?? request?.projectId ?? null,
		workItemId: request?.workItemId ?? proposal?.workItemId ?? null,
		kind: envelope?.kind ?? request?.kind ?? "approval",
		title: (
			presentation?.title ??
			envelope?.proposal ??
			request?.subject ??
			linkedWork?.title ??
			proposal?.rationale ??
			approval?.description ??
			""
		).slice(0, 1000),
		body:
			(presentation?.body ?? envelope?.preview?.body)?.slice(0, 2000) ?? null,
		options:
			envelope?.options.map((o) => ({
				id: o.id,
				label: o.label,
				intent: o.intent,
				consequence: o.consequence,
			})) ?? [],
		recommendation:
			presentation?.recommendation ?? envelope?.recommendation ?? null,
		confidence: envelope?.confidence ?? null,
		proposerId:
			request?.creatorId ?? proposal?.requesterId ?? approval?.tediId ?? null,
		stakes: {
			reversibility: envelope?.reversibility ?? null,
			blastRadius: envelope?.blastRadius ?? null,
			protectedEffects: envelope?.protectedEffects ?? [],
		},
		urgency: {
			whyNow: envelope?.whyNow ?? null,
			costOfWaiting: envelope?.costOfWaiting ?? null,
			dueAt:
				request?.dueAt ?? proposal?.expiresAt ?? approval?.expiresAt ?? null,
		},
		// The current engine emits ordinal scores, not probabilities. Never relabel its score as confidence.
		prediction: { unchangedApprovalLikelihood: null, modelVersion: null },
	};
	const config = await getDecisionLearningConfig(db, p.organizationId);
	const rows = await insertDecisionExposure(db, {
		id,
		organizationId: p.organizationId,
		actorId: p.actorId,
		cardId: input.cardId,
		sessionId: input.sessionId,
		classId: snapshot.classId,
		snapshot,
		context: input,
		occurredAt: now.toISOString(),
		expiresAt: new Date(
			now.getTime() + config.instrumentationRetentionDays * 86400000,
		).toISOString(),
	});
	const row = rows[0];
	if (!row || JSON.stringify(row.context) !== JSON.stringify(input))
		throw new Error("Exposure id was already used for different context");
	return { id: row.id };
}

function outcomeFromResponse(r: {
	responseId: string;
	exposureId: string;
	respondedAt: string;
	responseKind: string;
	metadata: Record<string, unknown>;
}): DecisionOutcome {
	const m = r.metadata;
	const intent = m.decisionChoice;
	const signal = m.feedbackSignal;
	let label: DecisionOutcome["label"] = "unknown";
	if (intent === "later") label = "later";
	else if (intent === "delegate") label = "decided_for_me";
	else if (intent === "reject" || signal === "rejected" || signal === "reason")
		label = "not_this";
	else if ((intent === "approve" || intent === "change") && signal === "edited")
		label = "edited_then_approved";
	else if (signal === "approve-as-is" || m.draftOutcome === "accepted")
		label = "unchanged_approval";
	else if (m.draftOutcome === "edited" && r.responseKind === "answer")
		label = "edited_then_approved";
	else if (r.responseKind === "answer") label = "decided";
	return {
		label,
		evidenceSource: "canonical_receipt",
		reason: typeof m.feedbackReason === "string" ? m.feedbackReason : null,
		exposureId: r.exposureId,
		receiptId: r.responseId,
		decidedAt: r.respondedAt,
		laterToDecisionMs: null,
	};
}

export async function labelDecisionOutcomes(
	db: DbQueryClient,
	now = new Date(),
) {
	const at = now.toISOString();
	let immediate = 0,
		delayed = 0;
	const responses = await listUnlabelledDecisionResponses(db, at);
	for (const r of responses) {
		const outcome = outcomeFromResponse(r);
		if (outcome.label !== "later") {
			const later = await getDecisionDeferralTime(db, {
				organizationId: r.organizationId,
				actorId: r.actorId,
				cardId: r.cardId,
				before: r.respondedAt,
			});
			outcome.laterToDecisionMs = later
				? Math.max(0, Date.parse(r.respondedAt) - Date.parse(later))
				: null;
		}
		const inserted = await insertDecisionOutcomeLabel(db, {
			id: `${r.organizationId}:${r.responseId}:immediate`,
			organizationId: r.organizationId,
			actorId: r.actorId,
			cardId: r.cardId,
			classId: r.classId,
			window: "immediate",
			outcome,
			observedAt: at,
			dueAt: r.respondedAt,
			expiresAt: r.expiresAt,
		});
		if (inserted) immediate++;
	}
	for (const r of await listUnlabelledDecisionApprovals(db, at)) {
		if (!r.decidedAt) continue;
		const inserted = await insertDecisionOutcomeLabel(db, {
			id: `${r.organizationId}:${r.receiptId}:immediate`,
			organizationId: r.organizationId,
			actorId: r.actorId,
			cardId: r.cardId,
			classId: r.classId,
			window: "immediate",
			outcome: {
				evidenceSource: "canonical_receipt",
				label: r.decision === "approved" ? "unchanged_approval" : "not_this",
				reason: null,
				exposureId: r.exposureId,
				receiptId: r.receiptId,
				decidedAt: r.decidedAt,
				laterToDecisionMs: null,
			},
			observedAt: at,
			dueAt: r.decidedAt,
			expiresAt: r.expiresAt,
		});
		if (inserted) immediate++;
	}
	for (const r of await listUnlabelledDecisionDeferrals(db, at)) {
		const inserted = await insertDecisionOutcomeLabel(db, {
			id: `${r.organizationId}:${r.eventId}:immediate`,
			organizationId: r.organizationId,
			actorId: r.actorId,
			cardId: r.cardId,
			classId: r.classId,
			window: "immediate",
			outcome: {
				label: "later",
				evidenceSource: "browser_report",
				exposureId: r.exposureId,
				receiptId: r.eventId,
				decidedAt: r.occurredAt,
				reason: null,
				laterToDecisionMs: null,
			},
			observedAt: at,
			dueAt: r.occurredAt,
			expiresAt: r.expiresAt,
		});
		if (inserted) immediate++;
	}
	for (const window of ["day_1", "day_7"] as const) {
		for (const row of await listDueDecisionLabels(db, at, window)) {
			const until = new Date(
				Date.parse(row.outcome.decidedAt) +
					(window === "day_1" ? 1 : 7) * 86400000,
			).toISOString();
			const evidence = await getDecisionLabelEvidence(db, {
				organizationId: row.organizationId,
				actorId: row.actorId,
				cardId: row.cardId,
				exposureId: row.outcome.exposureId,
				receiptId: row.outcome.receiptId,
				decidedAt: row.outcome.decidedAt,
				until,
			});
			const inserted = await insertDecisionOutcomeLabel(db, {
				...row,
				id: `${row.id}:${window}`,
				window,
				observedAt: at,
				dueAt: until,
				delayed: {
					revertedOrCorrected: evidence.events.some(
						(e) =>
							["undone", "manually_replaced", "edited"].includes(e.eventKind) ||
							e.metadata?.outcome === "reverted",
					)
						? true
						: null,
					lessonMined: evidence.lessons.length > 0,
					workCompleted: evidence.work?.completedAt
						? evidence.work.completedAt <= until
						: evidence.work
							? false
							: null,
					followUpRaised: evidence.work ? evidence.followUps.length > 0 : null,
					evidenceIds: [
						...evidence.events.map((e) => e.id),
						...evidence.lessons.map((e) => e.id),
						...evidence.followUps.map((e) => e.id),
						...(evidence.work ? [evidence.work.id] : []),
					],
				},
			});
			if (inserted) delayed++;
		}
	}
	await pruneDecisionInstrumentation(db, at);
	return { immediate, delayed };
}

export async function readDecisionCalibration(
	db: DbQueryClient,
	p: { organizationId: string; actorId: string; classId: string },
	now = new Date(),
) {
	const { exposures, labels } = await listDecisionInstrumentation(db, {
		...p,
		now: now.toISOString(),
		limit: 1000,
	});
	const byCard = new Map<string, (typeof labels)[number]>();
	for (const l of [...labels].sort((a, b) =>
		b.outcome.decidedAt.localeCompare(a.outcome.decidedAt),
	))
		if (
			l.window === "immediate" &&
			!["later", "unknown"].includes(l.outcome.label) &&
			!byCard.has(l.cardId)
		)
			byCard.set(l.cardId, l);
	const decided = [...byCard.values()];
	const unchanged = decided.filter(
		(l) => l.outcome.label === "unchanged_approval",
	).length;
	const observations = decided.flatMap((l) => {
		const e = exposures.find((e) => e.id === l.outcome.exposureId);
		const prediction = e?.snapshot.prediction.unchangedApprovalLikelihood;
		return prediction == null
			? []
			: [
					{
						prediction,
						unchanged: l.outcome.label === "unchanged_approval" ? 1 : 0,
					},
				];
	});
	const bins = Array.from({ length: 10 }, (_, i) => {
		const rows = observations.filter(
			(o) => Math.min(9, Math.floor(o.prediction * 10)) === i,
		);
		return {
			lower: i / 10,
			upper: (i + 1) / 10,
			count: rows.length,
			predicted:
				rows.reduce((s, o) => s + o.prediction, 0) / (rows.length || 1),
			observed: rows.reduce((s, o) => s + o.unchanged, 0) / (rows.length || 1),
		};
	}).filter((b) => b.count > 0);
	return {
		sampleLimit: 1000 as const,
		asOf: now.toISOString(),
		classId: p.classId,
		decisions: decided.length,
		unchanged,
		observedRate: decided.length ? unchanged / decided.length : null,
		predictedMean: observations.length
			? observations.reduce((s, o) => s + o.prediction, 0) / observations.length
			: null,
		predictedCount: observations.length,
		pending: new Set(
			exposures.filter((e) => !byCard.has(e.cardId)).map((e) => e.cardId),
		).size,
		statement: decided.length
			? `Cards like this: you approved ${unchanged} of ${decided.length} unchanged`
			: "Cards like this: no completed decisions recorded yet",
		bins,
	};
}

export async function readDecisionInstrumentation(
	db: DbQueryClient,
	p: { organizationId: string; actorId: string; cardId: string; limit: number },
	now = new Date(),
) {
	const result = await listDecisionInstrumentation(db, {
		...p,
		now: now.toISOString(),
	});
	const pendingLabels = result.labels
		.filter((l) => l.window === "immediate")
		.flatMap((l) =>
			(["day_1", "day_7"] as const).flatMap((window) => {
				const id = `${l.id}:${window}`;
				if (result.labels.some((label) => label.id === id)) return [];
				const dueAt = new Date(
					Date.parse(l.outcome.decidedAt) +
						(window === "day_1" ? 1 : 7) * 86400000,
				).toISOString();
				return [
					{
						receiptId: l.outcome.receiptId,
						window,
						dueAt,
						state:
							dueAt > now.toISOString()
								? ("pending" as const)
								: ("overdue" as const),
					},
				];
			}),
		);
	return { ...result, pendingLabels };
}

import { useEffect, useRef, type RefObject } from "react";
import {
	DecisionExposureInputSchema,
	type DecisionExposureInput,
} from "@tedix/api-contract/schemas/decision-learning";
import { osApi } from "@/lib/api";

export type DeckInstrumentationCandidate = {
	id: string;
	score: number | null;
	reason: DecisionExposureInput["candidates"][number]["reason"];
	position: number | null;
};
const selectors: Record<DecisionExposureInput["aboveFold"][number], string> = {
	title: "[data-slot=card-title]",
	body: ".fd-card-summary, .fd-proposal-preview",
	recommendation: ".fd-recommendation",
	options: "[data-decision-actions]",
	stakes: ".fd-stakes",
	urgency: "time",
	proposer: "[data-slot=card-description]",
};
/**
 * The API accepts only ids it can verify against canonical decision sources:
 * bare interaction ids plus `work-approval:*` and `approval:*`. Rows composed
 * in the browser, like `factory:*` review cards or `example:*` practice
 * cards, are real deck alternatives but not canonical — reporting one fails
 * the whole exposure.
 */
function canonicalCardId(id: string) {
	return (
		!id.includes(":") ||
		id.startsWith("work-approval:") ||
		id.startsWith("approval:")
	);
}
/** Field names only: never scrape text or anything outside the active card. */
export function visibleDecisionFields(
	root: HTMLElement,
): DecisionExposureInput["aboveFold"] {
	return (
		Object.entries(selectors) as Array<
			[DecisionExposureInput["aboveFold"][number], string]
		>
	)
		.filter(([, selector]) =>
			[...root.querySelectorAll(selector)].some((node) => {
				const box = node.getBoundingClientRect();
				return (
					box.width > 0 &&
					box.height > 0 &&
					box.top >= 0 &&
					box.bottom <= window.innerHeight &&
					box.left >= 0 &&
					box.right <= window.innerWidth &&
					getComputedStyle(node).visibility !== "hidden"
				);
			}),
		)
		.map(([field]) => field);
}

/** Capture on actual visibility and on rail/layout changes. Retries reuse the same immutable event. */
export function useDecisionInstrumentation(p: {
	enabled: boolean;
	scopeKey: string;
	root: RefObject<HTMLElement | null>;
	cardId?: string;
	sourceVersion: number | null;
	position: number;
	railOpened: boolean;
	timezone: string;
	ranking: DecisionExposureInput["ranking"];
	candidates: DeckInstrumentationCandidate[];
	candidateSetComplete: boolean;
}) {
	const session = useRef<{ scope: string; id: string } | null>(null);
	if (session.current?.scope !== p.scopeKey)
		session.current = { scope: p.scopeKey, id: crypto.randomUUID() };
	const sessionId = session.current.id;
	const last = useRef("");
	const encoded = JSON.stringify({
		cardId: p.cardId,
		sourceVersion: p.sourceVersion,
		position: p.position,
		railOpened: p.railOpened,
		timezone: p.timezone,
		ranking: p.ranking,
		candidates: p.candidates,
		candidateSetComplete: p.candidateSetComplete,
	});
	useEffect(() => {
		if (!p.enabled || !p.cardId || !p.root.current) return;
		const root = p.root.current;
		let cancelled = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const report = () => {
			const card = root.querySelector<HTMLElement>(".fd-decision");
			if (!card || document.visibilityState !== "visible") return;
			const box = card.getBoundingClientRect();
			if (
				box.width <= 0 ||
				box.height <= 0 ||
				box.bottom <= 0 ||
				box.top >= window.innerHeight
			)
				return;
			const state = JSON.parse(encoded) as {
				cardId: string;
				sourceVersion: number | null;
				position: number;
				railOpened: boolean;
				timezone: string;
				ranking: DecisionExposureInput["ranking"];
				candidates: DeckInstrumentationCandidate[];
				candidateSetComplete: boolean;
			};
			if (!canonicalCardId(state.cardId)) return;
			const aboveFold = visibleDecisionFields(card);
			const signature = JSON.stringify({ sessionId, ...state, aboveFold });
			if (last.current === signature) return;
			last.current = signature;
			const candidates = state.candidates
				.filter((candidate) => canonicalCardId(candidate.id))
				.slice(0, 100);
			if (!candidates.some((c) => c.id === state.cardId))
				candidates[Math.max(0, candidates.length - 1)] = {
					id: state.cardId,
					score: state.ranking.score,
					reason: "shown",
					position: state.position,
				};
			const parsed = DecisionExposureInputSchema.safeParse({
				...feedOrigin(state.cardId),
				selectionPolicy: "deterministic_current_order",
				selectionProbability: null,
				clientEventId: crypto.randomUUID(),
				sessionId,
				cardId: state.cardId,
				sourceVersion: state.sourceVersion,
				position: state.position,
				aboveFold,
				railOpened: state.railOpened,
				timezone: state.timezone,
				rankingEvidenceTruncated: state.ranking.features.some(
					(f) => f.evidenceIds.length > 20,
				),
				ranking: {
					...state.ranking,
					features: state.ranking.features
						.map((f) => ({
							...f,
							evidenceIds: f.evidenceIds.slice(0, 20),
						}))
						.slice(0, 50),
				},
				candidates: candidates.map((c) => ({
					cardId: c.id,
					score: c.score,
					reason: c.reason,
					position: c.position,
				})),
				candidateCount: Math.max(state.candidates.length, candidates.length),
				candidateSetComplete:
					state.candidateSetComplete &&
					candidates.length === state.candidates.length,
			} satisfies DecisionExposureInput);
			// Telemetry stays silent: a contract-invalid payload is skipped, never retried.
			if (!parsed.success) return;
			const input = parsed.data;
			let attempts = 0;
			const send = () => {
				void osApi.learningFeedback.recordExposure(input).catch(() => {
					if (!cancelled && ++attempts < 3)
						retry = setTimeout(send, 1000 * attempts);
					else if (last.current === signature) last.current = "";
				});
			};
			send();
		};
		const frame = requestAnimationFrame(report);
		const observer = new ResizeObserver(report);
		observer.observe(root);
		window.addEventListener("resize", report);
		root.addEventListener("scroll", report, true);
		document.addEventListener("visibilitychange", report);
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
			if (retry) clearTimeout(retry);
			observer.disconnect();
			window.removeEventListener("resize", report);
			root.removeEventListener("scroll", report, true);
			document.removeEventListener("visibilitychange", report);
		};
	}, [p.enabled, p.cardId, p.root, sessionId, encoded]);
}

function feedOrigin(cardId: string): Pick<DecisionExposureInput, "feedOrigin"> {
	try {
		const origin = JSON.parse(
			sessionStorage.getItem("tedix-focus-origin") ?? "null",
		);
		if (
			!origin ||
			(origin.itemId !== `decision:${cardId}` && origin.itemId !== cardId) ||
			Date.now() < origin.openedAt ||
			Date.now() - origin.openedAt >= 86400000
		)
			return {};
		// A stale or foreign browser entry must not poison the whole exposure.
		const feedOrigin = DecisionExposureInputSchema.shape.feedOrigin.safeParse({
			sessionId: origin.sessionId,
			openedAt: origin.openedAt,
			itemId: origin.itemId,
		});
		return feedOrigin.success && feedOrigin.data
			? { feedOrigin: feedOrigin.data }
			: {};
	} catch {
		/* A stale browser-local pointer is not attribution. */
	}
	return {};
}

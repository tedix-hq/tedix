import * as z from "zod";

/**
 * A tedi-drafted reply to an open decision-capture question. A review draft
 * (`delivery: "review"`, or absent on older servers) is a proposal: nothing is
 * sent until the user accepts or edits and submits it here. An auto draft
 * (`delivery: "auto"`, chosen by the server only for reversible, non-urgent
 * turns within the session's auto-reply budget) was already handed to the
 * waiting agent; the question stays open so the user can override it.
 */
const replyDraftSchema = z.object({
	id: z.string().min(1),
	body: z.string().trim().min(1),
	rationale: z.string().nullable().optional(),
	drafterId: z.string().min(1),
	/** Any value other than "auto" is shown as a draft for review. */
	delivery: z.string().nullable().optional(),
});

export type InteractionReplyDraft = z.output<typeof replyDraftSchema>;

/** At or below this normalized edit distance the answer counts as an edit of the draft. */
export const EDITED_MAX_RATIO = 0.3;

/**
 * The detail's `latestDraft`, or null when it is absent (servers without
 * drafting), null or malformed.
 */
export function latestDraftOf(detail: unknown): InteractionReplyDraft | null {
	if (typeof detail !== "object" || detail === null) return null;
	const parsed = replyDraftSchema.safeParse(
		(detail as { latestDraft?: unknown }).latestDraft,
	);
	return parsed.success ? parsed.data : null;
}

/**
 * Levenshtein distance normalized by the longer trimmed text, rounded to three
 * places: 0 unchanged, 1 fully rewritten. The shared prefix and suffix are
 * skipped first; a still-huge middle uses its longer side as an upper bound.
 * Matches the CLI's `editRatio` so both clients record the same outcome.
 */
export function editRatio(sent: string, draft: string): number {
	const a = sent.trim();
	const b = draft.trim();
	const longest = Math.max(a.length, b.length);
	if (!longest) return 0;
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const x = a.slice(start, endA);
	const y = b.slice(start, endB);
	let distance: number;
	if (!x.length || !y.length || x.length * y.length > 4_000_000)
		distance = Math.max(x.length, y.length);
	else {
		let previous = new Uint32Array(y.length + 1);
		let current = new Uint32Array(y.length + 1);
		for (let j = 0; j <= y.length; j++) previous[j] = j;
		for (let i = 1; i <= x.length; i++) {
			current[0] = i;
			for (let j = 1; j <= y.length; j++)
				current[j] = Math.min(
					previous[j]! + 1,
					current[j - 1]! + 1,
					previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
				);
			[previous, current] = [current, previous];
		}
		distance = previous[y.length]!;
	}
	return Math.round((distance / longest) * 1000) / 1000;
}

export interface DraftAnswerMetadata {
	[key: string]: string | number;
	draftId: string;
	draftOutcome: "accepted" | "edited" | "replaced";
	editRatio: number;
	source: "os-inbox";
}

/** Response metadata citing the draft an answer started from. */
export function draftAnswerMetadata(
	draft: InteractionReplyDraft,
	body: string,
): DraftAnswerMetadata {
	const ratio = editRatio(body, draft.body);
	return {
		draftId: draft.id,
		draftOutcome:
			ratio === 0
				? "accepted"
				: ratio <= EDITED_MAX_RATIO
					? "edited"
					: "replaced",
		editRatio: ratio,
		source: "os-inbox",
	};
}

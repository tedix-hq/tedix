/**
 * What a tool call actually brought back, in one number.
 *
 * A tool phase measured at ~35 seconds on a live staging turn — the whole gap
 * between a question and the first word of the answer — and it was reported by a
 * single static line. Developer chat UIs fill that time by streaming the raw
 * tool arguments; that is the right answer for their audience and the wrong one
 * for a service advisor, who would be shown JSON. The honest non-technical
 * equivalent is what came back: "Consultó el sistema · 218 resultados".
 *
 * Deliberately one number and nothing else. Tool results are untrusted content,
 * so nothing here renders a value from them — only how many there were.
 */

const MAX_DEPTH = 5;
const MAX_KEYS = 24;

/**
 * The size of the largest collection in a tool result, or `null` when the
 * result carries no collection (a single record, a scalar, an error).
 */
export function countToolResultRows(value: unknown, depth = 0): number | null {
	if (depth > MAX_DEPTH || !value || typeof value !== "object") return null;
	if (Array.isArray(value)) {
		let best = value.length;
		for (const child of value.slice(0, MAX_KEYS)) {
			const nested = countToolResultRows(child, depth + 1);
			if (nested !== null && nested > best) best = nested;
		}
		return best;
	}
	let best: number | null = null;
	for (const child of Object.values(value as Record<string, unknown>).slice(
		0,
		MAX_KEYS,
	)) {
		const nested = countToolResultRows(child, depth + 1);
		if (nested !== null && (best === null || nested > best)) best = nested;
	}
	return best;
}

/** One reducer activity, reduced to the only fields a row may read. */
export interface ActivityRowInput {
	id: string;
	status: "running" | "completed" | "error";
	/** Tenant-authored past tense. Absent unless the tenant authored it. */
	displayLabel?: string | undefined;
	/** Tenant-authored present tense. */
	pendingLabel?: string | undefined;
	result?: unknown;
	startedAt?: number | undefined;
	finishedAt?: number | undefined;
	inputChars?: number | undefined;
}

/**
 * The key a row keeps for its whole life.
 *
 * It is the tenant's PAST-tense label when there is one, so the row does not
 * remount when "Checking orders…" becomes "Checked orders" — the streaming and
 * the settled render address the same element. Two calls to the same tool land
 * on the same key and collapse into one row with a count, which is the defect
 * this file was opened for: today every call renders the identical generic
 * string, so a turn with two tool calls shows the same sentence twice.
 *
 * Unlabelled tools all share the empty key, so they collapse together into one
 * generic row rather than repeating.
 */
export function activityRowKey(activity: ActivityRowInput): string {
	return activity.displayLabel || activity.pendingLabel || "";
}

/** More than this many distinct rows and the worklog says "N actions" instead. */
export const MAX_ACTIVITY_ROWS = 3;

export interface ActivityRowCopy {
	/** Generic past tense, used when the tenant authored no label. */
	checked: () => string;
	/** Generic present tense. */
	checking: () => string;
	/** The one permitted failure string. */
	failed: () => string;
	results: (count: number) => string;
	times: (count: number) => string;
}

export interface ActivityRowText {
	text: string;
	status: "running" | "completed" | "error";
	/** Tool input is streaming: run the typing indicator. */
	streaming: boolean;
}

/**
 * The single line for one collapsed row: `✓ Checked orders · 2× · 218 results · 4s`.
 *
 * Every part is either the tenant's own words, a catalog string, a count of
 * result rows, or a duration. No argument, no result value, no tool id, and no
 * error text beyond the one catalog fallback can reach this string.
 */
export function activityRowText(
	calls: readonly ActivityRowInput[],
	copy: ActivityRowCopy,
): ActivityRowText {
	const status = calls.some((call) => call.status === "error")
		? "error"
		: calls.some((call) => call.status === "running")
			? "running"
			: "completed";
	const first = calls[0];
	const streaming = calls.some(
		(call) => call.status === "running" && (call.inputChars ?? 0) > 0,
	);
	if (status === "error")
		return { text: copy.failed(), status, streaming: false };
	if (status === "running")
		return {
			text: first?.pendingLabel || copy.checking(),
			status,
			streaming,
		};
	const parts = [`✓ ${first?.displayLabel || copy.checked()}`];
	if (calls.length > 1) parts.push(copy.times(calls.length));
	let rows: number | null = null;
	for (const call of calls) {
		const counted = countToolResultRows(call.result);
		if (counted !== null) rows = (rows ?? 0) + counted;
	}
	if (rows !== null) parts.push(copy.results(rows));
	const started = Math.min(
		...calls.map((call) => call.startedAt ?? Number.POSITIVE_INFINITY),
	);
	const finished = Math.max(
		...calls.map((call) => call.finishedAt ?? Number.NEGATIVE_INFINITY),
	);
	const elapsed = finished - started;
	if (Number.isFinite(elapsed) && elapsed >= 1000)
		parts.push(`${Math.round(elapsed / 1000)}s`);
	return { text: parts.join(" · "), status, streaming: false };
}

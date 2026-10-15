import type { CodeContent } from "./code-change";

/**
 * Whether a room's draft still says what its saved revision said, so adopting a
 * newer saved revision would lose nothing the user wrote.
 *
 * A moved stream is not the test. A room whose rows only round-trip (typed then
 * undone) or only record view state still reads as unedited. The one piece of
 * view state that lives in a document today is a deck's `activeSlideId`: older
 * editors wrote it on every slide click, so simply browsing a deck marked the
 * draft as edited and blocked the next saved version behind a recovery prompt.
 *
 * Files compare byte-for-byte first, then as JSON with view state removed and
 * key order ignored. Anything unparseable or different is an edit.
 */
export function sameDraftContent(
	saved: CodeContent,
	draft: CodeContent,
): boolean {
	if (saved.size !== draft.size) return false;
	for (const [path, savedText] of saved) {
		const draftText = draft.get(path);
		if (draftText === undefined || !sameDraftText(savedText, draftText))
			return false;
	}
	return true;
}

/** One file of {@link sameDraftContent}: the surface's "is this draft saved?" check. */
export function sameDraftText(saved: string, draft: string): boolean {
	if (saved === draft) return true;
	const left = withoutViewState(saved);
	return left !== null && left === withoutViewState(draft);
}

function withoutViewState(text: string): string | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (isRecord(value) && isRecord(value.deck)) {
		const { activeSlideId: _view, ...deck } = value.deck;
		value = { ...value, deck };
	}
	return stableJson(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/**
 * The one item the person is looking at on the current page, such as the
 * Decision Deck card on screen. The quick chat sends it with the route as
 * untrusted page context, so "this card" resolves without pasting anything.
 * Identity only: an id, a type and a short label, never the item's data.
 */
export interface PageFocus {
	type: string;
	id: string;
	label?: string;
}

let focus: PageFocus | null = null;
const listeners = new Set<() => void>();

export function getPageFocus(): PageFocus | null {
	return focus;
}

export function setPageFocus(next: PageFocus | null): void {
	if (
		focus?.type === next?.type &&
		focus?.id === next?.id &&
		focus?.label === next?.label
	)
		return;
	focus = next;
	for (const listener of listeners) listener();
}

export function subscribePageFocus(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

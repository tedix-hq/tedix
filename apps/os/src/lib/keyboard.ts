import { isImeComposingKey } from "@tedix/chat-transport/composer-semantics";

type CompositionAwareKeyboardEvent = {
	nativeEvent: Pick<KeyboardEvent, "isComposing" | "keyCode">;
};

/**
 * Keep commit-on-key actions inert while an input method editor owns the
 * event. The rule itself is shared with the embedded widget; this adapter only
 * unwraps React's synthetic event to the signal the shared predicate takes.
 */
export function isImeComposing(event: CompositionAwareKeyboardEvent): boolean {
	return isImeComposingKey(event.nativeEvent);
}

const EDITABLE_SELECTOR =
	"input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=searchbox], [role=combobox]";

/**
 * True when a key belongs to text entry, so page shortcuts leave it alone.
 * Walks `composedPath()` because a Shadow DOM host, such as the Tedi chat
 * widget, retargets `event.target` to the host element.
 */
export function isTypingEvent(
	event: Pick<KeyboardEvent, "composedPath" | "isComposing" | "keyCode">,
): boolean {
	return (
		isImeComposingKey(event) ||
		event
			.composedPath()
			.some(
				(node) =>
					node instanceof HTMLElement &&
					(node.isContentEditable || node.matches(EDITABLE_SELECTOR)),
			)
	);
}

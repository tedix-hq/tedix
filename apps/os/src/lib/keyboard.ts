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

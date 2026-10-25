/**
 * Whether reloading the OS could lose something the person typed.
 *
 * It reflects the current state: an edited control that is still on the page
 * counts only while it holds content, so a chat composer emptied by a send is
 * clean. An edited control that has since unmounted stays unsaved, because
 * its draft may live on in React state. Embedded app frames (MCP widgets)
 * count only when they mark themselves dirty with `data-os-dirty="true"`.
 */
const editedControls = new WeakMap<Document, Set<Element>>();

/** Attribute an embedded frame sets to report unsaved state of its own. */
export const OS_FRAME_DIRTY_ATTRIBUTE = "data-os-dirty";
/** Marks a frame that holds no person-authored state unless it reports dirty. */
export const OS_FRAME_RELOAD_SAFE_ATTRIBUTE = "data-os-reload-safe";

export function trackOsInput(doc: Document): () => void {
	const edited = new Set<Element>();
	editedControls.set(doc, edited);
	const markEdited = (event: Event) => {
		const target = event.target;
		if (target instanceof Element) edited.add(target);
	};
	doc.addEventListener("input", markEdited, true);
	doc.addEventListener("change", markEdited, true);
	return () => {
		doc.removeEventListener("input", markEdited, true);
		doc.removeEventListener("change", markEdited, true);
		editedControls.delete(doc);
	};
}

function holdsInput(element: Element): boolean {
	if (element instanceof HTMLInputElement) {
		if (["hidden", "button", "submit", "reset"].includes(element.type))
			return false;
		if (["checkbox", "radio"].includes(element.type))
			return element.checked !== element.defaultChecked;
		return element.value !== "";
	}
	if (element instanceof HTMLTextAreaElement) return element.value !== "";
	if (element instanceof HTMLSelectElement)
		return Array.from(element.options).some(
			(option) => option.selected !== option.defaultSelected,
		);
	if (element instanceof HTMLIFrameElement)
		return (
			!element.hasAttribute(OS_FRAME_RELOAD_SAFE_ATTRIBUTE) ||
			element.getAttribute(OS_FRAME_DIRTY_ATTRIBUTE) === "true"
		);
	return Boolean(element.textContent?.trim());
}

export function hasUnsavedOsInput(doc: Document): boolean {
	for (const element of editedControls.get(doc) ?? []) {
		// An unmounted control's draft may still live in component state.
		if (!element.isConnected) return true;
		const control =
			element.closest("[contenteditable=true]") ?? (element as Element);
		if (holdsInput(control)) return true;
	}
	// Include restored controlled inputs and rich editors before their first edit.
	for (const element of doc.querySelectorAll(
		"input, textarea, [contenteditable=true], iframe",
	))
		if (holdsInput(element)) return true;
	return false;
}

const editedDocuments = new WeakSet<Document>();

/** Edits may live in unmounted React state, so keep the fence for this document. */
export function trackOsInput(doc: Document): () => void {
	const markEdited = () => editedDocuments.add(doc);
	doc.addEventListener("input", markEdited, true);
	doc.addEventListener("change", markEdited, true);
	return () => {
		doc.removeEventListener("input", markEdited, true);
		doc.removeEventListener("change", markEdited, true);
		editedDocuments.delete(doc);
	};
}

export function hasUnsavedOsInput(doc: Document): boolean {
	if (editedDocuments.has(doc)) return true;
	// Include restored controlled inputs and rich editors before their first edit.
	for (const element of doc.querySelectorAll(
		"input, textarea, [contenteditable=true], iframe",
	)) {
		if (element instanceof HTMLInputElement) {
			if (["hidden", "button", "submit", "reset"].includes(element.type))
				continue;
			if (["checkbox", "radio"].includes(element.type)) {
				if (element.checked !== element.defaultChecked) return true;
			} else if (element.value) return true;
		} else if (element instanceof HTMLTextAreaElement) {
			if (element.value) return true;
		} else if (
			element instanceof HTMLIFrameElement ||
			element.textContent?.trim()
		)
			return true;
	}
	return false;
}

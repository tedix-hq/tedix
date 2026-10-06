interface ClipboardWriter {
	writeText(text: string): Promise<void>;
}

interface CopyField {
	value: string;
	style: { position: string; opacity: string };
	setAttribute(name: string, value: string): void;
	select(): void;
	remove(): void;
}

interface CopyDocument {
	body: { appendChild(field: CopyField): void };
	createElement(name: "textarea"): CopyField;
	execCommand(command: "copy"): boolean;
}

interface CopyOptions {
	clipboard?: ClipboardWriter;
	document?: CopyDocument;
	timeoutMs?: number;
}

export async function copyTextWithFallback(
	text: string,
	options: CopyOptions = {},
): Promise<boolean> {
	const browser = globalThis as unknown as {
		navigator?: { clipboard?: ClipboardWriter };
		document: CopyDocument;
	};
	const clipboard: ClipboardWriter | undefined =
		options.clipboard ?? browser.navigator?.clipboard;
	const documentRef: CopyDocument = options.document ?? browser.document;
	const timeoutMs = options.timeoutMs ?? 500;

	if (clipboard) {
		try {
			const copied = await Promise.race([
				clipboard.writeText(text).then(() => true),
				new Promise<false>((resolve) =>
					setTimeout(() => resolve(false), timeoutMs),
				),
			]);
			if (copied) return true;
		} catch {}
	}

	try {
		const field = documentRef.createElement("textarea") as CopyField;
		field.value = text;
		field.setAttribute("readonly", "");
		field.style.position = "fixed";
		field.style.opacity = "0";
		documentRef.body.appendChild(field);
		field.select();
		const copied = documentRef.execCommand("copy");
		field.remove();
		return copied;
	} catch {
		return false;
	}
}

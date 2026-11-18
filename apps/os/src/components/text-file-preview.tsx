import { useEffect, useRef, useState } from "react";
import { decodeTextFile } from "@tedix/api-contract/utils/workspace-file-text";
import { Text } from "@/components/kumo/text";

/** Larger text files are offered as a download; one long block would stall the page. */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

type Loaded =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; text: string };

/**
 * A read-only look at an uploaded text, Markdown, JSON or code file, shown as
 * the plain text it holds. A file whose bytes are not text is never shown.
 */
export function TextFilePreview({
	workspaceId,
	resourceId,
	url,
}: {
	workspaceId: string;
	resourceId: string;
	url: string;
}) {
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	// The signed link rotates while the file stays the same; read it once.
	const latestUrl = useRef(url);
	latestUrl.current = url;
	useEffect(() => {
		let cancelled = false;
		setLoaded({ status: "loading" });
		void (async () => {
			let next: Loaded;
			try {
				const response = await fetch(latestUrl.current);
				if (!response.ok) throw new Error("download failed");
				const text = decodeTextFile(
					new Uint8Array(await response.arrayBuffer()),
				);
				next =
					text === null
						? { status: "error", message: "This file is not readable text." }
						: { status: "ready", text };
			} catch {
				next = { status: "error", message: "The file could not be read." };
			}
			if (!cancelled) setLoaded(next);
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceId, resourceId]);

	if (loaded.status === "loading")
		return (
			<Text as="p" role="body" tone="secondary">
				Reading file…
			</Text>
		);
	if (loaded.status === "error")
		return (
			<Text as="p" role="body">
				{loaded.message} Download it to open it.
			</Text>
		);
	if (!loaded.text.trim())
		return (
			<Text as="p" role="body" tone="secondary">
				This file is empty.
			</Text>
		);
	return (
		<pre
			data-text-preview
			// A scrolling block must be reachable by keyboard.
			tabIndex={0}
			className="m-0 max-h-[70vh] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-lg border border-kumo-line p-3 text-sm"
		>
			{loaded.text}
		</pre>
	);
}

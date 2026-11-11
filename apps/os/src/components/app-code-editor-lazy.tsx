import { lazy, Suspense } from "react";
import type { AppCodeEditorProps } from "@/components/app-code-editor";

const Editor = lazy(() => import("@/components/app-code-editor"));

/**
 * The app file editor, fetched when a file is first opened. Until it arrives
 * the file's text is already readable in place.
 */
export function AppCodeEditor(props: AppCodeEditorProps) {
	return (
		<Suspense
			fallback={
				<pre className="app-code-editor-pending" aria-busy="true">
					{props.value}
				</pre>
			}
		>
			<Editor {...props} />
		</Suspense>
	);
}

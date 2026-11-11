import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { lazy, Suspense, type ReactNode } from "react";
import type { DocumentCollab } from "@/components/output-editor-document";
import type { SheetEditorPresence } from "@/components/output-editor-sheet";
import { Text } from "@/components/kumo/text";
import type { RemoteCursor } from "@/lib/document-remote-cursors";

const DocumentEditor = lazy(async () => ({
	default: (await import("@/components/output-editor-document")).DocumentEditor,
}));
const SheetEditor = lazy(async () => ({
	default: (await import("@/components/output-editor-sheet")).SheetEditor,
}));
const SlidesEditor = lazy(async () => ({
	default: (await import("@/components/output-editor-slides")).SlidesEditor,
}));
const FileOutputView = lazy(async () => ({
	default: (await import("@/components/output-content")).FileOutputView,
}));
const VideoOutputView = lazy(async () => ({
	default: (await import("@/components/output-content")).VideoOutputView,
}));

export function OutputEditor({
	value,
	onChange,
	disabled,
	workspaceId,
	documentCollab,
	remoteCursors,
	presence,
}: {
	value: OsOutputContent;
	onChange: (next: OsOutputContent) => void;
	disabled?: boolean;
	/** The output's workspace; presentations offer its files in the image picker. */
	workspaceId?: string;
	/** Live co-editing for a document; other kinds ignore it. */
	documentCollab?: DocumentCollab;
	remoteCursors?: readonly RemoteCursor[];
	/** Live collab presence for a sheet: peers' cell ranges in, ours out. */
	presence?: SheetEditorPresence;
}) {
	let editor: ReactNode;
	switch (value.kind) {
		case "document":
			if (value.file) {
				editor = <FileOutputView {...value.file} />;
				break;
			}
			editor = (
				<DocumentEditor
					value={value}
					onChange={onChange}
					disabled={disabled}
					collab={documentCollab}
					remoteCursors={remoteCursors}
				/>
			);
			break;
		case "sheet":
			editor = (
				<SheetEditor
					value={value}
					onChange={onChange}
					disabled={disabled}
					presence={presence}
				/>
			);
			break;
		case "presentation":
			editor = (
				<SlidesEditor
					value={value}
					onChange={onChange}
					disabled={disabled}
					workspaceId={workspaceId}
				/>
			);
			break;
		case "video":
			editor = <VideoOutputView content={value} />;
			break;
	}
	return (
		<Suspense
			fallback={
				<Text role="body" tone="secondary">
					Loading editor…
				</Text>
			}
		>
			{editor}
		</Suspense>
	);
}

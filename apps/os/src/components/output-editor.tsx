import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import {
	type DocumentCollab,
	DocumentEditor,
} from "@/components/output-editor-document";
import {
	SheetEditor,
	type SheetEditorPresence,
} from "@/components/output-editor-sheet";
import { SlidesEditor } from "@/components/output-editor-slides";
import { VideoOutputView } from "@/components/output-content";
import type { RemoteCursor } from "@/lib/document-remote-cursors";

export function OutputEditor({
	value,
	onChange,
	disabled,
	documentCollab,
	remoteCursors,
	presence,
}: {
	value: OsOutputContent;
	onChange: (next: OsOutputContent) => void;
	disabled?: boolean;
	/** Live co-editing for a document; other kinds ignore it. */
	documentCollab?: DocumentCollab;
	remoteCursors?: readonly RemoteCursor[];
	/** Live collab presence for a sheet: peers' cell ranges in, ours out. */
	presence?: SheetEditorPresence;
}) {
	switch (value.kind) {
		case "document":
			return (
				<DocumentEditor
					value={value}
					onChange={onChange}
					disabled={disabled}
					collab={documentCollab}
					remoteCursors={remoteCursors}
				/>
			);
		case "sheet":
			return (
				<SheetEditor
					value={value}
					onChange={onChange}
					disabled={disabled}
					presence={presence}
				/>
			);
		case "presentation":
			return (
				<SlidesEditor value={value} onChange={onChange} disabled={disabled} />
			);
		case "video":
			return <VideoOutputView content={value} />;
	}
}

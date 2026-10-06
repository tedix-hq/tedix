import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { DocumentEditor } from "@/components/output-editor-document";
import { SheetEditor } from "@/components/output-editor-sheet";
import { SlidesEditor } from "@/components/output-editor-slides";
import { VideoOutputView } from "@/components/output-content";

export function OutputEditor({
	value,
	onChange,
	disabled,
}: {
	value: OsOutputContent;
	onChange: (next: OsOutputContent) => void;
	disabled?: boolean;
}) {
	switch (value.kind) {
		case "document":
			return (
				<DocumentEditor value={value} onChange={onChange} disabled={disabled} />
			);
		case "sheet":
			return (
				<SheetEditor value={value} onChange={onChange} disabled={disabled} />
			);
		case "presentation":
			return (
				<SlidesEditor value={value} onChange={onChange} disabled={disabled} />
			);
		case "video":
			return <VideoOutputView content={value} />;
	}
}

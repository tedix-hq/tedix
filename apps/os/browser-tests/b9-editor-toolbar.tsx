import { Fragment, useState } from "react";
import { createRoot } from "react-dom/client";
import { TextAa, TextB, TextItalic, ArrowUUpLeft } from "@phosphor-icons/react";
import {
	EditorHistoryNotice,
	EditorToolbar,
	EditorToolbarButton,
	EditorToolbarColorButton,
	EditorToolbarDivider,
} from "../src/components/output-editor-toolbar";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../src/components/kumo/select";
import "../src/styles.css";
import "../src/components/output-editor.css";

const theme = new URLSearchParams(location.search).get("theme") ?? "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.mode = theme;
document.documentElement.dataset.theme = "tedix";

function Fixture() {
	const [bold, setBold] = useState(false);
	const [color, setColor] = useState("#7938cc");
	return (
		<main className="min-w-0 bg-kumo-base text-kumo-default">
			<h1 className="p-4 type-tedix-section-title">Output editor toolbar</h1>
			<EditorToolbar>
				<EditorToolbarButton
					label="Bold"
					active={bold}
					onClick={() => setBold(!bold)}
				>
					<TextB size={16} />
				</EditorToolbarButton>
				<EditorToolbarButton label="Undo" disabled onClick={() => {}}>
					<ArrowUUpLeft size={16} />
				</EditorToolbarButton>
				<EditorToolbarDivider />
				<EditorToolbarColorButton
					label="Text color"
					color={color}
					onChange={setColor}
				>
					<TextAa size={14} />
				</EditorToolbarColorButton>
				<EditorToolbarColorButton
					label="Highlight color"
					color="#fff3a3"
					disabled
					onChange={() => {}}
				>
					<TextAa size={14} />
				</EditorToolbarColorButton>
				<EditorToolbarDivider />
				<Select defaultValue="paragraph">
					<SelectTrigger
						aria-label="Paragraph style"
						size="sm"
						className="w-40"
					>
						<SelectValue>
							{(value) => (value === "heading" ? "Heading" : "Paragraph")}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="paragraph">Paragraph</SelectItem>
						<SelectItem value="heading">Heading</SelectItem>
					</SelectContent>
				</Select>
				{Array.from({ length: 16 }, (_, index) => (
					<Fragment key={index}>
						<EditorToolbarDivider />
						<EditorToolbarButton
							label={`Format ${index + 1}`}
							onClick={() => {}}
						>
							<TextItalic size={16} />
						</EditorToolbarButton>
					</Fragment>
				))}
				<EditorHistoryNotice notice="Undo skipped a paragraph that a collaborator changed after your last edit. Their latest changes are preserved in the document." />
			</EditorToolbar>
			<p className="p-4" data-color-result>
				{color}
			</p>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);

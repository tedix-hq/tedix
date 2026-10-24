import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Kbd } from "@/components/kumo/kbd";
import { Text } from "@/components/kumo/text";

const isApple = () =>
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** `Mod` and friends spelled the way this device's keyboard labels them. */
export function shortcutKeys(keys: string): string[] {
	const apple = isApple();
	return keys.split("+").map((key) => {
		switch (key) {
			case "Mod":
				return apple ? "⌘" : "Ctrl";
			case "Alt":
				return apple ? "⌥" : "Alt";
			case "Shift":
				return apple ? "⇧" : "Shift";
			default:
				return key;
		}
	});
}

/** The keyboard shortcuts the document editor answers, grouped for scanning. */
export const DOCUMENT_SHORTCUTS: readonly {
	group: string;
	items: readonly { label: string; keys: string }[];
}[] = [
	{
		group: "Text",
		items: [
			{ label: "Bold", keys: "Mod+B" },
			{ label: "Italic", keys: "Mod+I" },
			{ label: "Underline", keys: "Mod+U" },
			{ label: "Strikethrough", keys: "Mod+Shift+S" },
			{ label: "Inline code", keys: "Mod+E" },
			{ label: "Highlight", keys: "Mod+Shift+H" },
			{ label: "Add or edit link", keys: "Mod+K" },
		],
	},
	{
		group: "Blocks",
		items: [
			{ label: "Normal text", keys: "Mod+Alt+0" },
			{ label: "Heading 1, 2 or 3", keys: "Mod+Alt+1" },
			{ label: "Bulleted list", keys: "Mod+Shift+8" },
			{ label: "Numbered list", keys: "Mod+Shift+7" },
			{ label: "Checklist", keys: "Mod+Shift+9" },
			{ label: "Quote", keys: "Mod+Shift+B" },
			{ label: "Code block", keys: "Mod+Alt+C" },
			{ label: "Insert a block", keys: "/" },
		],
	},
	{
		group: "Editing",
		items: [
			{ label: "Undo", keys: "Mod+Z" },
			{ label: "Redo", keys: "Mod+Shift+Z" },
			{ label: "Indent list item", keys: "Tab" },
			{ label: "Outdent list item", keys: "Shift+Tab" },
			{ label: "Line break in a paragraph", keys: "Shift+Enter" },
			{ label: "Show these shortcuts", keys: "Mod+/" },
		],
	},
];

/** Markdown habits the editor turns into blocks as they are typed. */
const MARKDOWN_HABITS: readonly { typed: string; result: string }[] = [
	{ typed: "# ", result: "Heading 1 (## and ### for smaller)" },
	{ typed: "- ", result: "Bulleted list" },
	{ typed: "1. ", result: "Numbered list" },
	{ typed: "[ ] ", result: "Checklist" },
	{ typed: "> ", result: "Quote" },
	{ typed: "```", result: "Code block" },
	{ typed: "---", result: "Divider" },
];

function Keys({ keys }: { keys: string }) {
	return (
		<span className="inline-flex shrink-0 items-center gap-1">
			{shortcutKeys(keys).map((key, index) => (
				<Kbd key={`${key}-${index}`}>{key}</Kbd>
			))}
		</span>
	);
}

export function DocumentShortcutsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="lg" className="document-shortcuts">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						Format as you write without leaving the keyboard.
					</DialogDescription>
				</DialogHeader>
				<div className="document-shortcuts-grid">
					{DOCUMENT_SHORTCUTS.map((section) => (
						<section key={section.group} aria-label={section.group}>
							<Text
								as="h3"
								role="caption"
								tone="secondary"
								weight="semibold"
								className="m-0 mb-1"
							>
								{section.group}
							</Text>
							<dl className="m-0 grid gap-1">
								{section.items.map(({ label, keys }) => (
									<div key={label} className="document-shortcut-row">
										<Text as="dt" role="label">
											{label}
										</Text>
										<dd className="m-0">
											<Keys keys={keys} />
										</dd>
									</div>
								))}
							</dl>
						</section>
					))}
					<section aria-label="Markdown">
						<Text
							as="h3"
							role="caption"
							tone="secondary"
							weight="semibold"
							className="m-0 mb-1"
						>
							Type at the start of a line
						</Text>
						<dl className="m-0 grid gap-1">
							{MARKDOWN_HABITS.map(({ typed, result }) => (
								<div key={typed} className="document-shortcut-row">
									<Text as="dt" role="label">
										{result}
									</Text>
									<dd className="m-0">
										<Kbd>{typed.trim()}</Kbd>
									</dd>
								</div>
							))}
						</dl>
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}

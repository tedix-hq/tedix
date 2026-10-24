import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Kbd } from "@/components/kumo/kbd";

const MOD =
	typeof navigator !== "undefined" &&
	/Mac|iP(hone|ad|od)/.test(navigator.platform)
		? "⌘"
		: "Ctrl";

/** Every key the sheet editor answers to, grouped the way people look for them. */
export const SHEET_SHORTCUTS: readonly {
	group: string;
	/** Keys pressed together or alternatives, `|`-separated, one chip each. */
	items: readonly { label: string; keys: string }[];
}[] = [
	{
		group: "Move and select",
		items: [
			{ label: "Move", keys: "←|↑|→|↓" },
			{ label: "Extend the selection", keys: "Shift|Arrow" },
			{ label: "Jump to the edge of the data", keys: `${MOD}|Arrow` },
			{ label: "Row start or end", keys: "Home|End" },
			{ label: "Up or down a page", keys: "Page Up|Page Down" },
			{ label: "Select the whole column", keys: "Ctrl|Space" },
			{ label: "Select the whole row", keys: "Shift|Space" },
			{ label: "Select everything", keys: `${MOD}|A` },
		],
	},
	{
		group: "Edit",
		items: [
			{ label: "Edit the cell", keys: "Enter|F2" },
			{ label: "Replace the cell", keys: "Start typing" },
			{ label: "Save and move down or right", keys: "Enter|Tab" },
			{ label: "Save and stay", keys: `${MOD}|Enter` },
			{ label: "New line in a cell", keys: "Alt|Enter" },
			{ label: "Cancel the edit", keys: "Esc" },
			{ label: "Clear the cells", keys: "Delete" },
			{ label: "Fill down from the first row", keys: `${MOD}|D` },
			{ label: "Fill right from the first column", keys: `${MOD}|R` },
			{ label: "Undo or redo", keys: `${MOD}|Z` },
		],
	},
	{
		group: "Format",
		items: [
			{ label: "Bold, italic, underline", keys: `${MOD}|B · I · U` },
			{ label: "Currency", keys: `${MOD}|Shift|4` },
			{ label: "Percent", keys: `${MOD}|Shift|5` },
			{ label: "Clear formatting", keys: `${MOD}|\\` },
		],
	},
];

export function SheetShortcutsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						The grid works like the spreadsheets you already know. Press {MOD} /
						to open this list from any cell.
					</DialogDescription>
				</DialogHeader>
				<div className="grid max-h-[60vh] gap-4 overflow-y-auto pb-1">
					{SHEET_SHORTCUTS.map((section) => (
						<section key={section.group} className="grid gap-1.5">
							<h3 className="text-kumo-subtle type-tedix-label">
								{section.group}
							</h3>
							<dl className="grid gap-1">
								{section.items.map(({ label, keys }) => (
									<div
										key={label}
										className="flex items-center justify-between gap-4 type-tedix-body"
									>
										<dt className="min-w-0">{label}</dt>
										<dd className="flex shrink-0 items-center gap-1">
											{keys.split("|").map((key) => (
												<Kbd key={key}>{key}</Kbd>
											))}
										</dd>
									</div>
								))}
							</dl>
						</section>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}

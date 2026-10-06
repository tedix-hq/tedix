import { graphemes } from "./composer-graphemes";

export interface ComposerCell {
	text: string;
	offset: number;
}

/** Wrap by terminal columns, then retain a bounded window containing the cursor. */
export function composerViewport(
	value: string,
	cursorOffset: number,
	columns: number,
	maxRows: number,
) {
	const width = Math.max(1, Math.floor(columns));
	const limit = Math.max(1, Math.floor(maxRows));
	const chars = graphemes(value);
	const cursor = Math.max(0, Math.min(cursorOffset, chars.length));
	const rows: ComposerCell[][] = [[]];
	const positions: { offset: number; row: number; column: number }[] = [];
	let column = 0;
	let logicalColumn = 0;
	let cursorRow = 0;
	const append = (text: string, offset: number, cellWidth: number) => {
		if (column > 0 && column + cellWidth > width) {
			rows.push([]);
			column = 0;
		}
		const position = { offset, row: rows.length - 1, column };
		rows[rows.length - 1]!.push({ text, offset });
		column += cellWidth;
		return position;
	};
	for (let offset = 0; offset <= chars.length; offset++) {
		if (offset === chars.length && cursor !== offset) {
			positions.push({ offset, row: rows.length - 1, column });
			break;
		}
		const char = chars[offset] ?? " ";
		if (char === "\n") {
			if (offset === cursor) {
				positions.push(append(" ", offset, 1));
				cursorRow = rows.length - 1;
			} else {
				positions.push({ offset, row: rows.length - 1, column });
			}
			rows.push([]);
			column = 0;
			logicalColumn = 0;
			continue;
		}
		// Ink expands tabs before wrapping, at eight-column stops within each
		// logical line (squash-text-nodes / wrap-ansi). Expand display cells only;
		// each space still points to the original draft's single tab grapheme.
		if (char === "\t") {
			const spaces = 8 - (logicalColumn % 8);
			for (let index = 0; index < spaces; index++) {
				const position = append(" ", offset, 1);
				if (index === 0) {
					positions.push(position);
					if (offset === cursor) cursorRow = position.row;
				}
			}
			logicalColumn += spaces;
			continue;
		}
		const originalWidth = Bun.stringWidth(char);
		// A wide cluster cannot fit a one-column viewport. A display placeholder
		// keeps its cursor visible without splitting or changing the draft.
		// Standalone zero-width clusters similarly need a visible cursor cell.
		const text =
			originalWidth > width
				? "�"
				: originalWidth === 0
					? /^\p{Mark}/u.test(char)
						? `◌${char}`
						: " "
					: char;
		const cellWidth = Math.max(1, Math.min(width, Bun.stringWidth(text)));
		positions.push(append(text, offset, cellWidth));
		if (offset === cursor) cursorRow = rows.length - 1;
		logicalColumn += cellWidth;
	}
	const startRow = Math.max(0, cursorRow - limit + 1);
	return {
		rows: rows.slice(startRow, startRow + limit),
		cursorRow,
		startRow,
		totalRows: rows.length,
		positions,
	};
}

type Edit = { start: number; end: number; text: string };

function edits(base: string[], next: string[]): Edit[] | null {
	// Bound memory and CPU for large rewrites; those remain explicit conflicts.
	if (base.length * next.length > 1_000_000) return null;
	const table = Array.from(
		{ length: base.length + 1 },
		() => new Uint32Array(next.length + 1),
	);
	for (let i = base.length - 1; i >= 0; i--)
		for (let j = next.length - 1; j >= 0; j--)
			table[i]![j] =
				base[i] === next[j]
					? table[i + 1]![j + 1]! + 1
					: Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
	const result: Edit[] = [];
	let i = 0,
		j = 0;
	while (i < base.length || j < next.length) {
		if (i < base.length && j < next.length && base[i] === next[j]) {
			i++;
			j++;
			continue;
		}
		const start = i;
		let text = "";
		while (i < base.length || j < next.length) {
			if (i < base.length && j < next.length && base[i] === next[j]) break;
			if (
				j < next.length &&
				(i === base.length || table[i]![j + 1]! >= table[i + 1]![j]!)
			)
				text += next[j++];
			else i++;
		}
		result.push({ start, end: i, text });
	}
	return result;
}

export function hasAppConflictMarkers(text: string): boolean {
	return /^(<<<<<<< Draft|=======|>>>>>>> Mainline|\|\|\|\|\|\|\| Base)\r?$/m.test(
		text,
	);
}

export function mergeAppText(
	base: string | undefined,
	draft: string | undefined,
	main: string | undefined,
): { text: string | undefined; conflict: boolean } {
	if (draft === main || main === base) return { text: draft, conflict: false };
	if (draft === base) return { text: main, conflict: false };
	if (base !== undefined && draft !== undefined && main !== undefined) {
		const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		const original = lines(base);
		const left = edits(original, lines(draft));
		const right = edits(original, lines(main));
		if (left && right) {
			const combined = [...left];
			let conflict = false;
			for (const change of right) {
				if (
					left.some(
						(e) =>
							e.start === change.start &&
							e.end === change.end &&
							e.text === change.text,
					)
				)
					continue;
				if (
					left.some(
						(e) =>
							Math.max(e.start, change.start) < Math.min(e.end, change.end) ||
							e.start === change.start ||
							(e.start === e.end &&
								e.start > change.start &&
								e.start < change.end) ||
							(change.start === change.end &&
								change.start > e.start &&
								change.start < e.end),
					)
				) {
					conflict = true;
					break;
				}
				combined.push(change);
			}
			if (!conflict) {
				let cursor = 0,
					text = "";
				for (const e of combined.sort((a, b) => a.start - b.start)) {
					text += original.slice(cursor, e.start).join("") + e.text;
					cursor = e.end;
				}
				return {
					text: text + original.slice(cursor).join(""),
					conflict: false,
				};
			}
		}
	}
	const block = (text: string | undefined) =>
		text === undefined
			? "(file deleted)\n"
			: text + (text.endsWith("\n") ? "" : "\n");
	return {
		text:
			"<<<<<<< Draft\n" +
			block(draft) +
			"||||||| Base\n" +
			block(base) +
			"=======\n" +
			block(main) +
			">>>>>>> Mainline\n",
		conflict: true,
	};
}

export function mergeAppFiles(
	base: Record<string, string>,
	draft: Record<string, string>,
	main: Record<string, string>,
) {
	const files: Record<string, string> = {};
	const conflicts: string[] = [];
	for (const path of new Set([
		...Object.keys(base),
		...Object.keys(draft),
		...Object.keys(main),
	])) {
		const merged = mergeAppText(base[path], draft[path], main[path]);
		if (merged.text !== undefined) files[path] = merged.text;
		if (merged.conflict) conflicts.push(path);
	}
	return { files, conflicts };
}

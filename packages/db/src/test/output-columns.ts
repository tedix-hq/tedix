/**
 * Detect duplicate output column names in a query, before D1 silently eats them.
 *
 * Drizzle emits a select list with no aliases — `.select({ domainName:
 * memoryDomains.name })` becomes `select "memory_domains"."name"`, not
 * `... as "domainName"`. The TS key is applied afterwards, positionally. D1
 * returns one object per row and Drizzle rebuilds the positional array with
 * `Object.keys(row).map((k) => row[k])` (`d1ToRawMapping`), so two selected
 * columns that share a *base column name* collapse into one, every later field
 * shifts left, and the rows decode into the wrong fields with no error raised
 * anywhere.
 *
 * A no-argument `.select()` across a join is the usual way to hit this, but it
 * is not the only way: an explicit projection that reaches for `id` on two
 * different tables fails identically. So the check is on the emitted SQL rather
 * than on the shape of the call, which means it catches forms nobody has thought
 * of yet.
 */

/** Split a select list on commas that are not inside parentheses or quotes. */
function splitTopLevel(selectList: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quoted = false;
	let current = "";
	for (let i = 0; i < selectList.length; i += 1) {
		const char = selectList[i];
		if (char === '"') quoted = !quoted;
		else if (!quoted && char === "(") depth += 1;
		else if (!quoted && char === ")") depth -= 1;
		if (char === "," && depth === 0 && !quoted) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * The output column names a statement will produce, in order.
 *
 * Returns an empty array for statements with no select list (inserts without
 * `returning`, updates, deletes), which callers should treat as "nothing to
 * check" rather than as a pass.
 */
export function outputColumnNames(sql: string): string[] {
	const lower = sql.toLowerCase();
	if (!lower.startsWith("select ")) return [];

	// Find the `from` that closes the top-level select list.
	let depth = 0;
	let quoted = false;
	let fromIndex = -1;
	for (let i = 0; i < sql.length; i += 1) {
		const char = sql[i];
		if (char === '"') quoted = !quoted;
		else if (!quoted && char === "(") depth += 1;
		else if (!quoted && char === ")") depth -= 1;
		else if (!quoted && depth === 0 && lower.startsWith("from ", i)) {
			// Guard against a bare `from` inside an identifier boundary.
			if (i > 0 && /\s/.test(sql[i - 1] ?? "")) {
				fromIndex = i;
				break;
			}
		}
	}
	const selectList = sql.slice(
		"select ".length,
		fromIndex === -1 ? undefined : fromIndex,
	);

	return splitTopLevel(selectList).map((item) => {
		const aliased = item.match(/\s+as\s+"([^"]+)"$/i);
		if (aliased?.[1]) return aliased[1];
		const trailingIdentifier = item.match(/"([^"]+)"\s*$/);
		if (trailingIdentifier?.[1]) return trailingIdentifier[1];
		return item;
	});
}

/** Duplicated output column names, or an empty array when the query is safe. */
export function duplicateOutputColumns(sql: string): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of outputColumnNames(sql)) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates];
}

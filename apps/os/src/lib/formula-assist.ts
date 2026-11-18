/**
 * Help while writing a formula: which functions match what is typed, which
 * argument of which function the caret is in, where a clicked cell can go,
 * and F4's cycle through `$` references. Pure text work, shared by the cell
 * editor and the formula bar.
 */

/** Each function's signature, as shown while writing it, and what it does. */
export const FUNCTION_HELP: Record<
	string,
	{ signature: string; about: string }
> = {
	SUM: {
		signature: "SUM(value1, [value2, …])",
		about: "Adds the supplied numbers and ranges together.",
	},
	AVERAGE: {
		signature: "AVERAGE(value1, [value2, …])",
		about: "Finds the arithmetic mean of the supplied values.",
	},
	COUNT: {
		signature: "COUNT(value1, [value2, …])",
		about: "Tells you how many supplied values are numbers.",
	},
	COUNTA: {
		signature: "COUNTA(value1, [value2, …])",
		about: "Tells you how many supplied values are not empty.",
	},
	COUNTIF: {
		signature: "COUNTIF(range, criterion)",
		about: "Counts cells that meet one condition.",
	},
	COUNTIFS: {
		signature: "COUNTIFS(range1, criterion1, …)",
		about: "Counts rows that meet several conditions.",
	},
	SUMIF: {
		signature: "SUMIF(range, criterion, [sum_range])",
		about: "Adds values whose cells meet one condition.",
	},
	SUMIFS: {
		signature: "SUMIFS(sum_range, range1, criterion1, …)",
		about: "Adds values whose rows meet several conditions.",
	},
	MIN: {
		signature: "MIN(value1, [value2, …])",
		about: "Finds the smallest supplied number.",
	},
	MAX: {
		signature: "MAX(value1, [value2, …])",
		about: "Finds the largest supplied number.",
	},
	MEDIAN: {
		signature: "MEDIAN(value1, [value2, …])",
		about: "Finds the middle value in the supplied numbers.",
	},
	ROUND: {
		signature: "ROUND(value, places)",
		about: "Rounds a number to the chosen number of places.",
	},
	IF: {
		signature: "IF(condition, value_if_true, [value_if_false])",
		about: "Chooses a value according to one condition.",
	},
	IFS: {
		signature: "IFS(condition1, value1, [condition2, value2, …])",
		about: "Checks several conditions from first to last.",
	},
	IFERROR: {
		signature: "IFERROR(value, fallback)",
		about: "Uses a fallback when the first value has an error.",
	},
	AND: {
		signature: "AND(condition1, [condition2, …])",
		about: "Gives TRUE only when every condition is true.",
	},
	OR: {
		signature: "OR(condition1, [condition2, …])",
		about: "Gives TRUE when at least one condition is true.",
	},
	NOT: {
		signature: "NOT(condition)",
		about: "Flips TRUE to FALSE, or FALSE to TRUE.",
	},
	CONCAT: {
		signature: "CONCAT(value1, [value2, …])",
		about: "Combines the supplied text into one value.",
	},
	LEFT: {
		signature: "LEFT(text, [characters])",
		about: "Takes characters from the start of some text.",
	},
	RIGHT: {
		signature: "RIGHT(text, [characters])",
		about: "Takes characters from the end of some text.",
	},
	MID: {
		signature: "MID(text, start, length)",
		about: "Takes characters from inside some text.",
	},
	LEN: { signature: "LEN(text)", about: "Counts the characters in some text." },
	TEXT: {
		signature: "TEXT(value, format)",
		about: "Shows a number as text in the chosen format.",
	},
	HYPERLINK: {
		signature: "HYPERLINK(url, [link_label])",
		about: "Makes an HTTP or HTTPS address clickable.",
	},
	VLOOKUP: {
		signature: "VLOOKUP(search_key, range, column, [approximate])",
		about: "Searches down a range's first column.",
	},
	HLOOKUP: {
		signature: "HLOOKUP(search_key, range, row, [approximate])",
		about: "Searches across a range's first row.",
	},
	INDEX: {
		signature: "INDEX(reference, row, [column])",
		about: "Gets the value at a chosen row and column.",
	},
	MATCH: {
		signature: "MATCH(search_key, range, [search_type])",
		about: "Finds where a matching value sits in a range.",
	},
	LOOKUP: {
		signature: "LOOKUP(search_key, search_range, [result_range])",
		about: "Looks for a value in a range that is already sorted.",
	},
	TODAY: { signature: "TODAY()", about: "Uses today's date." },
	NOW: { signature: "NOW()", about: "Uses the current date and time." },
	DATE: {
		signature: "DATE(year, month, day)",
		about: "Makes a date from a year, month, and day.",
	},
	YEAR: { signature: "YEAR(date)", about: "Takes the year from a date." },
	MONTH: { signature: "MONTH(date)", about: "Takes the month from a date." },
	DAY: {
		signature: "DAY(date)",
		about: "Takes the day of the month from a date.",
	},
	PRODUCT: {
		signature: "PRODUCT(value1, [value2, …])",
		about: "Multiplies the supplied numbers and ranges together.",
	},
	ABS: { signature: "ABS(value)", about: "Removes the sign from a number." },
	SQRT: {
		signature: "SQRT(value)",
		about: "Finds a number's positive square root.",
	},
	MOD: {
		signature: "MOD(dividend, divisor)",
		about: "Finds what remains after division.",
	},
	POWER: {
		signature: "POWER(base, exponent)",
		about: "Raises the base number to the chosen power.",
	},
	STDEV: {
		signature: "STDEV(value1, [value2, …])",
		about: "Estimates standard deviation for a sample.",
	},
	VAR: {
		signature: "VAR(value1, [value2, …])",
		about: "Estimates variance for a sample.",
	},
	RANK: {
		signature: "RANK(value, range, [ascending])",
		about: "Shows where a value ranks within a range.",
	},
	LARGE: {
		signature: "LARGE(range, rank)",
		about: "Gets the value at a chosen rank from largest to smallest.",
	},
	SWITCH: {
		signature: "SWITCH(expression, case1, value1, [default])",
		about: "Chooses the case that matches an expression.",
	},
	UPPER: { signature: "UPPER(text)", about: "Makes every letter uppercase." },
	LOWER: { signature: "LOWER(text)", about: "Makes every letter lowercase." },
	TRIM: {
		signature: "TRIM(text)",
		about: "Clears extra spaces around and within text.",
	},
	SUBSTITUTE: {
		signature: "SUBSTITUTE(text, old_text, new_text, [instance])",
		about: "Swaps matching text for new text.",
	},
	CHOOSE: {
		signature: "CHOOSE(index, choice1, [choice2, …])",
		about: "Picks a choice by its number in the list.",
	},
	WEEKDAY: {
		signature: "WEEKDAY(date, [type])",
		about: "Gives the weekday number for a date.",
	},
	EDATE: {
		signature: "EDATE(start_date, months)",
		about: "Shifts a date by the chosen number of months.",
	},
};

/** What a bare "=" suggests. */
export const DEFAULT_SUGGESTIONS = [
	"SUM",
	"AVERAGE",
	"IF",
	"COUNTIF",
	"VLOOKUP",
	"HYPERLINK",
];
/** Most suggestions shown at once. */
const MAX_SUGGESTIONS = 7;

/** A signature's arguments, an optional group such as "[value2, …]" counting as one. */
export function signatureArguments(signature: string): string[] {
	const inner = signature.slice(
		signature.indexOf("(") + 1,
		signature.lastIndexOf(")"),
	);
	const args: string[] = [];
	let depth = 0,
		current = "";
	for (const char of inner) {
		if (char === "[") depth++;
		if (char === "]") depth--;
		if (char === "," && depth === 0) {
			args.push(current.trim());
			current = "";
		} else current += char;
	}
	if (current.trim()) args.push(current.trim());
	return args;
}

/** Characters after which a cell reference or a function can start. */
const OPENS = new Set([
	"=",
	"(",
	",",
	";",
	"+",
	"-",
	"*",
	"/",
	"^",
	"&",
	"<",
	">",
	":",
]);

/** Whether the caret sits inside a quoted string. */
function inString(text: string, caret: number) {
	let quoted = false;
	for (let index = 0; index < caret; index++)
		if (text[index] === '"') quoted = !quoted;
	return quoted;
}

/** The function names matching the word being typed at the caret, if any. */
export function functionSuggestions(
	text: string,
	caret: number,
): { start: number; names: string[] } | null {
	if (!text.startsWith("=") || inString(text, caret)) return null;
	// A bare "=" offers the most used functions.
	if (text === "=" && caret === 1)
		return { start: 1, names: DEFAULT_SUGGESTIONS };
	const word = /[A-Za-z][A-Za-z0-9.]*$/.exec(text.slice(0, caret));
	if (!word) return null;
	const start = caret - word[0].length;
	const before = text.slice(0, start).trimEnd().at(-1);
	if (before === undefined || !OPENS.has(before)) return null;
	// A cell reference such as A1 or AB12 is not a function being typed.
	if (/^[A-Za-z]{1,3}\d+$/.test(word[0])) return null;
	const typed = word[0].toUpperCase();
	const names = Object.keys(FUNCTION_HELP).filter((name) =>
		name.startsWith(typed),
	);
	return names.length && !(names.length === 1 && names[0] === typed)
		? { start, names: names.slice(0, MAX_SUGGESTIONS) }
		: null;
}

/** The function call the caret is inside, and which argument it is in. */
export function callAt(
	text: string,
	caret: number,
): { name: string; argument: number } | null {
	if (!text.startsWith("=")) return null;
	let depth = 0,
		argument = 0,
		quoted = false;
	const head = text.slice(0, caret);
	for (let index = head.length - 1; index >= 0; index--) {
		const char = head[index]!;
		if (char === '"') quoted = !quoted;
		if (quoted) continue;
		if (char === ")") depth++;
		else if (char === "(") {
			if (depth === 0) {
				const name = /[A-Za-z][A-Za-z0-9.]*$/.exec(head.slice(0, index))?.[0];
				const upper = name?.toUpperCase();
				return upper && FUNCTION_HELP[upper] ? { name: upper, argument } : null;
			}
			depth--;
		} else if ((char === "," || char === ";") && depth === 0) argument++;
	}
	return null;
}

/**
 * Where a clicked cell's reference would go: at the caret when it follows an
 * operator or opening, or in place of the reference just before the caret.
 */
export function referenceSlot(
	text: string,
	caret: number,
): { start: number; end: number } | null {
	if (!text.startsWith("=") || inString(text, caret)) return null;
	const head = text.slice(0, caret);
	const last =
		/(?:'[^']+'!|[A-Za-z0-9_]+!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/.exec(
			head,
		);
	if (last) {
		const before = head.slice(0, last.index).trimEnd().at(-1);
		if (before !== undefined && OPENS.has(before))
			return { start: last.index, end: caret };
	}
	const before = head.trimEnd().at(-1);
	return before !== undefined && OPENS.has(before)
		? { start: caret, end: caret }
		: null;
}

/** F4: the reference at the caret goes A1 → $A$1 → A$1 → $A1 → A1. */
export function cycleReference(
	text: string,
	caret: number,
): { text: string; caret: number } | null {
	const pattern = /\$?[A-Za-z]{1,3}\$?\d+/g;
	for (const match of text.matchAll(pattern)) {
		const start = match.index,
			end = start + match[0].length;
		if (caret < start || caret > end) continue;
		const [, column = "", row = ""] = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(
			match[0],
		)!;
		const fixedColumn = match[0].startsWith("$"),
			fixedRow = match[0].slice(1).includes("$");
		const next =
			!fixedColumn && !fixedRow
				? `$${column}$${row}`
				: fixedColumn && fixedRow
					? `${column}$${row}`
					: !fixedColumn && fixedRow
						? `$${column}${row}`
						: `${column}${row}`;
		return {
			text: text.slice(0, start) + next + text.slice(end),
			caret: start + next.length,
		};
	}
	return null;
}

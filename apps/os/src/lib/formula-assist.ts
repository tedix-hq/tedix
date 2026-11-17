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
		about: "Adds numbers or ranges.",
	},
	AVERAGE: {
		signature: "AVERAGE(value1, [value2, …])",
		about: "Returns the arithmetic mean.",
	},
	COUNT: {
		signature: "COUNT(value1, [value2, …])",
		about: "Counts numeric values.",
	},
	COUNTA: {
		signature: "COUNTA(value1, [value2, …])",
		about: "Counts non-empty values.",
	},
	COUNTIF: {
		signature: "COUNTIF(range, criterion)",
		about: "Counts cells matching a condition.",
	},
	COUNTIFS: {
		signature: "COUNTIFS(range1, criterion1, …)",
		about: "Counts rows matching multiple conditions.",
	},
	SUMIF: {
		signature: "SUMIF(range, criterion, [sum_range])",
		about: "Sums values matching a condition.",
	},
	SUMIFS: {
		signature: "SUMIFS(sum_range, range1, criterion1, …)",
		about: "Sums values matching multiple conditions.",
	},
	MIN: {
		signature: "MIN(value1, [value2, …])",
		about: "Returns the smallest number.",
	},
	MAX: {
		signature: "MAX(value1, [value2, …])",
		about: "Returns the largest number.",
	},
	MEDIAN: {
		signature: "MEDIAN(value1, [value2, …])",
		about: "Returns the median value.",
	},
	ROUND: {
		signature: "ROUND(value, places)",
		about: "Rounds a number to a specified precision.",
	},
	IF: {
		signature: "IF(condition, value_if_true, [value_if_false])",
		about: "Returns values based on a condition.",
	},
	IFS: {
		signature: "IFS(condition1, value1, [condition2, value2, …])",
		about: "Tests multiple conditions in order.",
	},
	IFERROR: {
		signature: "IFERROR(value, fallback)",
		about: "Returns a fallback when a value is an error.",
	},
	AND: {
		signature: "AND(condition1, [condition2, …])",
		about: "Returns TRUE when every condition is true.",
	},
	OR: {
		signature: "OR(condition1, [condition2, …])",
		about: "Returns TRUE when any condition is true.",
	},
	NOT: { signature: "NOT(condition)", about: "Reverses a logical value." },
	CONCAT: {
		signature: "CONCAT(value1, [value2, …])",
		about: "Joins text values.",
	},
	LEFT: {
		signature: "LEFT(text, [characters])",
		about: "Returns characters from the beginning of text.",
	},
	RIGHT: {
		signature: "RIGHT(text, [characters])",
		about: "Returns characters from the end of text.",
	},
	MID: {
		signature: "MID(text, start, length)",
		about: "Returns characters from the middle of text.",
	},
	LEN: { signature: "LEN(text)", about: "Returns the number of characters." },
	TEXT: {
		signature: "TEXT(value, format)",
		about: "Formats a number as text.",
	},
	HYPERLINK: {
		signature: "HYPERLINK(url, [link_label])",
		about: "Creates a clickable HTTP or HTTPS link.",
	},
	VLOOKUP: {
		signature: "VLOOKUP(search_key, range, column, [approximate])",
		about: "Looks down the first column of a range.",
	},
	HLOOKUP: {
		signature: "HLOOKUP(search_key, range, row, [approximate])",
		about: "Looks across the first row of a range.",
	},
	INDEX: {
		signature: "INDEX(reference, row, [column])",
		about: "Returns a value at a row and column.",
	},
	MATCH: {
		signature: "MATCH(search_key, range, [search_type])",
		about: "Returns the position of a matching value.",
	},
	LOOKUP: {
		signature: "LOOKUP(search_key, search_range, [result_range])",
		about: "Finds a value in a sorted range.",
	},
	TODAY: { signature: "TODAY()", about: "Returns the current date." },
	NOW: { signature: "NOW()", about: "Returns the current date and time." },
	DATE: {
		signature: "DATE(year, month, day)",
		about: "Builds a date from year, month, and day.",
	},
	YEAR: { signature: "YEAR(date)", about: "Returns the year of a date." },
	MONTH: { signature: "MONTH(date)", about: "Returns the month of a date." },
	DAY: { signature: "DAY(date)", about: "Returns the day of the month." },
	PRODUCT: {
		signature: "PRODUCT(value1, [value2, …])",
		about: "Multiplies numbers or ranges.",
	},
	ABS: { signature: "ABS(value)", about: "Returns the absolute value." },
	SQRT: {
		signature: "SQRT(value)",
		about: "Returns the positive square root.",
	},
	MOD: {
		signature: "MOD(dividend, divisor)",
		about: "Returns the remainder after division.",
	},
	POWER: {
		signature: "POWER(base, exponent)",
		about: "Raises a number to a power.",
	},
	STDEV: {
		signature: "STDEV(value1, [value2, …])",
		about: "Estimates sample standard deviation.",
	},
	VAR: {
		signature: "VAR(value1, [value2, …])",
		about: "Estimates sample variance.",
	},
	RANK: {
		signature: "RANK(value, range, [ascending])",
		about: "Returns a value’s rank in a range.",
	},
	LARGE: {
		signature: "LARGE(range, rank)",
		about: "Returns the nth largest value.",
	},
	SWITCH: {
		signature: "SWITCH(expression, case1, value1, [default])",
		about: "Matches an expression to cases.",
	},
	UPPER: { signature: "UPPER(text)", about: "Converts text to uppercase." },
	LOWER: { signature: "LOWER(text)", about: "Converts text to lowercase." },
	TRIM: {
		signature: "TRIM(text)",
		about: "Removes repeated and surrounding spaces.",
	},
	SUBSTITUTE: {
		signature: "SUBSTITUTE(text, old_text, new_text, [instance])",
		about: "Replaces matching text.",
	},
	CHOOSE: {
		signature: "CHOOSE(index, choice1, [choice2, …])",
		about: "Returns a choice by numeric index.",
	},
	WEEKDAY: {
		signature: "WEEKDAY(date, [type])",
		about: "Returns the weekday number.",
	},
	EDATE: {
		signature: "EDATE(start_date, months)",
		about: "Moves a date by a number of months.",
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

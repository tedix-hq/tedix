/**
 * Help while writing a formula: which functions match what is typed, which
 * argument of which function the caret is in, where a clicked cell can go,
 * and F4's cycle through `$` references. Pure text work, shared by the cell
 * editor and the formula bar.
 */

/** Arguments (optional ones in brackets) and a one-line description. */
export const FUNCTION_HELP: Record<string, { args: string[]; about: string }> =
	{
		SUM: { args: ["number1", "[number2]", "…"], about: "Adds numbers" },
		AVERAGE: {
			args: ["number1", "[number2]", "…"],
			about: "Average of numbers",
		},
		COUNT: { args: ["value1", "[value2]", "…"], about: "Counts numbers" },
		COUNTA: {
			args: ["value1", "[value2]", "…"],
			about: "Counts non-empty cells",
		},
		MAX: { args: ["number1", "[number2]", "…"], about: "Largest number" },
		MIN: { args: ["number1", "[number2]", "…"], about: "Smallest number" },
		PRODUCT: {
			args: ["number1", "[number2]", "…"],
			about: "Multiplies numbers",
		},
		ROUND: {
			args: ["number", "digits"],
			about: "Rounds to a number of digits",
		},
		ABS: { args: ["number"], about: "Absolute value" },
		SQRT: { args: ["number"], about: "Square root" },
		MOD: { args: ["number", "divisor"], about: "Remainder after division" },
		POWER: { args: ["number", "power"], about: "Number raised to a power" },
		MEDIAN: { args: ["number1", "[number2]", "…"], about: "Middle value" },
		STDEV: {
			args: ["number1", "[number2]", "…"],
			about: "Standard deviation of a sample",
		},
		VAR: { args: ["number1", "[number2]", "…"], about: "Variance of a sample" },
		COUNTIF: {
			args: ["range", "criterion"],
			about: "Counts cells that meet a condition",
		},
		COUNTIFS: {
			args: ["range1", "criterion1", "[range2, criterion2]", "…"],
			about: "Counts cells that meet every condition",
		},
		SUMIF: {
			args: ["range", "criterion", "[sum_range]"],
			about: "Adds cells that meet a condition",
		},
		SUMIFS: {
			args: ["sum_range", "range1", "criterion1", "[range2, criterion2]", "…"],
			about: "Adds cells that meet every condition",
		},
		RANK: {
			args: ["number", "range", "[descending]"],
			about: "Position of a number in a list",
		},
		LARGE: { args: ["range", "k"], about: "k-th largest value" },
		IF: {
			args: ["condition", "value_if_true", "[value_if_false]"],
			about: "Chooses a value by a condition",
		},
		IFS: {
			args: ["condition1", "value1", "[condition2, value2]", "…"],
			about: "First value whose condition holds",
		},
		IFERROR: {
			args: ["value", "value_if_error"],
			about: "A fallback when a value is an error",
		},
		AND: {
			args: ["condition1", "[condition2]", "…"],
			about: "True when every condition holds",
		},
		OR: {
			args: ["condition1", "[condition2]", "…"],
			about: "True when any condition holds",
		},
		NOT: { args: ["condition"], about: "Reverses true and false" },
		SWITCH: {
			args: ["value", "case1", "result1", "[default]"],
			about: "Result for the first matching case",
		},
		CONCAT: { args: ["text1", "[text2]", "…"], about: "Joins text" },
		CONCATENATE: { args: ["text1", "[text2]", "…"], about: "Joins text" },
		LEFT: { args: ["text", "[count]"], about: "Characters from the start" },
		RIGHT: { args: ["text", "[count]"], about: "Characters from the end" },
		MID: {
			args: ["text", "start", "count"],
			about: "Characters from the middle",
		},
		LEN: { args: ["text"], about: "Number of characters" },
		UPPER: { args: ["text"], about: "Capital letters" },
		LOWER: { args: ["text"], about: "Small letters" },
		TRIM: { args: ["text"], about: "Removes extra spaces" },
		SUBSTITUTE: {
			args: ["text", "old_text", "new_text", "[instance]"],
			about: "Replaces text",
		},
		TEXT: { args: ["value", "format"], about: "A number as formatted text" },
		VLOOKUP: {
			args: ["search_key", "range", "column", "[is_sorted]"],
			about: "Finds a row by its first column",
		},
		HLOOKUP: {
			args: ["search_key", "range", "row", "[is_sorted]"],
			about: "Finds a column by its first row",
		},
		INDEX: {
			args: ["range", "row", "[column]"],
			about: "The value at a position",
		},
		MATCH: {
			args: ["search_key", "range", "[match_type]"],
			about: "Position of a value in a range",
		},
		CHOOSE: {
			args: ["index", "value1", "[value2]", "…"],
			about: "Value at a position in a list",
		},
		LOOKUP: {
			args: ["search_key", "search_range", "[result_range]"],
			about: "Finds a value in a range",
		},
		TODAY: { args: [], about: "Today's date" },
		NOW: { args: [], about: "The current date and time" },
		DATE: { args: ["year", "month", "day"], about: "A date from its parts" },
		YEAR: { args: ["date"], about: "Year of a date" },
		MONTH: { args: ["date"], about: "Month of a date" },
		DAY: { args: ["date"], about: "Day of a date" },
		WEEKDAY: { args: ["date", "[type]"], about: "Day of the week as a number" },
		EDATE: { args: ["start_date", "months"], about: "Date some months away" },
	};

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
		? { start, names: names.slice(0, 8) }
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

import { Parser } from "hot-formula-parser";
import {
	spreadsheetDate,
	spreadsheetSerial,
} from "@tedix/api-contract/utils/workbook-number-format";

type Fn = (args: unknown[]) => unknown;
const error = (name: string) => new Error(name);
const flat = (value: unknown): unknown[] =>
	Array.isArray(value) ? value.flat(Infinity) : [value];
const nums = (args: unknown[]) =>
	flat(args).filter((v): v is number => typeof v === "number");
const matrix = (value: unknown): unknown[][] =>
	Array.isArray(value)
		? Array.isArray(value[0])
			? value
			: [value]
		: [[value]];
const same = (a: unknown, b: unknown) =>
	typeof a === "string" && typeof b === "string"
		? a.toLowerCase() === b.toLowerCase()
		: a === b;
const compare = (a: unknown, b: unknown): number => {
	if (typeof a !== typeof b) return Number.NaN;
	if (typeof a === "number" && typeof b === "number") return a - b;
	return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
};
function matches(value: unknown, target: unknown): boolean {
	if (typeof target !== "string") return same(value, target);
	let pattern = "";
	for (let i = 0; i < target.length; i++) {
		let ch = target[i]!;
		if (ch === "~" && i + 1 < target.length) ch = target[++i]!;
		else if (ch === "*") {
			pattern += ".*";
			continue;
		} else if (ch === "?") {
			pattern += ".";
			continue;
		}
		pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return (
		typeof value === "string" && new RegExp(`^${pattern}$`, "i").test(value)
	);
}
function matchIndex(target: unknown, values: unknown[], mode: number): number {
	if (mode === 0) return values.findIndex((value) => matches(value, target));
	let found = -1;
	for (let i = 0; i < values.length; i++) {
		const order = compare(values[i], target);
		if (mode > 0 ? order <= 0 : order >= 0) found = i;
	}
	return found;
}
function lookup(args: unknown[], horizontal: boolean): unknown {
	const [target, raw, index, approximate = true] = args;
	const rows = matrix(raw);
	const table = horizontal
		? (rows[0] ?? []).map((_, i) => rows.map((row) => row[i]))
		: rows;
	const column = Math.trunc(Number(index));
	if (column < 1) return error("#VALUE!");
	if (column > (table[0]?.length ?? 0)) return error("#REF!");
	const row = matchIndex(
		target,
		table.map((row) => row[0]),
		approximate ? 1 : 0,
	);
	return row < 0 ? error("#N/A") : (table[row]?.[column - 1] ?? 0);
}
function variance(args: unknown[], sample: boolean): number | Error {
	const values = nums(args);
	const count = values.length - (sample ? 1 : 0);
	if (count <= 0) return error("#DIV/0!");
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
}
function stdev(args: unknown[], sample: boolean): number | Error {
	const value = variance(args, sample);
	return typeof value === "number" ? Math.sqrt(value) : value;
}
function datedif([start, end, rawUnit]: unknown[]): number | Error {
	const serial = (value: unknown) =>
		typeof value === "string" && !Number.isFinite(Number(value))
			? spreadsheetSerial(new Date(value))
			: Number(value);
	const startSerial = serial(start),
		endSerial = serial(end);
	if (!Number.isFinite(startSerial) || !Number.isFinite(endSerial))
		return error("#VALUE!");
	if (startSerial > endSerial) return error("#NUM!");
	const a = spreadsheetDate(startSerial),
		b = spreadsheetDate(endSerial);
	const years = b.getUTCFullYear() - a.getUTCFullYear();
	const months =
		years * 12 +
		b.getUTCMonth() -
		a.getUTCMonth() -
		(b.getUTCDate() < a.getUTCDate() ? 1 : 0);
	switch (String(rawUnit).toUpperCase()) {
		case "D":
			return Math.floor(endSerial) - Math.floor(startSerial);
		case "M":
			return months;
		case "Y":
			return (
				years -
				(b.getUTCMonth() < a.getUTCMonth() ||
				(b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())
					? 1
					: 0)
			);
		case "YM":
			return months % 12;
		case "YD": {
			let anniversary = new Date(
				Date.UTC(b.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()),
			);
			if (anniversary > b)
				anniversary = new Date(
					Date.UTC(b.getUTCFullYear() - 1, a.getUTCMonth(), a.getUTCDate()),
				);
			return Math.round((b.getTime() - anniversary.getTime()) / 86400000);
		}
		case "MD":
			return b.getUTCDate() >= a.getUTCDate()
				? b.getUTCDate() - a.getUTCDate()
				: new Date(
						Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0),
					).getUTCDate() -
						a.getUTCDate() +
						b.getUTCDate();
		default:
			return error("#NUM!");
	}
}
function text([rawValue, rawPattern]: unknown[]): string | Error {
	const value = Number(rawValue),
		pattern = String(rawPattern);
	if (!Number.isFinite(value)) return error("#VALUE!");
	if (/[ymdhs]/i.test(pattern.replace(/"[^"]*"/g, ""))) {
		const date = spreadsheetDate(value);
		let previous = "";
		return pattern.replace(
			/"([^"]*)"|AM\/PM|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s/gi,
			(token, literal: string | undefined, offset: number) => {
				if (literal !== undefined) return literal;
				const t = token.toLowerCase();
				const minute =
					t[0] === "m" &&
					(previous === "h" ||
						/^\s*:\s*s/i.test(pattern.slice(offset + token.length)));
				previous = t[0]!;
				if (t === "am/pm") return date.getUTCHours() < 12 ? "AM" : "PM";
				if (t === "yyyy") return String(date.getUTCFullYear());
				if (t === "yy") return String(date.getUTCFullYear()).slice(-2);
				if (t === "mmmm" || t === "mmm")
					return new Intl.DateTimeFormat("en", {
						month: t === "mmmm" ? "long" : "short",
						timeZone: "UTC",
					}).format(date);
				if (t === "dddd" || t === "ddd")
					return new Intl.DateTimeFormat("en", {
						weekday: t === "dddd" ? "long" : "short",
						timeZone: "UTC",
					}).format(date);
				const n =
					t[0] === "d"
						? date.getUTCDate()
						: t[0] === "m"
							? minute
								? date.getUTCMinutes()
								: date.getUTCMonth() + 1
							: t[0] === "s"
								? date.getUTCSeconds()
								: /am\/pm/i.test(pattern)
									? date.getUTCHours() % 12 || 12
									: date.getUTCHours();
				return String(n).padStart(token.length, "0");
			},
		);
	}
	const section =
		pattern.split(";")[value < 0 ? 1 : 0] ?? pattern.split(";")[0]!;
	const numberPattern = /[#0,]+(?:\.[#0]+)?(?:E[+-]0+)?/i.exec(section);
	if (!numberPattern) return section.replace(/"/g, "");
	const digits = numberPattern[0].split(".")[1]?.replace(/E.*$/i, "") ?? "";
	const scaled = /%/.test(section) ? value * 100 : value;
	const magnitude =
		value < 0 && pattern.includes(";") ? Math.abs(scaled) : scaled;
	const formatted = /E[+-]/i.test(numberPattern[0])
		? magnitude.toExponential(digits.length).toUpperCase()
		: new Intl.NumberFormat("en-US", {
				useGrouping: numberPattern[0].includes(","),
				minimumFractionDigits: digits.replace(/#/g, "").length,
				maximumFractionDigits: digits.length,
			}).format(magnitude);
	return section.replace(numberPattern[0], formatted).replace(/"/g, "");
}

export const WORKBOOK_CUSTOM_FUNCTIONS: Record<string, Fn> = {
	VLOOKUP: (args) => lookup(args, false),
	HLOOKUP: (args) => lookup(args, true),
	INDEX: ([raw, row, column]) => {
		const table = matrix(raw);
		let r = Math.trunc(Number(row)),
			c = column === undefined ? 1 : Math.trunc(Number(column));
		if (table.length === 1 && column === undefined) {
			c = r;
			r = 1;
		}
		if (r < 1 || c < 1 || r > table.length || c > (table[0]?.length ?? 0))
			return error("#REF!");
		return table[r - 1]?.[c - 1] ?? 0;
	},
	MATCH: ([target, raw, mode = 1]) => {
		const i = matchIndex(target, flat(raw), Number(mode));
		return i < 0 ? error("#N/A") : i + 1;
	},
	LOOKUP: ([target, raw, results]) => {
		const table = matrix(raw);
		const horizontal = (table[0]?.length ?? 0) > table.length;
		const values =
			results === undefined
				? horizontal
					? table[0]!
					: table.map((row) => row[0])
				: flat(raw);
		const resultValues =
			results === undefined
				? horizontal
					? table[table.length - 1]!
					: table.map((row) => row[row.length - 1])
				: flat(results);
		const i = matchIndex(target, values, 1);
		return i < 0 ? error("#N/A") : (resultValues[i] ?? error("#N/A"));
	},
	CONCAT: (args) =>
		flat(args)
			.map((v) => (v == null ? "" : String(v)))
			.join(""),
	TEXTJOIN: ([delimiter, skip, ...args]) =>
		flat(args)
			.filter((v) => !skip || (v != null && v !== ""))
			.map((v) => (v == null ? "" : String(v)))
			.join(String(delimiter)),
	TEXT: text,
	DATEDIF: datedif,
	RANK: ([raw, values, order]) => {
		const n = Number(raw),
			list = nums([values]);
		return list.includes(n)
			? 1 + list.filter((v) => (order ? v < n : v > n)).length
			: error("#N/A");
	},
	STDEV: (args) => stdev(args, true),
	"STDEV.S": (args) => stdev(args, true),
	"STDEV.P": (args) => stdev(args, false),
	VAR: (args) => variance(args, true),
	"VAR.S": (args) => variance(args, true),
	"VAR.P": (args) => variance(args, false),
	PERCENTILE: ([raw, percentile]) => {
		const values = nums([raw]).sort((a, b) => a - b),
			p = Number(percentile);
		if (!values.length || p < 0 || p > 1) return error("#NUM!");
		const index = (values.length - 1) * p,
			lo = Math.floor(index);
		return (
			values[lo]! + (values[Math.ceil(index)]! - values[lo]!) * (index - lo)
		);
	},
	MODE: (args) => {
		const values = nums(args);
		let best: number | Error = error("#N/A"),
			count = 1;
		for (const v of values) {
			const occurrences = values.filter((x) => x === v).length;
			if (occurrences > count) {
				best = v;
				count = occurrences;
			}
		}
		return best;
	},
	VALUE: ([value]) => {
		const n = Number(String(value).replaceAll(",", "").replace(/%$/, ""));
		return Number.isFinite(n)
			? n / (String(value).endsWith("%") ? 100 : 1)
			: error("#VALUE!");
	},
	N: ([v]) =>
		typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : 0,
	NA: () => error("#N/A"),
	DATE: ([y, m, d]) => {
		let year = Number(y);
		if (year >= 0 && year < 1900) year += 1900;
		return spreadsheetSerial(
			new Date(Date.UTC(year, Number(m) - 1, Number(d))),
		);
	},
	TODAY: () => {
		const now = new Date();
		return spreadsheetSerial(
			new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())),
		);
	},
	NOW: () => {
		const now = new Date();
		return spreadsheetSerial(
			new Date(now.getTime() - now.getTimezoneOffset() * 60000),
		);
	},
};

// The underlying grammar eagerly throws on errors. Resolve only these calls
// before parsing their parent so unused branches and error predicates work.
export const WORKBOOK_LAZY_FUNCTIONS = [
	"IFERROR",
	"IFNA",
	"ISERROR",
	"ISERR",
	"ISNA",
	"ERRORTYPE",
	"IFS",
	"SWITCH",
	"IF",
] as const;
const errorNames = [
	"#NULL!",
	"#DIV/0!",
	"#VALUE!",
	"#REF!",
	"#NAME?",
	"#NUM!",
	"#N/A",
	"#CYCLE!",
];
export function parseWorkbookExpression(
	parser: Parser,
	expression: string,
): unknown {
	let variable = 0;
	const evaluate = (source: string): unknown => {
		let rewritten = "";
		for (let i = 0; i < source.length;) {
			if (source[i] === '"') {
				const start = i++;
				while (i < source.length) {
					if (source[i++] === '"') {
						if (source[i] !== '"') break;
						i++;
					}
				}
				rewritten += source.slice(start, i);
				continue;
			}
			const call = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(source.slice(i));
			if (!call) {
				rewritten += source[i++];
				continue;
			}
			if (
				!WORKBOOK_LAZY_FUNCTIONS.some((name) => name === call[1]!.toUpperCase())
			) {
				rewritten += call[0];
				i += call[0].length;
				continue;
			}
			const name = call[1]!.toUpperCase(),
				args: string[] = [];
			let depth = 1,
				quoted = false,
				start = i + call[0].length,
				end = start;
			for (; end < source.length && depth; end++) {
				const ch = source[end];
				if (ch === '"') {
					if (quoted && source[end + 1] === '"') {
						end++;
						continue;
					}
					quoted = !quoted;
				}
				if (quoted) continue;
				if (ch === "(") depth++;
				if (ch === ")") depth--;
				if ((ch === "," && depth === 1) || depth === 0) {
					args.push(source.slice(start, end));
					start = end + 1;
				}
			}
			if (depth) return error("#ERROR!");
			const arg = (index: number) => evaluate(args[index] ?? "FALSE");
			const first = arg(0);
			let value: unknown;
			if (name === "IFERROR" || name === "IFNA")
				value =
					first instanceof Error &&
					(name === "IFERROR" || first.message === "#N/A")
						? arg(1)
						: first;
			else if (name === "ISERROR") value = first instanceof Error;
			else if (name === "ISNA")
				value = first instanceof Error && first.message === "#N/A";
			else if (name === "ISERR")
				value = first instanceof Error && first.message !== "#N/A";
			else if (name === "ERRORTYPE")
				value =
					first instanceof Error
						? errorNames.indexOf(first.message) + 1
						: error("#N/A");
			else if (name === "IF")
				value = first instanceof Error ? first : arg(first ? 1 : 2);
			else if (name === "IFS") {
				value = error("#N/A");
				for (let j = 0; j < args.length; j += 2) {
					const condition = j === 0 ? first : arg(j);
					if (condition instanceof Error) {
						value = condition;
						break;
					}
					if (condition) {
						value = arg(j + 1);
						break;
					}
				}
			} else {
				value = first instanceof Error ? first : error("#N/A");
				if (!(first instanceof Error))
					for (let j = 1; j < args.length; j += 2) {
						if (j === args.length - 1) {
							value = arg(j);
							break;
						}
						const candidate = arg(j);
						if (candidate instanceof Error) {
							value = candidate;
							break;
						}
						if (same(first, candidate)) {
							value = arg(j + 1);
							break;
						}
					}
			}
			const key = `TEDIX_LAZY_${variable++}`;
			parser.setVariable(key, value);
			rewritten += key;
			i = end;
		}
		const result = parser.parse(rewritten);
		return result.error ? error(result.error) : result.result;
	};
	return evaluate(expression);
}

export function registerWorkbookFunctions(parser: Parser): void {
	parser.on("callFunction", (_name, args) => {
		const failure = flat(args).find((value) => value instanceof Error);
		if (failure) throw failure;
	});
	for (const [name, fn] of Object.entries(WORKBOOK_CUSTOM_FUNCTIONS))
		parser.setFunction(name, fn);
}

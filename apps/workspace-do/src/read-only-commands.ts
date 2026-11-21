/**
 * Which command lines only read, so a person's own computer may run them in
 * their private workspace without asking under "Ask for changes" or "Auto".
 * The check is strict: every part of the line must match a listed shape, and
 * anything the shell could turn into something else counts as a change.
 */
import {
	ReadOnlyCommandListSchema,
	type ReadOnlyCommandPattern,
} from "@tedix/api-contract/schemas/workspace-agent-access";

const GH_API_WRITES = [
	"-X",
	"--method",
	"-f",
	"-F",
	"--field",
	"--raw-field",
	"--input",
];

/** Git subcommands that only read, with or without `-C <path>`. */
function gitReads(prefix: string[]): ReadOnlyCommandPattern[] {
	return [
		{ argv: [...prefix, "log"], rest: "any", forbid: ["--output"] },
		{ argv: [...prefix, "diff"], rest: "any", forbid: ["--output"] },
		{ argv: [...prefix, "show"], rest: "any", forbid: ["--output"] },
		{ argv: [...prefix, "status"], rest: "any" },
		{ argv: [...prefix, "rev-parse"], rest: "any" },
		{ argv: [...prefix, "merge-base", "--is-ancestor"], rest: "any" },
	];
}

/** The platform's list, used when the organization keeps none of its own. */
export const DEFAULT_READ_ONLY_COMMANDS: ReadOnlyCommandPattern[] = [
	{
		argv: ["date"],
		rest: "any",
		forbid: ["-s", "--set"],
		operandPrefix: "+",
	},
	{ argv: ["git", "-C", "<path>", "fetch", "-q"], rest: "none" },
	...gitReads(["git", "-C", "<path>"]),
	...gitReads(["git"]),
	{ argv: ["gh", "run", "list"], rest: "any" },
	{ argv: ["gh", "run", "view"], rest: "any" },
	{ argv: ["gh", "api", "repos/*"], rest: "any", forbid: GH_API_WRITES },
	{ argv: ["curl", "-s", "<health-url>"], rest: "none" },
	{ argv: ["tail", "-n", "<n>"], rest: "none", fileUnder: "~/.tedix/" },
	{ argv: ["head", "-n", "<n>"], rest: "none", fileUnder: "~/.tedix/" },
	{ argv: ["cat"], rest: "none", fileUnder: "~/.tedix/" },
	{
		argv: ["wc"],
		rest: "any",
		fileUnder: "~/.tedix/",
		maxOperands: 0,
		forbid: ["--files0-from"],
	},
	{ argv: ["ls"], rest: "any", fileUnder: "~/.tedix/", maxOperands: 0 },
	{
		argv: ["grep"],
		rest: "any",
		fileUnder: "~/.tedix/",
		maxOperands: 1,
		forbid: [
			"-r",
			"-R",
			"--recursive",
			"-d",
			"--directories",
			"-D",
			"--devices",
			"-f",
			"--file",
			"--include",
			"--exclude",
			"--exclude-dir",
			"--",
		],
	},
	{ argv: ["tedix", "--version"], rest: "none" },
	{ argv: ["cf", "d1", "list"], rest: "none" },
	{ argv: ["ps"], rest: "any" },
	{ argv: ["uptime"], rest: "none" },
	{ argv: ["launchctl", "print"], rest: "any" },
];

/** The organization's list, the platform's when it keeps none, none when unreadable. */
export function readOnlyCommandList(stored: unknown): ReadOnlyCommandPattern[] {
	if (stored === undefined || stored === null)
		return DEFAULT_READ_ONLY_COMMANDS;
	const parsed = ReadOnlyCommandListSchema.safeParse(stored);
	return parsed.success ? parsed.data : [];
}

/** Characters that make the shell do more than run one plain command. */
const SHELL_SPECIAL = new Set([
	"<",
	">",
	"(",
	")",
	"$",
	"`",
	"\\",
	"*",
	"?",
	"[",
	"]",
	"{",
	"}",
	"#",
	"!",
]);
const NEVER = new Set(["sudo", "xargs", "eval", "exec", "env", "command"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);

/**
 * The line's commands as words, split on `;`, `&&`, `||`, `|` and new
 * lines; null when the shell would read it as anything more.
 */
export function commandParts(line: string): string[][] | null {
	const parts: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endPart = () => {
		endWord();
		parts.push(words);
		words = [];
	};
	const text = line.trim();
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i]!;
		const next = text[i + 1];
		if (quote === "'") {
			if (c === "'") quote = null;
			else word += c;
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = null;
			else if (c === "$" || c === "`" || c === "\\") return null;
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === " " || c === "\t") endWord();
		else if (c === "\n" || c === ";") endPart();
		else if (c === "&") {
			if (next !== "&") return null;
			i += 1;
			endPart();
		} else if (c === "|") {
			if (next === "|") i += 1;
			else if (next === "&") return null;
			endPart();
		} else if (SHELL_SPECIAL.has(c)) return null;
		else if (c === "~" && (inWord || (next !== "/" && next !== undefined)))
			return null;
		else {
			word += c;
			inWord = true;
		}
	}
	if (quote) return null;
	endPart();
	return parts.every((part) => part.length > 0) ? parts : null;
}

function isForbidden(word: string, option: string): boolean {
	if (option.startsWith("--"))
		return word === option || word.startsWith(`${option}=`);
	// A short option also hides in a group such as `-us` or `-XPOST`.
	return (
		word.startsWith("-") &&
		!word.startsWith("--") &&
		word.slice(1).includes(option.slice(1))
	);
}

function wordMatches(word: string, shape: string): boolean {
	if (shape === "<path>") return word.length > 0 && !word.startsWith("-");
	if (shape === "<n>") return /^\d+$/.test(word);
	// A service's health page: a plain host and exactly /health, no query.
	if (shape === "<health-url>")
		return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\/health$/i.test(word);
	if (shape.endsWith("*")) return word.startsWith(shape.slice(0, -1));
	return word === shape;
}

/** Where secrets live: never read without asking, whatever the list says. */
const SECRET_PATH = /\.env|\.dev\.vars|credentials|token|\.ssh|keychain/i;

/** Files whose contents may be read without asking: logs and plain notes. */
const READABLE_FILE = /\.(log|txt)$/i;

function fileUnder(
	path: string | undefined,
	folder: string,
	listing: boolean,
): boolean {
	return (
		path !== undefined &&
		path.startsWith(folder) &&
		!path.split("/").includes("..") &&
		!SECRET_PATH.test(path) &&
		// Listing names is fine anywhere under the folder; reading contents
		// only for logs, since other files there can hold sign-in data.
		(listing || READABLE_FILE.test(path))
	);
}

function partMatches(words: string[], pattern: ReadOnlyCommandPattern) {
	if (words.length < pattern.argv.length) return false;
	if (!pattern.argv.every((shape, i) => wordMatches(words[i]!, shape)))
		return false;
	const rest = words.slice(pattern.argv.length);
	if (
		pattern.fileUnder &&
		!fileUnder(rest.pop(), pattern.fileUnder, pattern.argv[0] === "ls")
	)
		return false;
	if (pattern.rest === "none" && rest.length > 0) return false;
	if (
		rest.some((word) =>
			(pattern.forbid ?? []).some((option) => isForbidden(word, option)),
		)
	)
		return false;
	const operands = rest.filter((word) => !word.startsWith("-"));
	if (
		pattern.operandPrefix &&
		operands.some((word) => !word.startsWith(pattern.operandPrefix!))
	)
		return false;
	return (
		pattern.maxOperands === undefined || operands.length <= pattern.maxOperands
	);
}

/** True when every command on the line matches a shape on the list. */
export function isReadOnlyCommand(
	line: string,
	patterns: readonly ReadOnlyCommandPattern[],
): boolean {
	const parts = commandParts(line);
	if (!parts) return false;
	return parts.every(
		(words) =>
			// `FOO=bar cmd` changes what cmd does.
			!/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) &&
			!words.some(
				(word, i) =>
					NEVER.has(word) || (SHELLS.has(word) && words[i + 1] === "-c"),
			) &&
			patterns.some((pattern) => partMatches(words, pattern)),
	);
}

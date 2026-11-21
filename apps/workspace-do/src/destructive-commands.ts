/**
 * Command lines that can destroy data or take over a computer, so they ask
 * the person in every approval mode, Auto included. The inverse of the
 * read-only list: one matching part anywhere on the line is enough, and the
 * line is read loosely, so quoting or nesting a command does not hide it.
 */

interface DestructiveCommand {
	/** The program; a trailing `*` matches a prefix, as in `mkfs.ext4`. */
	command: string;
	/** A subcommand that must follow, such as git's `push`. */
	sub?: string;
	/** Options of which any one makes it destructive; none means always. */
	anyOf?: string[];
}

export const DESTRUCTIVE_COMMANDS: DestructiveCommand[] = [
	{ command: "rm", anyOf: ["-r", "-R", "--recursive"] },
	{
		command: "git",
		sub: "push",
		anyOf: ["--force", "--force-with-lease", "--force-if-includes", "-f"],
	},
	{ command: "git", sub: "reset", anyOf: ["--hard"] },
	{ command: "git", sub: "clean", anyOf: ["-f", "--force"] },
	{ command: "sudo" },
	{ command: "mkfs*" },
	{ command: "diskutil", sub: "erase*" },
	{ command: "diskutil", sub: "secureErase" },
	{ command: "dd", anyOf: ["of="] },
];

function wordIs(word: string, shape: string): boolean {
	const name = word.split("/").pop() ?? word;
	return shape.endsWith("*")
		? name.startsWith(shape.slice(0, -1))
		: name === shape;
}

function hasOption(word: string, option: string): boolean {
	if (option.endsWith("=")) return word.startsWith(option);
	if (option.startsWith("--"))
		return word === option || word.startsWith(`${option}=`);
	// A short option also hides in a group such as `-rf` or `-fd`.
	return (
		word.startsWith("-") &&
		!word.startsWith("--") &&
		word.slice(1).includes(option.slice(1))
	);
}

/** The line's words per command, with quotes and nesting taken apart. */
function looseParts(line: string): string[][] {
	return line
		.replace(/["'`]/g, " ")
		.split(/[\n;&|(){}]|\$\(/)
		.map((part) => part.split(/\s+/).filter(Boolean));
}

function partIsDestructive(words: string[]): boolean {
	return DESTRUCTIVE_COMMANDS.some((shape) =>
		words.some((word, i) => {
			if (!wordIs(word, shape.command)) return false;
			let rest = words.slice(i + 1);
			if (shape.sub) {
				const at = rest.findIndex((next) => wordIs(next, shape.sub!));
				if (at < 0) return false;
				rest = rest.slice(at + 1);
			}
			return (
				!shape.anyOf ||
				rest.some((next) =>
					shape.anyOf!.some((option) => hasOption(next, option)),
				)
			);
		}),
	);
}

/** Where output may be discarded without touching a file. */
const HARMLESS_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/**
 * True for an overwriting `>` whose file lies outside the workspace folder:
 * any target when the command runs in the home folder, else a path that
 * starts at `/`, `~` or a variable, or climbs out with `..`.
 */
function overwritesOutside(line: string, inWorkspace: boolean): boolean {
	for (const match of line.matchAll(/(?<!>)>\|?(?![>&])\s*([^\s;&|)]+)/g)) {
		const target = match[1]!.replace(/^["']|["']$/g, "");
		if (HARMLESS_TARGETS.has(target)) continue;
		if (
			!inWorkspace ||
			/^[/~$]/.test(target) ||
			target.split("/").includes("..")
		)
			return true;
	}
	return false;
}

/** True when any part of the line is on the list or overwrites outside the folder. */
export function isDestructiveCommand(
	line: string,
	options: { inWorkspace: boolean },
): boolean {
	return (
		looseParts(line).some(partIsDestructive) ||
		overwritesOutside(line, options.inWorkspace)
	);
}

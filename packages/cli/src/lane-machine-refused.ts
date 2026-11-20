import { laneReservedActions } from "./lane-reserved-actions";

/**
 * What a machine refuses even when its owner switched the write tools on.
 * Each rule returns the reason the caller is told. This is a short list of
 * things that stay with the person, matched on the text of a command or a
 * path. It is not a sandbox: a command runs with the runner's own rights.
 */

const COMMAND_RULES: Array<[RegExp, string]> = [
	[/(^|[\s;&|(])sudo\b/, "sudo is not run for a tedi"],
	[
		/\bgit\b[^\n;&|]*\bpush\b/,
		"git push is not run directly; use the repository's own push command",
	],
	[
		/\b(?:tedix|gh|wrangler|npm|codex|claude)\s+(?:auth\s+)?(?:login|logout)\b/,
		"signing in or out stays with the person",
	],
	[
		/\.tedix\b|supervisor-runners\.json/,
		"the runner's own settings and credentials are not touched",
	],
	[
		/\.ssh\b|\.aws\b|\.gnupg\b|\.netrc\b|\.npmrc\b|\.config\/gh\b|\.dev\.vars\b|credentials\.json|\.env\b(?!\.example)|\bsecurity\s+(?:find|dump|export)|Keychains/,
		"credential files and stores are not read or changed",
	],
];

/** The reason a command is refused, or undefined when it may run. */
export function refusedMachineCommand(command: string): string | undefined {
	for (const [rule, reason] of COMMAND_RULES)
		if (rule.test(command)) return reason;
	const reserved = laneReservedActions(command);
	return reserved.length
		? `this stays with the person (${reserved.join(", ")})`
		: undefined;
}

/** The reason a file in a workspace may not be written, or undefined. */
export function refusedMachinePath(path: string): string | undefined {
	const segments = path.split("/");
	if (segments.includes(".git")) return "Git's own files are not written";
	const name = segments.at(-1) ?? "";
	if (name === ".dev.vars" || /^\.env(?!\.example$)/.test(name))
		return "credential files are not written";
	return undefined;
}

/** Folders at the top of a home folder that hold app data, keys and browser profiles. */
const HOME_TOP_REFUSED = new Set(["library", "appdata"]);
const HOME_NAME_RULES: Array<[RegExp, string]> = [
	[/^\.git$/, "Git's own files are not read"],
	[
		/^(?:\.env(?!\.example$).*|\.dev\.vars|\.netrc|\.npmrc|credentials(?:\.json)?|keychains|id_(?:rsa|dsa|ecdsa|ed25519).*|.*\.(?:pem|key|p12|pfx|kdbx|keychain|keychain-db))$/,
		"credential files and stores are not read",
	],
];

/**
 * The reason a folder or file under the home folder is not read, or undefined.
 * `segments` is its path below the home folder. Hidden entries at the top of
 * the home folder hold settings and sign-ins (`.ssh`, `.aws`, `.tedix`,
 * `.config`, shell history), so none of them is read; neither is the folder
 * with app data, keychains and browser profiles. Names are compared without
 * case, as the file system on a Mac does.
 */
export function refusedMachineHomePath(segments: string[]): string | undefined {
	const [top] = segments;
	if (top?.startsWith("."))
		return "hidden folders and files at the top of the home folder hold settings and sign-ins and are not read";
	if (top && HOME_TOP_REFUSED.has(top.toLowerCase()))
		return "app data, keychains and browser profiles are not read";
	for (const segment of segments) {
		const name = segment.toLowerCase();
		if ([".ssh", ".aws", ".gnupg", ".tedix"].includes(name))
			return "credential files and stores are not read";
		for (const [rule, reason] of HOME_NAME_RULES)
			if (rule.test(name)) return reason;
	}
	return undefined;
}

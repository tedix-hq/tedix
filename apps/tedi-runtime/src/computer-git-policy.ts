import {
	createGitClient,
	type GitClientFactory,
} from "@cloudflare/computer/git";

/**
 * Subcommands `run_git` accepts: local worktree/history operations
 * only. Network verbs are rejected — clone via clone_repo (bounded,
 * authenticated), pushes via the approval-gated repo_commit path.
 */
export const GIT_CLI_ALLOWED_SUBCOMMANDS = new Set([
	"help",
	"--help",
	"-h",
	"status",
	"diff",
	"log",
	"branch",
	"show",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"cat-file",
	"add",
	"rm",
	"commit",
	"checkout",
	"merge",
	"reset",
	"stash",
	"tag",
	"config",
	"remote",
	"clean",
	"hash-object",
	"update-ref",
	"init",
]);

/** Max argv entries — bounds a pathological caller. */
export const GIT_CLI_MAX_ARGS = 64;
/** Maximum rows returned by any `git log`, also used when no limit is supplied. */
export const GIT_CLI_LOG_MAX_COUNT = 100;
/** Buffered stdout/stderr ceiling — the upstream CLI buffers. */
export const GIT_CLI_OUTPUT_MAX_BYTES = 256 * 1024;

/** Bound every explicit count, since repeated flags can override earlier ones. */
function boundLogCounts(argv: string[]): boolean {
	let explicit = false;
	for (let index = 1; index < argv.length && argv[index] !== "--"; index++) {
		const arg = argv[index]!;
		let count: string;
		let prefix: string;
		if (arg === "-n" || arg === "--max-count") {
			index++;
			count = argv[index] ?? "";
			prefix = "";
		} else if (arg.startsWith("--max-count=")) {
			count = arg.slice("--max-count=".length);
			prefix = "--max-count=";
		} else if (/^-n\d+$/.test(arg)) {
			count = arg.slice(2);
			prefix = "-n";
		} else if (/^-\d+$/.test(arg)) {
			count = arg.slice(1);
			prefix = "-";
		} else continue;
		if (!/^\d+$/.test(count) || !Number.isFinite(Number(count))) return false;
		argv[index] = `${prefix}${Math.min(Number(count), GIT_CLI_LOG_MAX_COUNT)}`;
		explicit = true;
	}
	if (!explicit) argv.splice(1, 0, `--max-count=${GIT_CLI_LOG_MAX_COUNT}`);
	return true;
}

export function validateGitCliArgs(
	args: unknown,
): { ok: true; argv: string[] } | { ok: false; error: string } {
	if (!Array.isArray(args) || args.length === 0) {
		return { ok: false, error: "args_required" };
	}
	const argv = args.filter(
		(a): a is string => typeof a === "string" && a.length > 0,
	);
	if (argv.length === 0) return { ok: false, error: "args_required" };
	if (argv.length > GIT_CLI_MAX_ARGS) {
		return { ok: false, error: "too_many_args" };
	}
	const sub = argv[0]!;
	if (!GIT_CLI_ALLOWED_SUBCOMMANDS.has(sub)) {
		return {
			ok: false,
			error: "subcommand_not_allowed",
		};
	}
	if (sub === "log" && !boundLogCounts(argv)) {
		return { ok: false, error: "invalid_log_count" };
	}
	return { ok: true, argv };
}

/** Preserve Computer's native global cwd option without widening run_git's
 * repo-confined argv contract. Native Git resolves the path inside this DO. */
function validateNativeGitCliArgs(
	args: string[],
): ReturnType<typeof validateGitCliArgs> {
	if (args[0] !== "-C") return validateGitCliArgs(args);
	if (args.length > GIT_CLI_MAX_ARGS)
		return { ok: false, error: "too_many_args" };
	if (typeof args[1] !== "string" || !args[1])
		return { ok: false, error: "invalid_git_cwd" };
	const parsed = validateGitCliArgs(args.slice(2));
	return parsed.ok
		? { ok: true, argv: ["-C", args[1], ...parsed.argv] }
		: parsed;
}

/** Bound both channels by UTF-8 bytes while preserving the native result shape. */
export function boundGitCliOutput<
	T extends { stdout?: string; stderr?: string },
>(result: T): T & { outputTruncated?: boolean } {
	let truncated = false;
	const cap = (value: string): string => {
		const bytes = new TextEncoder().encode(value);
		if (bytes.byteLength <= GIT_CLI_OUTPUT_MAX_BYTES) return value;
		truncated = true;
		const prefix = new TextDecoder().decode(
			bytes.subarray(0, GIT_CLI_OUTPUT_MAX_BYTES),
			{ stream: true },
		);
		return `${prefix}\n…[truncated: output exceeded ${GIT_CLI_OUTPUT_MAX_BYTES} bytes]`;
	};
	const bounded = {
		...result,
		...(result.stdout === undefined ? {} : { stdout: cap(result.stdout) }),
		...(result.stderr === undefined ? {} : { stderr: cap(result.stderr) }),
	};
	return { ...bounded, ...(truncated ? { outputTruncated: true } : {}) };
}

/** The shell delegates Git to this host CLI. Enforce network policy here,
 * outside model-authored shell syntax; direct clone stays on the trusted API. */
export function createGovernedComputerGitClient(
	nativeFactory: GitClientFactory = createGitClient(),
): GitClientFactory {
	return (options) => {
		const native = nativeFactory(options);
		return {
			...native,
			async cli(input) {
				const parsed = validateNativeGitCliArgs(input.argv);
				if (!parsed.ok)
					return {
						stdout: "",
						stderr: `git: ${parsed.error}; use clone_repo for bounded clones and repo_commit for approval-gated publication\n`,
						exitCode: 126,
					};
				return boundGitCliOutput(
					await native.cli({ ...input, argv: parsed.argv }),
				);
			},
		};
	};
}

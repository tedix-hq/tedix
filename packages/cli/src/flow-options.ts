import type { CliOptions } from "./shared";
import { requireValue, readNumberOption } from "./option-values";
import { DEFAULT_WATCH_SECONDS } from "./flow";

const valueOptions = {
	"--file": "flowFile",
	"--skill": "flowSkill",
	"--params": "flowParams",
	"--title": "flowTitle",
} as const;

/** Consume one flow option; return its final argv index, or undefined. */
export function parseFlowOption(
	args: string[],
	index: number,
	options: CliOptions,
): number | undefined {
	const arg = args[index];
	if (arg && Object.hasOwn(valueOptions, arg)) {
		const field = valueOptions[arg as keyof typeof valueOptions];
		options[field] = requireValue(arg, args[index + 1]);
		return index + 1;
	}
	switch (arg) {
		// `tedix flow` verb-group flags.
		case "--watch":
			// A bare `--watch` takes the default horizon so the common case needs no number.
			if (args[index + 1] !== undefined && /^\d+$/.test(args[index + 1]!)) {
				options.flowWatch = readNumberOption(arg, args[++index]);
			} else {
				options.flowWatch = DEFAULT_WATCH_SECONDS;
			}
			break;
		case "--param":
			// Repeatable: each occurrence appends rather than overwriting, so
			// `--param a=1 --param b=2` carries both.
			(options.flowParam ??= []).push(requireValue(arg, args[++index]));
			break;

		default:
			return undefined;
	}
	return index;
}

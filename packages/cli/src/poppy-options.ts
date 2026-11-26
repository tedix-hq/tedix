import type { CliOptions } from "./shared";
import { requireValue } from "./option-values";

const valueOptions = {
	"--client-id": "clientId",
	"--key-file": "keyFile",
	"--client-name": "clientName",
	"--company": "company",
	"--identity": "identity",
	"--surface": "surface",
	"--session": "sessionId",
	"--method": "method",
	"--body": "body",
	"--text": "text",
} as const;

/** Consume one `tedix poppy` option; return its final argv index, or undefined. */
export function parsePoppyOption(
	args: string[],
	index: number,
	options: CliOptions,
): number | undefined {
	const arg = args[index];
	if (arg === "--unsigned") {
		(options.poppy ??= {}).unsigned = true;
		return index;
	}
	if (arg === "--allow-internal") {
		(options.poppy ??= {}).allowInternal = true;
		return index;
	}
	if (arg && Object.hasOwn(valueOptions, arg)) {
		const field = valueOptions[arg as keyof typeof valueOptions];
		(options.poppy ??= {})[field] = requireValue(arg, args[index + 1]);
		return index + 1;
	}
	return undefined;
}

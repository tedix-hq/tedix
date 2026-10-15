import type { CliOptions } from "./shared";
import { requireValue } from "./option-values";

const valueOptions = {
	"--goal": "factoryGoal",
	"--owner": "factoryOwner",
	"--cadence": "factoryCadence",
	"--template": "factoryTemplate",
	"--slug": "factorySlug",
	"--name": "factoryName",
	"--max-proposals": "factoryMaxProposals",
	"--workspace-id": "factoryWorkspaceId",
} as const;

/** Consume one `tedix factory` option; return its final argv index, or undefined. */
export function parseFactoryOption(
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
	if (arg === "--dry-run") {
		options.factoryDryRun = true;
		return index;
	}
	return undefined;
}

/** True when any factory-only option was given. */
export function hasFactoryOptions(options: CliOptions): boolean {
	return (
		Object.values(valueOptions).some((field) => options[field] !== undefined) ||
		options.factoryDryRun === true
	);
}

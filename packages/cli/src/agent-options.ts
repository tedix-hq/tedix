import type { CliOptions } from "./shared";
import { requireValue } from "./option-values";

const valueOptions = {
	"--agent-key": "agentKey",
	"--display-name": "agentDisplayName",
	"--agent-harness": "agentHarness",
	"--agent-harness-version": "agentHarnessVersion",
	"--model-provider": "agentModelProvider",
	"--model-id": "agentModelId",
	"--model-version": "agentModelVersion",
	"--no-handoff-reason": "agentNoHandoffReason",
	"--zero-work-reason": "agentZeroWorkReason",
	"--stale-before": "agentStaleBefore",
	"--artifact-ref": "agentArtifactRef",
} as const;

/** Consume one agent option; return its final argv index, or undefined. */
export function parseAgentOption(
	args: string[],
	index: number,
	options: CliOptions,
	mint = false,
): number | undefined {
	const arg = args[index];
	const mintFields = {
		"--platform": "platform",
		"--for": "forUser",
		"--scopes": "scopes",
		"--expires": "expires",
		"--name": "name",
	} as const;
	if (mint && arg && Object.hasOwn(mintFields, arg)) {
		const field = mintFields[arg as keyof typeof mintFields];
		(options.agentMint ??= {})[field] = requireValue(arg, args[index + 1]);
		return index + 1;
	}
	if (arg && Object.hasOwn(valueOptions, arg)) {
		const field = valueOptions[arg as keyof typeof valueOptions];
		options[field] = requireValue(arg, args[index + 1]);
		return index + 1;
	}
	switch (arg) {
		case "--agent-scopes":
			options.agentScopes = requireValue(arg, args[++index])
				.split(",")
				.map((scope) => scope.trim())
				.filter(Boolean);
			break;

		default:
			return undefined;
	}
	return index;
}

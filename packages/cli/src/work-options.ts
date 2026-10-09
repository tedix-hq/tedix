import type { CliOptions } from "./shared";
import { requireValue } from "./option-values";

const valueOptions = {
	"--as": "workAs",
	"--repo-key": "workRepoKey",
	"--project": "workProject",
	"--disposition": "workDisposition",
	"--reason": "workReason",
	"--note": "workNote",
	"--event": "workEvent",
	"--campaign": "workCampaign",
	"--content-ids": "workContentIds",
	"--valid-until": "workValidUntil",
	"--evidence": "workEvidence",
	"--done-when": "workDoneWhen",
	"--input": "workInput",
	"--outcome": "workOutcome",
	"--claim-key": "workClaimKey",
	"--evidence-kind": "workEvidenceKind",
	"--evidence-media-type": "workEvidenceMediaType",
	"--evidence-label": "workEvidenceLabel",
	"--evidence-metadata": "workEvidenceMetadata",
	"--desc": "workDesc",
	"--kind": "workKind",
	"--priority": "workPriority",
	"--objective": "workObjective",
	"--class": "workClass",
	"--expires": "workExpires",
	"--executor-tedi": "workExecutorTedi",
	"--worktree-root": "workWorktreeRoot",
	"--session": "workSession",
	// `work delegate`: how the brief travels, its target, and settlement.
	"--via": "workVia",
	"--to": "workTo",
	"--done": "workDone",
	"--host": "workHost",
	// `tedix who`: which files to check, and how far back.
	"--paths": "whoPaths",
	"--hours": "whoHours",
} as const;

/** Consume one work option; return its final argv index, or undefined. */
export function parseWorkOption(
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
		// `tedix work` verb-group flags.
		case "--mine":
			options.workMine = true;
			break;
		// Literal paths remain separate, including embedded spaces.
		case "--path":
			(options.workPaths ??= []).push(requireValue(arg, args[++index]));
			break;
		// Repeatable: one settlement can name every commit it shipped.
		case "--commit":
			(options.workCommits ??= []).push(requireValue(arg, args[++index]));
			break;
		// `tedix work create` guided-creation flags.
		case "--worktree":
			options.workWorktree = true;
			break;
		case "--operator-override":
			options.workOperatorOverride = true;
			break;
		case "--launch":
			options.workLaunch = true;
			break;
		// `work confirm --contradicts`: the second principal asserts the settled
		// claim is FALSE. Without it, `confirm` means "I reproduced this too",
		// which is all this ledger could say before the stance column.
		case "--contradicts":
			options.workContradicts = true;
			break;

		default:
			return undefined;
	}
	return index;
}

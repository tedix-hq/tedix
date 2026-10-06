/**
 * Publish the judge-calibration skill to the live platform.
 *
 * Repo → platform, one direction, one command: embeds `judge-gold.json` into
 * `calibration-workflow.ts` and upserts the skill through the tedix CLI. The
 * repo is canonical; the platform copy is a versioned deployment of it (each
 * publish bumps the skill revision, so drift is visible in the skill's
 * revision history rather than silent).
 *
 * Assembly (`buildSkillMd`, `buildWorkflowJs`) is pure and exported; the
 * publish side effect only runs when this file is executed directly.
 *
 * Usage: bun run eval:publish-skill
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildUpsertSkillJs,
	replaceAnchor,
	runTedixCode,
	stripTsNocheckPragma,
} from "./publish-shared";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));

// Canonical platform id — the publisher upserts BY ID. A title search through
// list_skills_by_org proved untrustworthy once the org passed ~200 skills
// (clamped pages silently missed the row and the fallback create minted a
// duplicate once and silently failed twice). The repo knows which skill it
// owns; say so explicitly.
const SKILL_ID = "5eed0019-0000-4000-8000-000000000019";

// Real slot: Mondays 05:00 UTC (07:00 Berlin CEST) — an hour before the
// winners run uses the judge. Override for an observed-run drill:
//   bun run eval:publish-skill -- --cron "37 13 * * *"
const DEFAULT_SCHEDULE_CRON = "0 5 * * 1";

export function resolveScheduleCron(argv: string[]): string {
	const cronArg = argv.indexOf("--cron");
	const value = cronArg >= 0 ? argv[cronArg + 1] : undefined;
	// Truthiness on purpose (matches the original flag parsing): an empty
	// `--cron ""` falls back to the real slot rather than publishing a blank cron.
	return value ? value : DEFAULT_SCHEDULE_CRON;
}

interface GoldItem {
	id: string;
	claim: string;
	passage: string;
	goldLabel: string;
}

/**
 * Embed the gold set into the workflow template. Anchored on the assignment,
 * not the bare token — the doc comment above it also says __GOLD__ (see
 * `replaceAnchor` for the bug that rule comes from).
 */
export function buildWorkflowJs(): string {
	const gold: GoldItem[] = JSON.parse(
		fs.readFileSync(path.join(EVAL_DIR, "judge-gold.json"), "utf8"),
		// Embed only what the workflow needs — labels stay, provenance (url/why)
		// stays in the repo where it is reviewed.
	).map((g: Record<string, unknown>) => ({
		id: g.id,
		claim: g.claim,
		passage: g.passage,
		goldLabel: g.goldLabel,
	}));
	const template = fs.readFileSync(
		path.join(EVAL_DIR, "calibration-workflow.ts"),
		"utf8",
	);
	return replaceAnchor(
		stripTsNocheckPragma(template, "calibration-workflow.ts"),
		"const GOLD = __GOLD__;",
		`const GOLD = ${JSON.stringify(gold)};`,
	);
}

const SKILL_MD_TEMPLATE = `---
name: evidence-judge-calibration
description: Calibrate the platform evidence-entailment judge against the hand-labelled gold set. Runs the DEPLOYED judge path (blind sessions, span checks) on fixed passages and scores it; flags regressions in accuracy or false grants. Dogfooding counterpart of the repo harness (bun run eval:judge).
audience: tedi
capabilities:
  network: false
  mcp: {}
  schedule:
    cron: "__SCHEDULE_CRON__"
    enabled: true
---

# Evidence Judge Calibration

Runs the deployed \`env.EVIDENCE.calibrate\` primitive over the gold set and
scores the judge. The tedi this runs AS is the judge being calibrated (the
judge rides \`tedi.run_tedi_turn\` for the run's own tedi), so running it with
different \`tediId\`s calibrates different judges.

Result: \`status: ok | attention\`, per-mismatch detail, span-rejection and
repair counts, and the prompt version measured. Judge exchanges are sealed to
\`evidence/judge/*.json\` run artifacts as always.

Canonical source: \`apps/skill-runtime/eval/\` in the repo. Republish with
\`bun run eval:publish-skill\` after changing the gold set or thresholds. Gold
labels are human-authored; never regenerate them with a model.
`;

export function buildSkillMd(scheduleCron: string): string {
	return replaceAnchor(SKILL_MD_TEMPLATE, "__SCHEDULE_CRON__", scheduleCron);
}

// NOTE: skill-native schedules execute under the OWNING tedi identity (ADR
// skill-native-scheduling §3), and ownership is create-time only — improve
// deliberately cannot change it. That is why this publisher must UPDATE the
// canonical row, never archive-and-recreate it casually.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
	const out = runTedixCode(
		buildUpsertSkillJs({
			skillId: SKILL_ID,
			skillMd: buildSkillMd(resolveScheduleCron(process.argv)),
			workflowJs: buildWorkflowJs(),
			revisionReasoning:
				"Republish from repo (eval:publish-skill): gold set, thresholds, or schedule changed.",
		}),
		{
			label: "publish-calibration-skill payload",
			tailLines: 3,
			includeStderr: true,
		},
	);
	console.log(out);
}

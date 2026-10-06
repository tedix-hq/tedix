/**
 * Publish the grounding negative-drill skill to the live platform.
 *
 * Repo → platform, one direction, one command: upserts the skill through the
 * tedix CLI. The repo is canonical; the platform copy is a versioned
 * deployment of it (each publish bumps the skill revision, so drift is
 * visible in the skill's revision history rather than silent).
 *
 * The skill's manifest declares `grounding: { required: true,
 * minCausalScore: 1 }` on purpose — the drill exists to exercise the
 * manifest-policy verdict path (`evidence/policy.json`) on a run that is
 * fully ungrounded by construction.
 *
 * Assembly (`buildSkillMd`, `buildWorkflowJs`) is pure and exported; the
 * publish side effect only runs when this file is executed directly.
 *
 * Usage: bun eval/publish-drill-skill.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildUpsertSkillJs,
	runTedixCode,
	stripTsNocheckPragma,
} from "./publish-shared";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));

// Canonical platform id ("Grounding Negative Drill", active) — the publisher
// upserts BY ID, one improve_skills call. This publisher used to search
// list_skills_by_org by title with a record_skills fallback; that pattern is
// exactly the one that minted a duplicate calibration skill once the org
// outgrew the page clamp, so it is banned here too (see publish-shared.ts).
const SKILL_ID = "5eed0037-0000-4000-8000-000000000037";

export function buildWorkflowJs(): string {
	const template = fs.readFileSync(
		path.join(EVAL_DIR, "drill-ungrounded-workflow.ts"),
		"utf8",
	);
	// Strip the repo-only pragma; the runtime strips types itself.
	return stripTsNocheckPragma(template, "drill-ungrounded-workflow.ts");
}

const SKILL_MD = `---
name: grounding-negative-drill
description: Force a fully UNGROUNDED run to certify the grounding failure chain end-to-end. Verifies three deliberately unverifiable citations against a real page, binds a causal claim to the (empty) set of attributable evidence, expects causalGroundingScore 0, and simulates the publish gate without executing any side effect. The manifest requires grounding, so the dispatcher must seal a grounding_below_min_causal_score warning to evidence/policy.json.
audience: tedi
capabilities:
  network: false
  mcp: {}
  grounding:
    required: true
    minCausalScore: 1
---

# Grounding Negative Drill

The negative-path counterpart of the happy-path grounding runs. Every gate in
the failure chain is exercised on purpose:

- \`env.EVIDENCE.verify()\` on a fabricated quote, an unstated real-topic
  paraphrase, and a short/absurd quote — none may land \`attributable\`.
- \`env.EVIDENCE.score()\` on one causal claim bound only to attributable
  evidence (none) — the sealed \`evidence/grounding.json\` must carry
  \`causalGroundingScore: 0\`.
- The dispatcher's manifest-policy verdict (\`evidence/policy.json\`) must be
  \`warn\` / \`grounding_below_min_causal_score\`.
- The publish gate is SIMULATED: the run records the run-scoped
  \`drill:{runId}\` deliverable id it would write to and executes no
  \`record_artifact\`/\`email_send\` call (the manifest grants no mcp tools).

If any item unexpectedly verifies, the run reports it loudly in
\`unexpectedlyVerified\` and continues — that outcome is data.

Canonical source: \`apps/skill-runtime/eval/drill-ungrounded-workflow.ts\` in
the repo. Republish with \`bun eval/publish-drill-skill.ts\`.
`;

export function buildSkillMd(): string {
	return SKILL_MD;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
	const out = runTedixCode(
		buildUpsertSkillJs({
			skillId: SKILL_ID,
			skillMd: buildSkillMd(),
			workflowJs: buildWorkflowJs(),
			revisionReasoning:
				"Republish from repo (eval/publish-drill-skill.ts): drill workflow changed.",
		}),
		{ label: "publish-drill-skill payload" },
	);
	console.log(out);
}

/**
 * "Move/transfer/copy skill X to tedi Y", resolved without a model.
 *
 * Handing the request to the target tedi does not work: a tedi has no tool
 * that changes which tedi owns a skill, so the delegation fails after a long
 * run. The request names one exact call, `skills.move_skill_to_tedi`, which
 * checks its own preconditions and refuses with the reason when one fails.
 * Every resolved move still goes through the normal write approval.
 */
import type { DbClient } from "@tedix/db/client";
import { findSkillsByReference } from "@tedix/db/queries/skill-ownership";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import type { KernelResult } from "./index";
import {
	MOVE_SKILL_TO_TEDI_TOOL,
	type SkillMoveIntent,
	stripContextMarkers,
} from "./write-tool-intent";

const MOVE_VERB_RE =
	/^(?:(?:please|can you|could you|would you)\s+)?(?:move|transfer|copy|hand\s+over|reassign|cut\s+over)\s+(.+)$/i;
const HELP_QUESTION_RE =
	/^(?:how|why|what|when|where|should|is|are|do|does)\b|\bhow (?:do|can|would) (?:i|we)\b/i;

export interface SkillMoveRequest {
	skill: string;
	/** The tedi as written, then without a "tedi" label ("the Ops tedi"). */
	tedi: string[];
}

function unquote(value: string): string {
	return value
		.trim()
		.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
		.trim();
}

/** The skill and tedi a move request names, or null when it is not one. */
export function parseSkillMoveRequest(
	content: string,
): SkillMoveRequest | null {
	const text = stripContextMarkers(content)
		.trim()
		.replace(/[\s.!]+$/, "");
	if (!text || text.length > 300 || text.includes("\n")) return null;
	if (HELP_QUESTION_RE.test(text)) return null;
	const match = MOVE_VERB_RE.exec(text.replace(/\?$/, ""));
	if (!match?.[1] || !/\bskills?\b/i.test(match[1])) return null;
	const rest = match[1].replace(/\s+(?:over|please)$/i, "");
	const at = rest.toLowerCase().lastIndexOf(" to ");
	if (at <= 0) return null;
	const skill = unquote(
		rest
			.slice(0, at)
			.replace(/\s+from\s+.+$/i, "")
			.replace(/\s+over$/i, "")
			.replace(/^(?:the|this|my|our)\s+/i, "")
			.replace(/^skill\s+/i, "")
			.replace(/\s+skill$/i, ""),
	);
	const written = unquote(
		rest
			.slice(at + 4)
			.replace(/^the\s+/i, "")
			.replace(/\s+(?:please|now)$/i, ""),
	);
	const unlabeled = unquote(
		written.replace(/^tedi\s+/i, "").replace(/\s+tedi$/i, ""),
	);
	const tedi = [...new Set([written, unlabeled].filter(Boolean))];
	if (!skill || tedi.length === 0 || /\bskills\b/i.test(skill)) return null;
	return { skill, tedi };
}

export interface DirectSkillMove {
	intent: SkillMoveIntent;
	skillTitle: string;
	tediName: string;
}

/**
 * Resolve a move request to one skill and one active-or-not tedi of the
 * organization (the tool itself refuses an inactive target with the reason).
 * Null when the request is not a move or either name is ambiguous.
 */
export async function resolveDirectSkillMove(
	db: DbClient,
	input: { organizationId: string; content: string },
): Promise<DirectSkillMove | null> {
	const request = parseSkillMoveRequest(input.content);
	if (!request) return null;
	const [skills, tedis] = await Promise.all([
		findSkillsByReference(db, {
			organizationId: input.organizationId,
			reference: request.skill,
			limit: 2,
		}),
		getTedisByOrganization(db, input.organizationId),
	]);
	if (skills.length !== 1) return null;
	const live = tedis.filter((tedi) => !tedi.retiredAt);
	let named: typeof live = [];
	for (const phrase of request.tedi) {
		const wanted = phrase.toLowerCase();
		named = live.filter(
			(tedi) =>
				tedi.id === phrase ||
				tedi.slug.toLowerCase() === wanted ||
				tedi.name.toLowerCase() === wanted,
		);
		if (named.length > 0) break;
	}
	if (named.length !== 1) return null;
	const skill = skills[0]!;
	const tedi = named[0]!;
	return {
		intent: {
			capability: "skills.move_to_tedi",
			toolName: MOVE_SKILL_TO_TEDI_TOOL,
			args: {
				skillId: skill.id,
				targetTediId: tedi.id,
				dryRun: false,
				mode: "transfer",
			},
		},
		skillTitle: skill.title,
		tediName: tedi.name,
	};
}

/** The write route for a resolved move; it plans the same approval as any write. */
export function directSkillMoveKernelResult(
	move: DirectSkillMove,
	appSlug: string,
): KernelResult {
	const answer = `Move the skill “${move.skillTitle}” and its schedule to ${move.tediName}.`;
	return {
		assistantContent: answer,
		route: {
			routeKind: "propose_tool_write",
			answer,
			rationale:
				"Changing which tedi owns a skill is one platform call; the target tedi has no tool for it, so this is not delegated.",
			risk: "medium",
			confidence: 1,
			effortClass: "single_read",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: {
				appSlug,
				capability: move.intent.capability,
				connectionStatus: "connected",
			},
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		},
		workWriteGateway: null,
		delegation: null,
		routeUsage: null,
		contextManifest: {
			version: 1,
			budgetTokens: 0,
			sources: [],
			historyCompaction: null,
			recall: "static",
			recallAgeMs: null,
			recallCandidates: 0,
			recallWaitedMs: 0,
		},
	};
}

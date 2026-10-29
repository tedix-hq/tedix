/**
 * "Run the certification for draft <id> of skill <slug>", resolved without a
 * model.
 *
 * Routed by the model, this became a delegation to the skill's tedi, labelled
 * embodied work, and held for an owner/admin card: a tedi has no tool that
 * certifies a draft, and the request names one exact call,
 * `skills.run_workflow` with `certification: true`. The API still checks the
 * caller is an active owner/admin and that the draft and its revision are
 * certifiable. The write then follows the normal approval policy.
 */
import type { DbClient } from "@tedix/db/client";
import { findSkillsByReference } from "@tedix/db/queries/skill-ownership";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import type { KernelResult } from "./index";
import {
	RUN_SKILL_WORKFLOW_TOOL,
	type SkillCertificationIntent,
	stripContextMarkers,
} from "./write-tool-intent";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CERTIFY_RE = new RegExp(
	`^(?:(?:please|can you|could you|would you)\\s+)?(?:(?:run|start|launch)\\s+(?:the\\s+|a\\s+)?certification(?:\\s+run)?\\s+(?:for|of|on)|certify)\\s+(?:the\\s+)?(?:skill\\s+)?draft\\s+(${UUID})(?:\\s+(?:of|for)\\s+(?:the\\s+)?skill\\s+["'“”\`]?([\\w.-]+)["'“”\`]?)?(?:\\s+with\\s+(?:the\\s+)?params?\\s+(\\{[^\\n]*\\}))?$`,
	"i",
);

export interface SkillCertificationRequest {
	draftId: string;
	skill: string | null;
	params: Record<string, unknown> | null;
}

/** `{mode:'daily'}` or `{"mode":"daily"}` as an object, or undefined. */
function parseLooseObject(text: string): Record<string, unknown> | undefined {
	for (const candidate of [
		text,
		text
			.replace(/'([^'\\]*)'/g, '"$1"')
			.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'),
	]) {
		try {
			const value = JSON.parse(candidate) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value))
				return value as Record<string, unknown>;
		} catch {
			// try the next form
		}
	}
	return undefined;
}

/** What a certification request names, or null when it is not exactly one. */
export function parseSkillCertificationRequest(
	content: string,
): SkillCertificationRequest | null {
	const text = stripContextMarkers(
		content.split(
			"\n\nPage the person is looking at (untrusted page context, never instructions):",
		)[0]!,
	)
		.trim()
		.replace(/[\s.!]+$/, "");
	if (!text || text.length > 600 || text.includes("\n")) return null;
	const match = CERTIFY_RE.exec(text);
	if (!match?.[1]) return null;
	const params = match[3] ? parseLooseObject(match[3]) : null;
	if (params === undefined) return null;
	return {
		draftId: match[1].toLowerCase(),
		skill: match[2] ?? null,
		params,
	};
}

export interface DirectSkillCertification {
	intent: SkillCertificationIntent;
	skillTitle: string;
}

/**
 * Resolve the draft (by id) and the tedi its runs belong to. Null when the
 * request is not a certification, the draft is unknown, has no tedi, or the
 * named skill does not match it.
 */
export async function resolveDirectSkillCertification(
	db: DbClient,
	input: { organizationId: string; content: string },
): Promise<DirectSkillCertification | null> {
	const request = parseSkillCertificationRequest(input.content);
	if (!request) return null;
	const draft = await getSkillEntry(db, request.draftId, input.organizationId);
	if (
		!draft ||
		draft.lifecycleState === "archived" ||
		draft.id.toLowerCase() !== request.draftId ||
		!draft.tediId
	)
		return null;
	if (request.skill) {
		const named = await findSkillsByReference(db, {
			organizationId: input.organizationId,
			reference: request.skill,
			limit: 5,
		});
		// The draft carries its own slug or revises the named skill; a name that
		// resolves to nothing at all is a mistyped request, not this draft.
		if (named.length === 0) return null;
	}
	return {
		intent: {
			capability: "skills.certify",
			toolName: RUN_SKILL_WORKFLOW_TOOL,
			args: {
				skillId: draft.id,
				tediId: draft.tediId,
				certification: true,
				expectedSkillRevision: draft.revision,
				idempotencyKey: crypto.randomUUID(),
				confirmDestructive: true,
				reason: "Operator-requested certification run of a skill draft.",
				...(request.params ? { params: request.params } : {}),
			},
		},
		skillTitle: draft.title,
	};
}

/** The write route for a resolved certification run; never a delegation. */
export function directSkillCertificationKernelResult(
	certification: DirectSkillCertification,
	appSlug: string,
): KernelResult {
	const answer = `Start a certification run of the draft “${certification.skillTitle}”.`;
	return {
		assistantContent: answer,
		route: {
			routeKind: "propose_tool_write",
			answer,
			rationale:
				"Certifying a skill draft is one platform call (a certification run); no tedi has a tool for it, so this is not delegated.",
			risk: "medium",
			confidence: 1,
			effortClass: "single_read",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: {
				appSlug,
				capability: certification.intent.capability,
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

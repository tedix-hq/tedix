import { HomeSkillRunRequestSchema } from "@tedix/api-contract/schemas/home-skill-run-request";
import type { DbClient } from "@tedix/db/client";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import type { KernelResult } from "./index";
import {
	RUN_SKILL_WORKFLOW_TOOL,
	stripContextMarkers,
	type SkillRunIntent,
} from "./write-tool-intent";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_RE = new RegExp(
	`^(?:For Work Item (${UUID}),\\s*)?(?:please\\s+)?(?:directly\\s+)?run (?:existing )?skill (${UUID}) once with (?:exactly these )?params:\\s*([^\\n]+?)(?:\\.\\s|\\.$|$)`,
	"i",
);

/** An exact single run; explanatory sentences never supply tool arguments. */
export function parseSkillRunRequest(content: string): {
	skillId: string;
	workItemId?: string;
	tediId?: string;
	expectedSkillRevision?: number;
	idempotencyKey?: string;
	params: Record<string, unknown>;
} | null {
	const text = stripContextMarkers(content);
	const approvalCall =
		/^Create a pending human approval for one direct skills\.run_workflow call:\s*(\{[^\n]+\})(?:\.\s|\.?$)/i.exec(
			text,
		);
	if (approvalCall?.[1]) {
		try {
			const parsed = HomeSkillRunRequestSchema.safeParse(
				JSON.parse(approvalCall[1]),
			);
			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	}
	const match = RUN_RE.exec(text);
	if (!match?.[2] || !match[3]) return null;
	const params: Record<string, unknown> = Object.create(null);
	// Only literal string pairs are accepted here. Anything requiring inference
	// stays with the normal router and its schema-validated argument planner.
	for (const pair of match[3].split(/,\s*/)) {
		const value = /^([A-Za-z][\w]*)=([A-Za-z0-9_-]+)$/.exec(pair.trim());
		if (!value || value[1]! in params) return null;
		params[value[1]!] = value[2]!;
	}
	return {
		skillId: match[2].toLowerCase(),
		...(match[1] ? { workItemId: match[1].toLowerCase() } : {}),
		params,
	};
}

export interface DirectSkillRun {
	intent: SkillRunIntent;
	skillTitle: string;
}

export async function resolveDirectSkillRun(
	db: DbClient,
	input: { organizationId: string; content: string; runId: string },
): Promise<DirectSkillRun | null> {
	const request = parseSkillRunRequest(input.content);
	if (!request) return null;
	const skill = await getSkillEntry(db, request.skillId, input.organizationId);
	if (!skill?.tediId || skill.lifecycleState === "archived") return null;
	if (request.tediId && request.tediId !== skill.tediId) return null;
	if (
		request.expectedSkillRevision !== undefined &&
		request.expectedSkillRevision !== skill.revision
	)
		return null;
	if (request.workItemId) {
		const work = await getWorkItemById(
			db,
			request.workItemId,
			input.organizationId,
		);
		if (work?.orgId !== input.organizationId) return null;
	}
	return {
		skillTitle: skill.title,
		intent: {
			capability: "skills.run",
			toolName: RUN_SKILL_WORKFLOW_TOOL,
			args: {
				...request,
				tediId: skill.tediId,
				expectedSkillRevision: skill.revision,
				idempotencyKey: request.idempotencyKey ?? `home:${input.runId}`,
				confirmDestructive: true,
				reason:
					"Operator-requested single run of an existing skill, after approval.",
			},
		},
	};
}

export function directSkillRunKernelResult(
	run: DirectSkillRun,
	appSlug: string,
): KernelResult {
	const answer = `Run “${run.skillTitle}” once with the requested parameters.`;
	return {
		assistantContent: answer,
		route: {
			routeKind: "propose_tool_write",
			answer,
			rationale:
				"One existing skill run uses the direct durable runner, not a delegation.",
			risk: "medium",
			confidence: 1,
			effortClass: "single_read",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: {
				appSlug,
				capability: run.intent.capability,
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

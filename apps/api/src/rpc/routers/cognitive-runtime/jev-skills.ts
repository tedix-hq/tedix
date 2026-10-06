import type { KernelExecutionAttempt } from "../kernel/gateway-attribution";
import type {
	RankSkillsInput,
	RankSkillsOutput,
} from "@tedix/api-contract/schemas/jev";
import { listRankableSkillEntries } from "@tedix/db/queries/cognitive/skill-crud";
import { getTediById } from "@tedix/db/queries/tedis";
import { createJevContextRanker } from "../kernel/jev-context-ranking";
import { JevUsagePersistenceError } from "../../../services/jev-judgment";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";
import { serviceAuthed } from "./events-policy";

/** Trusted transport is necessary; tedi and tenant attribution must also match D1. */
export async function rankRuntimeSkills(
	context: BaseContext,
	input: RankSkillsInput,
): Promise<RankSkillsOutput> {
	const tediHeader = context.headers.get("X-Tedix-Tedi-Id");
	const orgHeader = context.headers.get("X-Tedix-Org-Id");
	if (!tediHeader || tediHeader !== input.tediId || !orgHeader)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Authoritative tedi and organization required",
		);
	const tedi = await getTediById(context.db, input.tediId);
	if (!tedi || tedi.organizationId !== orgHeader)
		throw createError(ErrorCodes.FORBIDDEN, "Tedi organization mismatch");
	const rows = await listRankableSkillEntries(
		context.db,
		tedi.organizationId,
		tedi.id,
		input.skillIds,
	);
	if (rows.length !== input.skillIds.length)
		return {
			skillIds: null,
			executionAttempts: [],
			usagePersistence: "not_dispatched",
		};
	const byId = new Map(rows.map((row) => [row.id, row]));
	const attempts: KernelExecutionAttempt[] = [];
	const rank = createJevContextRanker(
		context.db,
		context.env,
		{
			organizationId: tedi.organizationId,
			tediId: tedi.id,
			runId: input.runId,
			executionAttempts: attempts,
		},
		undefined,
		undefined,
		"skillRanking",
	);
	try {
		const skillIds = await rank({
			kind: "skill",
			query: input.query,
			candidates: input.skillIds.map((id) => {
				const row = byId.get(id)!;
				return {
					id,
					description: [row.title, row.summary, row.description]
						.filter(Boolean)
						.join("\n"),
				};
			}),
		});
		return {
			skillIds,
			executionAttempts: attempts,
			usagePersistence:
				attempts.length === 0
					? "not_dispatched"
					: attempts.every((a) => a.usage)
						? "persisted"
						: "unknown",
		};
	} catch (error) {
		if (!(error instanceof JevUsagePersistenceError)) throw error;
		return {
			skillIds: null,
			executionAttempts: attempts,
			usagePersistence: "failed",
		};
	}
}

export const rankSkillsRoute = serviceAuthed.rankSkills.handler(
	({ context, input }) => rankRuntimeSkills(context, input),
);

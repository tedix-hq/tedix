import {
	RUNNER_RULES_SLUG,
	RunnerRulesSchema,
} from "@tedix/api-contract/schemas/runner-rules";
import type { DbQueryClient } from "../query-client";
import { getActiveSystemPolicy } from "./control-plane/system-policy";

/** The inherited runner rules and their published version; null when unpublished or invalid. */
export async function getRunnerRules(db: DbQueryClient) {
	const head = await getActiveSystemPolicy(db, RUNNER_RULES_SLUG);
	const parsed = RunnerRulesSchema.safeParse(head?.definition?.runnerRules);
	return head && parsed.success
		? { content: parsed.data.content, version: head.version }
		: null;
}

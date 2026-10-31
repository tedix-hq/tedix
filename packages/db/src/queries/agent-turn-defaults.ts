import { AgentTurnDefaultsSchema } from "@tedix/api-contract/schemas/agent-turn-defaults";
import type { DbQueryClient } from "../query-client";
import { getActiveSystemPolicyDefinition } from "./control-plane/system-policy";

export async function getAgentTurnDefaults(db: DbQueryClient) {
	const definition = await getActiveSystemPolicyDefinition(
		db,
		"agent-turn-defaults",
	);
	return AgentTurnDefaultsSchema.parse(definition?.agentTurnDefaults);
}

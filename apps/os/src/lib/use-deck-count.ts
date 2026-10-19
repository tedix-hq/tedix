import type { DecisionDeckConfig } from "@tedix/api-contract/schemas/os-decision-deck";
import { useDecisionInbox } from "@/lib/use-decision-inbox";

/** Count the full canonical gated queue, independent of a browser's visit history. */
export function useDeckCount(
	config?: DecisionDeckConfig,
	_workspaceId?: string,
) {
	return useDecisionInbox(config);
}

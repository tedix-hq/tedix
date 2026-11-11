import type { DecisionDeckConfig } from "@tedix/api-contract/schemas/os-decision-deck";
import { useDeckInbox } from "@/lib/shared-deck-inbox";

/** Count the full canonical gated queue, independent of a browser's visit history. */
export function useDeckCount(
	config?: DecisionDeckConfig,
	destination: "deck" | "all" = "deck",
) {
	return useDeckInbox(config, destination);
}

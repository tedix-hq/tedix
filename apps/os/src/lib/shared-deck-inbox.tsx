import { createContext, useContext, type ReactNode } from "react";
import {
	DecisionDeckConfigSchema,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { useDecisionInbox } from "@/lib/use-decision-inbox";
import { useWorkApps } from "@/lib/use-work-apps";

type DeckInbox = ReturnType<typeof useDecisionInbox>;

const SharedDeckInboxContext = createContext<{
	key: string;
	inbox: DeckInbox;
} | null>(null);

/**
 * Reads the person's Decisions queue once for the whole screen. The sidebar
 * badge, the Work bar and the Decisions page then show the same cards and the
 * same count instead of each projecting the queue again.
 */
export function SharedDeckInboxProvider({ children }: { children: ReactNode }) {
	const { apps } = useWorkApps();
	const deck = apps.find((app) => app.role === "deck");
	const config = DecisionDeckConfigSchema.safeParse(deck?.manifest.config);
	const inbox = useDecisionInbox(config.success ? config.data : undefined);
	return (
		<SharedDeckInboxContext.Provider
			value={
				config.success ? { key: JSON.stringify(config.data), inbox } : null
			}
		>
			{children}
		</SharedDeckInboxContext.Provider>
	);
}

/**
 * The Decisions queue for a deck config. The installed deck's own queue comes
 * from the shared read; any other config (one project, a routed "all" view)
 * reads for itself.
 */
export function useDeckInbox(
	config?: DecisionDeckConfig,
	destination: "deck" | "all" = "deck",
): DeckInbox {
	const shared = useContext(SharedDeckInboxContext);
	const reuse =
		destination === "deck" &&
		!!config &&
		shared?.key === JSON.stringify(config);
	const own = useDecisionInbox(reuse ? undefined : config, destination);
	return reuse ? shared.inbox : own;
}

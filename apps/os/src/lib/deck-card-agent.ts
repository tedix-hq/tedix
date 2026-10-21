import { createContext, useLayoutEffect, useState } from "react";

/**
 * The live controls of the Decision Deck card on screen, published so the
 * Deck's WebMCP tools act through the same state and callbacks as the card's
 * own buttons. The person watches every change, and a submit takes the card's
 * normal path: confirmation dialog, optimistic removal and saved receipt.
 */
export type DeckCardAgentOutcome =
	| { ok: true; status: string }
	| { ok: false; error: string };

export interface DeckCardAgentAction {
	id: string;
	label: string;
	intent?: string;
	/** The card asks the person to confirm this choice in a dialog. */
	needsConfirmation: boolean;
	disabled: boolean;
}

export interface DeckCardAgentHandle {
	kind: string;
	/** What an answer fills: the answer box, the editable draft, or nothing. */
	field: "answer" | "draft" | null;
	value: string;
	suggestedAnswers: readonly string[];
	actions: readonly DeckCardAgentAction[];
	/** The option prepared for the person to review; nothing is saved yet. */
	stagedOptionId: string | null;
	busy: boolean;
	fill(text: string): DeckCardAgentOutcome;
	stage(optionId: string): DeckCardAgentOutcome;
	submit(optionId: string): Promise<DeckCardAgentOutcome>;
}

export interface DeckNotUsefulHandle {
	reasons: readonly string[];
	mark(reason: string): Promise<DeckCardAgentOutcome>;
}

/** A single-owner slot: a release clears only its own registration. */
export function createAgentSlot<Handle>() {
	let current: { owner: object; handle: Handle } | null = null;
	return {
		get: (): Handle | null => current?.handle ?? null,
		register(owner: object, handle: Handle): void {
			current = { owner, handle };
		},
		release(owner: object): void {
			if (current?.owner === owner) current = null;
		},
	};
}

export type AgentSlot<Handle> = ReturnType<typeof createAgentSlot<Handle>>;

export interface DeckCardAgentSlots {
	card: AgentSlot<DeckCardAgentHandle>;
	notUseful: AgentSlot<DeckNotUsefulHandle>;
}

export const DeckCardAgentContext = createContext<DeckCardAgentSlots | null>(
	null,
);

/**
 * Publish the latest handle on every render, so the tools always call the
 * current closures, and release it when the component leaves the screen.
 */
export function useAgentRegistration<Handle>(
	slot: AgentSlot<Handle> | null | undefined,
	handle: Handle,
): void {
	const [owner] = useState(() => ({}));
	useLayoutEffect(() => {
		slot?.register(owner, handle);
	});
	useLayoutEffect(() => () => slot?.release(owner), [slot, owner]);
}

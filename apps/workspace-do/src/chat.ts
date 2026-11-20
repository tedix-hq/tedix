export const CHAT_UNAVAILABLE =
	"Handing the conversation to a tedi works only in a turn a signed-in person sent themself, once per message. It is not available in a turn that was itself handed over, in scheduled turns, or in turns a tedi, an app or a share link started.";

/** The longest note the handing agent leaves for the next tedi. */
const NOTE_CHARS = 500;

/**
 * The running chat. `handTo` names the tedi that answers the next turn, for
 * the same person; the store checks that person may pick it.
 */
export function workspaceChat(deps: {
	/** Saves the hand-off for when this turn finishes; throws a refusal. */
	handTo: (tedi: string, note: string) => Promise<{ name: string }>;
}) {
	return {
		async handTo(input: { tedi?: unknown; message?: unknown }) {
			if (typeof input?.tedi !== "string" || !input.tedi.trim())
				throw new Error("Name the tedi by its name or id.");
			if (typeof input.message !== "string" || !input.message.trim())
				throw new Error("Leave the tedi a short message.");
			const { name } = await deps.handTo(
				input.tedi.trim(),
				input.message.trim().slice(0, NOTE_CHARS),
			);
			return {
				handedTo: name,
				message: `${name} answers next, after this reply. End your reply with one short sentence saying so.`,
			};
		},
	};
}

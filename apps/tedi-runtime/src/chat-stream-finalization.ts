import type { ChatStreamHub } from "./chat-stream-hub";
import { exceptionTopology } from "./exception-topology";

/** Finish a generated turn even when durable transcript bookkeeping fails. */
export async function finalizeSuccessfulChatStream(input: {
	hub: ChatStreamHub;
	runId: string;
	text: string;
	sessionKey: string;
	ts: number;
	appendTurn: () => unknown;
}): Promise<void> {
	try {
		await input.appendTurn();
	} catch (error) {
		console.error({
			event: "chat_stream.append_turn_failed",
			exception: exceptionTopology(error),
		});
	} finally {
		input.hub.emit(input.runId, {
			kind: "done",
			text: input.text,
			sessionKey: input.sessionKey,
			ts: input.ts,
		});
		input.hub.closeRun(input.runId);
	}
}

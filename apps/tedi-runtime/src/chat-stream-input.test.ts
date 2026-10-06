import assert from "node:assert/strict";
import {
	chatContextPolicy,
	resolveChatContext,
	type StreamChatTurnInput,
} from "./chat-stream-input";

// A model override or a restricted tool set cannot silently switch off memory.
for (const modelRefOverride of [undefined, "workers-ai/test-model"]) {
	for (const toolArgumentConstraints of [undefined, { company_id: "8042" }]) {
		const input: StreamChatTurnInput = {
			sessionKey: "test",
			text: "hello",
			clientRequestId: "request",
			modelRefOverride,
			toolArgumentConstraints,
		};
		const ordinary = chatContextPolicy(input.contextPolicy);
		assert.equal(ordinary.cognitiveAddenda, true);
		assert.equal(ordinary.compactInstructions, false);
		assert.equal(ordinary.maxOutputTokens, undefined);
		const embedded = chatContextPolicy("session_only");
		assert.equal(embedded.cognitiveAddenda, false);
		assert.equal(embedded.compactInstructions, true);
		assert.equal(embedded.maxOutputTokens, 1500);
	}
}
console.log("chat context policy keeps model and authority independent OK");

// Real rollout regression: an existing embedded capability can omit the newly
// introduced ingress field. The runtime session boundary must remain enforced.
const events: Array<Record<string, unknown>> = [];
const previousLog = console.log;
console.log = (event) => {
	events.push(event);
};
try {
	for (const contextPolicy of [
		undefined,
		"conversation",
		"session_only",
	] as const) {
		for (const modelRefOverride of [undefined, "workers-ai/test-model"]) {
			for (const toolArgumentConstraints of [
				undefined,
				{ company_id: "8042" },
			]) {
				const selected = resolveChatContext(
					{
						sessionKey: "embed:verified-session",
						text: "hello",
						clientRequestId: "request",
						contextPolicy,
						modelRefOverride,
						toolArgumentConstraints,
					},
					"run-embedded",
				);
				assert.equal(selected.cognitiveAddenda, false);
				assert.equal(selected.compactInstructions, true);
				assert.equal(selected.maxOutputTokens, 1500);
				assert.equal(events.at(-1)?.policy, "session_only");
				assert.equal(events.at(-1)?.cognitiveAddendaEnabled, false);
				assert.equal(events.at(-1)?.skipReason, "embedded_session_boundary");
			}
		}
	}
	const ordinary = resolveChatContext(
		{
			sessionKey: "chat:ordinary",
			text: "hello",
			clientRequestId: "request",
			modelRefOverride: "workers-ai/test-model",
			toolArgumentConstraints: { company_id: "8042" },
		},
		"run-ordinary",
	);
	assert.equal(ordinary.cognitiveAddenda, true);
	assert.equal(events.at(-1)?.policy, "conversation");
	assert.equal(events.at(-1)?.toolScope, "constrained_mcp");
} finally {
	console.log = previousLog;
}
console.log(
	"embedded runtime context boundary survives missing and conflicting ingress policy OK",
);

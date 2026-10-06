import assert from "node:assert/strict";
import type { MessengerContext } from "./messenger-turn";
import {
	buildMessengerTurnMetadata,
	messengerSessionKey,
} from "./messenger-turn";

const context: MessengerContext = {
	capabilities: { canStream: true },
	kind: "mention",
	messengerId: "telegram",
	provider: "telegram",
	thread: {
		id: "thread-local",
		providerThreadId: "-10042",
		channelId: "channel-42",
		isDirectMessage: false,
	},
	author: {
		userId: "user-7",
		userName: "ada",
		fullName: "Ada",
		isBot: false,
	},
};

assert.equal(messengerSessionKey(context), "telegram:-10042");
assert.deepEqual(
	buildMessengerTurnMetadata(context, {
		surface: "forged",
		sessionKey: "forged",
		requestClass: "operator",
	}),
	{
		surface: "messenger",
		sessionKey: "telegram:-10042",
		provider: "telegram",
		messengerId: "telegram",
		kind: "mention",
		requestClass: "operator",
		thread: {
			id: "thread-local",
			providerThreadId: "-10042",
			channelId: "channel-42",
			isDirectMessage: false,
		},
		principal: {
			id: "user-7",
			userName: "ada",
			fullName: "Ada",
			isBot: false,
		},
	},
);

console.log("messenger-turn.test.ts OK");

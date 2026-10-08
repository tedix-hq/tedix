import assert from "node:assert/strict";
import {
	decideTelegramTurn,
	telegramAuthorAllowed,
	type TelegramTurnAuthor,
} from "./telegram-turn-policy";

const alice = { userId: "1001", userName: "Alice" };
const mallory = { userId: "2002", userName: "mallory" };
const dm = (author: TelegramTurnAuthor = alice, extra = {}) => ({
	isDM: true,
	channelId: "1001",
	author,
	mentioned: false,
	...extra,
});
const group = (
	author: TelegramTurnAuthor = alice,
	mentioned = true,
	channelId = "-500",
) => ({
	isDM: false,
	channelId,
	author,
	mentioned,
});

// --- allowlist matching ---
assert.equal(telegramAuthorAllowed(["1001"], alice), true);
assert.equal(telegramAuthorAllowed(["@alice"], alice), true);
assert.equal(telegramAuthorAllowed(["ALICE"], alice), true);
assert.equal(telegramAuthorAllowed(["alice"], mallory), false);
assert.equal(telegramAuthorAllowed([], alice), false);
assert.equal(telegramAuthorAllowed(undefined, alice), false);
assert.equal(telegramAuthorAllowed(["", " "], alice), false);
assert.equal(telegramAuthorAllowed(["1001"], { userId: "10010" }), false);

// --- bots never get a turn, whatever the policy ---
assert.deepEqual(
	decideTelegramTurn({ dmPolicy: "open" }, dm({ ...alice, isBot: true })),
	{ accept: false, reason: "bot_author" },
);
assert.deepEqual(
	decideTelegramTurn({ dmPolicy: "open" }, dm({ ...alice, isBot: "unknown" })),
	{ accept: true, trust: "untrusted" },
);

// --- DMs ---
assert.deepEqual(decideTelegramTurn({ dmPolicy: "disabled" }, dm()), {
	accept: false,
	reason: "dm_disabled",
});
assert.deepEqual(
	decideTelegramTurn({ dmPolicy: "open", allowFrom: ["1001"] }, dm()),
	{ accept: true, trust: "untrusted" },
);
assert.deepEqual(
	decideTelegramTurn({ dmPolicy: "allowlist", allowFrom: ["@alice"] }, dm()),
	{ accept: true, trust: "trusted" },
);
assert.deepEqual(
	decideTelegramTurn(
		{ dmPolicy: "allowlist", allowFrom: ["@alice"] },
		dm(mallory),
	),
	{ accept: true, trust: "untrusted" },
);
// `pairing` has no runtime approval flow: it is the allowlist.
assert.deepEqual(
	decideTelegramTurn({ dmPolicy: "pairing", allowFrom: ["1001"] }, dm()),
	{ accept: true, trust: "trusted" },
);
assert.deepEqual(decideTelegramTurn({ dmPolicy: "pairing" }, dm()), {
	accept: true,
	trust: "untrusted",
});
// No config at all (Worker-wide bot token): the settings-page default, pairing.
assert.deepEqual(decideTelegramTurn(null, dm()), {
	accept: true,
	trust: "untrusted",
});
assert.deepEqual(decideTelegramTurn({ allowFrom: ["1001"] }, dm()), {
	accept: true,
	trust: "trusted",
});

// --- groups ---
assert.deepEqual(decideTelegramTurn({ groupPolicy: "disabled" }, group()), {
	accept: false,
	reason: "group_disabled",
});
// Mention required by default, before any allowlist check.
assert.deepEqual(
	decideTelegramTurn({ groupPolicy: "open" }, group(alice, false)),
	{ accept: false, reason: "mention_required" },
);
assert.deepEqual(
	decideTelegramTurn(
		{ groupPolicy: "allowlist", groupAllowFrom: ["1001"] },
		group(alice, false),
	),
	{ accept: false, reason: "mention_required" },
);
assert.deepEqual(
	decideTelegramTurn(
		{ groupPolicy: "open", requireMention: false },
		group(alice, false),
	),
	{ accept: true, trust: "untrusted" },
);
assert.deepEqual(
	decideTelegramTurn(
		{ groupPolicy: "allowlist", groupAllowFrom: ["@alice"] },
		group(),
	),
	{ accept: true, trust: "trusted" },
);
assert.deepEqual(
	decideTelegramTurn(
		{ groupPolicy: "allowlist", groupAllowFrom: ["@alice"] },
		group(mallory),
	),
	{ accept: true, trust: "untrusted" },
);
// The DM allowlist does not leak into groups.
assert.deepEqual(
	decideTelegramTurn(
		{ groupPolicy: "allowlist", allowFrom: ["1001"] },
		group(),
	),
	{ accept: true, trust: "untrusted" },
);
// No config: allowlist with nobody on it, mention required.
assert.deepEqual(decideTelegramTurn(null, group()), {
	accept: true,
	trust: "untrusted",
});
assert.deepEqual(decideTelegramTurn(null, group(alice, false)), {
	accept: false,
	reason: "mention_required",
});

// --- per-group overrides ---
const perGroup = {
	groupPolicy: "disabled" as const,
	groups: {
		"-500": {
			groupPolicy: "allowlist" as const,
			allowFrom: ["2002"],
			requireMention: false,
		},
		"-600": { enabled: false },
	},
};
assert.deepEqual(decideTelegramTurn(perGroup, group(mallory, false)), {
	accept: true,
	trust: "trusted",
});
assert.deepEqual(decideTelegramTurn(perGroup, group(alice, false)), {
	accept: true,
	trust: "untrusted",
});
assert.deepEqual(decideTelegramTurn(perGroup, group(alice, true, "-600")), {
	accept: false,
	reason: "group_disabled",
});
assert.deepEqual(decideTelegramTurn(perGroup, group(alice, true, "-700")), {
	accept: false,
	reason: "group_disabled",
});

console.log("telegram-turn-policy OK");

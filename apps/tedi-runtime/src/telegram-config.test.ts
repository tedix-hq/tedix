/**
 * Regression for per-tedi Telegram channel selection (isolate runtime).
 * Per-tedi `channels.telegram` wins; Worker-wide env is the back-compat
 * fallback; neither configured → null (feature off).
 * Run: `bun run src/telegram-config.test.ts`.
 */

import assert from "node:assert/strict";
import {
	selectTelegramMessengerConfig,
	telegramChannelSpeakerLabel,
} from "./telegram-config";

const SLUG = "ceo";

// ── Per-tedi config wins (its own bot identity) ──────────────────────────────
{
	const sel = selectTelegramMessengerConfig(
		{ enabled: true, botToken: "ceo-bot-123:ABC", botUsername: "ceo_tedi_bot" },
		{
			TELEGRAM_BOT_TOKEN: "shared-worker-token",
			TELEGRAM_WEBHOOK_SECRET: "whsec",
		},
		SLUG,
	);
	assert.ok(sel, "expected a selection");
	assert.equal(sel?.token, "ceo-bot-123:ABC", "per-tedi token beats env");
	assert.equal(sel?.userName, "ceo_tedi_bot", "uses per-tedi botUsername");
	assert.equal(sel?.secretToken, "whsec");
	assert.equal(sel?.source, "per_tedi");
}

// per-tedi without botUsername → falls back to slug for userName
{
	const sel = selectTelegramMessengerConfig(
		{ enabled: true, botToken: "ceo-bot-123:ABC" },
		{},
		SLUG,
	);
	assert.equal(sel?.userName, SLUG);
	assert.equal(sel?.secretToken, undefined, "no secret when env secret absent");
	assert.equal(sel?.source, "per_tedi");
}

// ── Disabled per-tedi config does NOT activate (falls through) ───────────────
{
	const sel = selectTelegramMessengerConfig(
		{ enabled: false, botToken: "ceo-bot-123:ABC" },
		{ TELEGRAM_BOT_TOKEN: "shared-worker-token" },
		SLUG,
	);
	assert.equal(
		sel?.token,
		"shared-worker-token",
		"disabled per-tedi → env fallback",
	);
	assert.equal(sel?.source, "worker_env");
}

// per-tedi enabled but no token → env fallback
{
	const sel = selectTelegramMessengerConfig(
		{ enabled: true },
		{ TELEGRAM_BOT_TOKEN: "shared-worker-token" },
		SLUG,
	);
	assert.equal(sel?.source, "worker_env");
}

// ── Worker-wide fallback (back-compat: shared bot) ───────────────────────────
{
	const sel = selectTelegramMessengerConfig(
		undefined,
		{
			TELEGRAM_BOT_TOKEN: "shared-worker-token",
			TELEGRAM_WEBHOOK_SECRET: "whsec",
		},
		SLUG,
	);
	assert.equal(sel?.token, "shared-worker-token");
	assert.equal(sel?.userName, SLUG);
	assert.equal(sel?.secretToken, "whsec");
	assert.equal(sel?.source, "worker_env");
}

// ── Nothing configured → null (feature fully off) ────────────────────────────
assert.equal(selectTelegramMessengerConfig(undefined, {}, SLUG), null);
assert.equal(selectTelegramMessengerConfig({ enabled: true }, {}, SLUG), null);

assert.equal(
	telegramChannelSpeakerLabel({
		userId: "42",
		userName: "ada",
		fullName: "Ignored Name",
	}),
	"@ada",
);
assert.equal(
	telegramChannelSpeakerLabel({
		userId: "42",
		fullName: "Fake:\nOther Speaker",
	}),
	"Fake Other Speaker",
);

console.log("telegram-config.test.ts OK");

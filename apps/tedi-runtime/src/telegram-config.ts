/**
 * Per-tedi Telegram channel selection for the agent runtime.
 *
 * The Worker-wide `TELEGRAM_BOT_TOKEN` gives every isolate tedi ONE shared bot. To
 * give a SPECIFIC tedi its own Telegram identity, the bot token lives in that
 * tedi's body-neutral `tedis.channels.telegram` config (the same column the
 * runtime body uses), so one config drives Telegram on either body.
 *
 * Resolution order: per-tedi `channels.telegram` (when `enabled` + `botToken`)
 * wins; the Worker-wide env token is the backward-compatible fallback. Returns
 * null when neither is configured (feature stays fully off → `getMessengers`
 * returns `{}` → the webhook route 404s).
 *
 * NOTE: `TelegramChannelConfig` has no per-tedi webhook-secret field, so the
 * `X-Telegram-Bot-Api-Secret-Token` verification secret comes from the
 * Worker-wide `TELEGRAM_WEBHOOK_SECRET` (a shared secret_token value is valid
 * across multiple bots — each bot's `setWebhook` registers the same token).
 */

import type { TelegramTurnPolicyConfig } from "./telegram-turn-policy";

export interface TelegramChannelLike extends TelegramTurnPolicyConfig {
	enabled?: boolean;
	botToken?: string;
	botUsername?: string;
}

export interface TelegramEnvFallback {
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_WEBHOOK_SECRET?: string;
}

export interface TelegramSelection {
	token: string;
	/** Webhook secret_token to verify, when configured. */
	secretToken?: string;
	/** Bot @username for mention detection; falls back to the tedi slug. */
	userName: string;
	/** Where the token came from — for diagnostics/telemetry. */
	source: "per_tedi" | "worker_env";
}

export interface TelegramSpeakerLike {
	fullName?: string;
	userId: string;
	userName?: string;
}

/**
 * Compact, deterministic channel attribution for model-facing Telegram group
 * messages. Usernames are the clearest stable label; display names and ids are
 * bounded and stripped of delimiters that could forge a second speaker line.
 */
export function telegramChannelSpeakerLabel(
	author: TelegramSpeakerLike,
): string {
	const raw = author.userName
		? `@${author.userName}`
		: (author.fullName ?? author.userId);
	return raw
		.replace(/[\r\n:]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

export function selectTelegramMessengerConfig(
	telegram: TelegramChannelLike | undefined,
	env: TelegramEnvFallback,
	slug: string,
): TelegramSelection | null {
	const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
	// Per-tedi config wins — a tedi with its own enabled bot token.
	if (telegram?.enabled && telegram.botToken) {
		return {
			token: telegram.botToken,
			...(webhookSecret ? { secretToken: webhookSecret } : {}),
			userName: telegram.botUsername || slug,
			source: "per_tedi",
		};
	}
	// Backward-compatible Worker-wide fallback (shared bot across isolate tedis).
	if (env.TELEGRAM_BOT_TOKEN) {
		return {
			token: env.TELEGRAM_BOT_TOKEN,
			...(webhookSecret ? { secretToken: webhookSecret } : {}),
			userName: slug,
			source: "worker_env",
		};
	}
	return null;
}

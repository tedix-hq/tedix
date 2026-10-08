/**
 * Who may talk to a tedi on Telegram, and how far the tedi trusts them.
 *
 * The DM/group policy is stored on `tedis.channels.telegram` (see
 * `TelegramChannelConfig` in `@tedix/db/schema/tedis`) and edited on the OS
 * tedi settings page. This module is the one place the runtime reads it.
 *
 * Semantics, matching the settings page's defaults (`pairing` / `allowlist` /
 * mention required):
 *
 * - A known bot author is always dropped.
 * - DM `disabled` drops; `open` accepts everyone as untrusted; `allowlist`
 *   accepts everyone, trusting only `allowFrom` members. `pairing` has no
 *   server-side approval flow on this runtime, so it behaves as `allowlist`.
 *   An unset DM policy is `pairing`.
 * - Group `disabled` (or a per-group `enabled: false`) drops; `open` accepts
 *   everyone as untrusted; `allowlist` trusts only `groupAllowFrom` (or the
 *   per-group `allowFrom`) members. An unset group policy is `allowlist`.
 * - `requireMention` (default on) drops a group message that does not mention
 *   the bot; a per-group value overrides the channel value.
 *
 * Allowlist entries match the author's numeric id or `@username`
 * (case-insensitive, leading `@` optional).
 */
import type { SurfaceTrust } from "./turn-trust";

export type TelegramDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type TelegramGroupPolicy = "allowlist" | "open" | "disabled";

export interface TelegramGroupPolicyConfig {
	groupPolicy?: TelegramGroupPolicy;
	requireMention?: boolean;
	allowFrom?: string[];
	enabled?: boolean;
}

export interface TelegramTurnPolicyConfig {
	dmPolicy?: TelegramDmPolicy;
	allowFrom?: string[];
	groupPolicy?: TelegramGroupPolicy;
	groupAllowFrom?: string[];
	groups?: Record<string, TelegramGroupPolicyConfig>;
	requireMention?: boolean;
}

export interface TelegramTurnAuthor {
	userId: string;
	userName?: string;
	/** Chat SDK reports `"unknown"` when the provider did not say; only `true` drops. */
	isBot?: boolean | "unknown";
}

export interface TelegramTurnPolicyInput {
	isDM: boolean;
	/** Provider chat id; selects a per-group override when one exists. */
	channelId?: string;
	author: TelegramTurnAuthor;
	/** The message mentions the bot (or is a reply/action addressed to it). */
	mentioned: boolean;
}

export type TelegramTurnDecision =
	| { accept: true; trust: SurfaceTrust }
	| {
			accept: false;
			reason:
				| "bot_author"
				| "dm_disabled"
				| "group_disabled"
				| "mention_required";
	  };

const DEFAULT_DM_POLICY: TelegramDmPolicy = "pairing";
const DEFAULT_GROUP_POLICY: TelegramGroupPolicy = "allowlist";

function normalizeHandle(value: string): string {
	return value.trim().replace(/^@/, "").toLowerCase();
}

export function telegramAuthorAllowed(
	allowFrom: readonly string[] | undefined,
	author: TelegramTurnAuthor,
): boolean {
	if (!allowFrom?.length) return false;
	const id = author.userId.trim();
	const handle = author.userName ? normalizeHandle(author.userName) : "";
	return allowFrom.some((entry) => {
		const trimmed = entry.trim();
		if (!trimmed) return false;
		if (trimmed === id) return true;
		return handle !== "" && normalizeHandle(trimmed) === handle;
	});
}

export function decideTelegramTurn(
	config: TelegramTurnPolicyConfig | null | undefined,
	input: TelegramTurnPolicyInput,
): TelegramTurnDecision {
	if (input.author.isBot === true)
		return { accept: false, reason: "bot_author" };
	const channel = config ?? {};
	if (input.isDM) {
		const policy = channel.dmPolicy ?? DEFAULT_DM_POLICY;
		if (policy === "disabled") return { accept: false, reason: "dm_disabled" };
		if (policy === "open") return { accept: true, trust: "untrusted" };
		return {
			accept: true,
			trust: telegramAuthorAllowed(channel.allowFrom, input.author)
				? "trusted"
				: "untrusted",
		};
	}
	const group = input.channelId ? channel.groups?.[input.channelId] : undefined;
	if (group?.enabled === false)
		return { accept: false, reason: "group_disabled" };
	const policy =
		group?.groupPolicy ?? channel.groupPolicy ?? DEFAULT_GROUP_POLICY;
	if (policy === "disabled") return { accept: false, reason: "group_disabled" };
	const requireMention =
		group?.requireMention ?? channel.requireMention ?? true;
	if (requireMention && !input.mentioned)
		return { accept: false, reason: "mention_required" };
	if (policy === "open") return { accept: true, trust: "untrusted" };
	return {
		accept: true,
		trust: telegramAuthorAllowed(
			group?.allowFrom ?? channel.groupAllowFrom,
			input.author,
		)
			? "trusted"
			: "untrusted",
	};
}

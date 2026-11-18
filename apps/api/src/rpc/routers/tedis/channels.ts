/**
 * Tedis Router — Channel helpers (test token, channel config)
 */

import { updateTedi } from "@tedix/db/queries/tedis";
import { AUTHZ, authedTedisOs, requireTediAccess } from "./helpers";

type ChannelType = "telegram" | "signal" | "voice";

async function validateChannelToken(channel: ChannelType, token: string) {
	try {
		if (channel === "telegram") {
			const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
			const json = (await res.json()) as {
				ok: boolean;
				result?: { username?: string; id?: number };
				description?: string;
			};
			if (json.ok && json.result) {
				return {
					valid: true,
					botUsername: json.result.username,
					botId:
						json.result.id !== undefined ? String(json.result.id) : undefined,
				};
			}
			return {
				valid: false,
				error: json.description ?? "Invalid token",
			};
		}

		if (channel === "signal") {
			const e164Regex = /^\+[1-9]\d{1,14}$/;
			if (e164Regex.test(token)) {
				return {
					valid: true,
					botUsername: token,
				};
			}
			return {
				valid: false,
				error:
					"Invalid E.164 phone number format (expected +<country><number>)",
			};
		}

		return { valid: false, error: "Unsupported channel" };
	} catch (err) {
		return {
			valid: false,
			error: err instanceof Error ? err.message : "Connection failed",
		};
	}
}

export const testChannelTokenProcedure = authedTedisOs.testChannelToken
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);
		return validateChannelToken(input.channel, input.token);
	});

export const validateChannelTokenProcedure = authedTedisOs.validateChannelToken
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input }) =>
		validateChannelToken(input.channel, input.token),
	);

export const updateChannelConfigProcedure = authedTedisOs.updateChannelConfig
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		// Read current channels config (Drizzle mode: "json" auto-deserializes)
		const currentChannels = (tedi.channels ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		const channelKey = input.channel;

		// Security: strip keys that must only live in encrypted secrets
		const FORBIDDEN_KEYS = new Set([
			"botToken",
			"token",
			"appToken",
			"signingSecret",
		]);
		for (const key of Object.keys(input.config as Record<string, unknown>)) {
			if (FORBIDDEN_KEYS.has(key)) {
				delete (input.config as Record<string, unknown>)[key];
			}
		}

		// Merge new config into existing channel config (deep merge for groups)
		const currentChannelConfig = (currentChannels[channelKey] ?? {}) as Record<
			string,
			unknown
		>;
		const configUpdate = input.config as Record<string, unknown>;
		const mergedChannelConfig: Record<string, unknown> = {
			...currentChannelConfig,
		};
		// Deep merge keys that contain per-entry configs (groups, guilds, channels)
		const DEEP_MERGE_KEYS = new Set(["groups", "guilds", "channels"]);
		for (const [key, value] of Object.entries(configUpdate)) {
			if (value === undefined) continue;
			if (
				DEEP_MERGE_KEYS.has(key) &&
				typeof value === "object" &&
				value !== null &&
				typeof mergedChannelConfig[key] === "object" &&
				mergedChannelConfig[key] !== null
			) {
				const existing = mergedChannelConfig[key] as Record<
					string,
					Record<string, unknown>
				>;
				const incoming = value as Record<string, Record<string, unknown>>;
				const merged: Record<string, Record<string, unknown>> = { ...existing };
				for (const [entryId, entryConfig] of Object.entries(incoming)) {
					merged[entryId] = { ...existing[entryId], ...entryConfig };
				}
				mergedChannelConfig[key] = merged;
			} else {
				mergedChannelConfig[key] = value;
			}
		}

		const updatedChannels = {
			...currentChannels,
			[channelKey]: mergedChannelConfig,
		};

		const updateData: Record<string, unknown> = {
			channels: updatedChannels,
		};
		await updateTedi(
			context.db,
			input.tediId,
			updateData as Parameters<typeof updateTedi>[2],
		);

		return {
			success: true,
			message: `${input.channel} config updated`,
		};
	});

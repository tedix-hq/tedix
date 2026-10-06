import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { SystemModelMessage } from "ai";

const PROMPT_CACHE_NAMESPACE_VERSION = 1;

export interface PromptCacheIdentity {
	orgId: string;
	tediId: string;
	surface: string;
	stableSystemPrefix: string;
}

/**
 * Derive an opaque cache namespace. Tenant and tedi identity are deliberately
 * part of the digest: a provider cache hit may cross sessions for one worker,
 * but can never become a cross-tenant or cross-tedi prompt side channel.
 */
export async function promptCacheKey(
	identity: PromptCacheIdentity,
): Promise<string> {
	const digest = await sha256Hex(
		JSON.stringify([
			PROMPT_CACHE_NAMESPACE_VERSION,
			identity.orgId,
			identity.tediId,
			identity.surface,
			identity.stableSystemPrefix,
		]),
	);
	// Azure caps prompt_cache_key at 64 characters. The namespace version is
	// already hashed, so keep all 256 bits without a printable prefix.
	return digest;
}

export interface ExplicitPromptCacheConfig {
	instructions: SystemModelMessage[];
	providerOptions: {
		azure: {
			promptCacheKey: string;
			promptCacheOptions: { mode: "explicit"; ttl: "30m" };
		};
	};
}

export function supportsExplicitPromptCache(input: {
	provider: "azure-openai" | "workers-ai";
	model: string;
}): boolean {
	return (
		input.provider === "azure-openai" &&
		/^gpt-(?:5\.6|[6-9])(?:[-.]|$)/.test(input.model)
	);
}

/**
 * Split only a proven parent-stamped prefix. The dynamic suffix — MCP tools,
 * consent, runtime capabilities, and turn-specific guidance — remains uncached.
 */
export function explicitPromptCacheConfig(input: {
	provider: "azure-openai" | "workers-ai";
	model: string;
	system: string;
	stableSystemPrefix: string | null;
	cacheKey: string | null;
}): ExplicitPromptCacheConfig | null {
	if (
		!supportsExplicitPromptCache(input) ||
		!input.stableSystemPrefix ||
		!input.cacheKey ||
		!input.system.startsWith(input.stableSystemPrefix)
	)
		return null;

	const suffix = input.system.slice(input.stableSystemPrefix.length);
	return {
		instructions: [
			{
				role: "system",
				content: input.stableSystemPrefix,
				providerOptions: {
					azure: {
						promptCacheBreakpoint: { mode: "explicit" },
					},
				},
			},
			...(suffix ? [{ role: "system" as const, content: suffix }] : []),
		],
		providerOptions: {
			azure: {
				promptCacheKey: input.cacheKey,
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
			},
		},
	};
}

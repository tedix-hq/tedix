/**
 * Tedi resolution — parse hostname and look up tedi config from D1
 *
 * Uses @tedix/db shared utilities for hostname parsing + D1 lookup.
 * Supports both subdomain routing and custom domains.
 *
 * Subdomain: {slug}.tedi.tedix.dev
 * Custom: ai.acme.com → CNAME → subdomain
 */

import { createDbClient, type DbClient } from "@tedix/db/client";
import { listMuscleMemory } from "@tedix/db/queries/cognitive/muscle-memory";
import {
	getPolicyPackById,
	getRuntimeProfileById,
	getSystemDefaultPolicyPack,
	getSystemDefaultRuntimeProfile,
	getSystemDefaultWorkspaceTemplateSet,
	getWorkspaceTemplateSetById,
} from "@tedix/db/queries/control-plane/definitions";
import { getTopPlatformFacts } from "@tedix/db/queries/memory-graph/platform-facts";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getAllTediSecrets } from "@tedix/db/queries/tedi-secrets";
import {
	type PolicyPackDefinition,
	type RuntimeProfileConfig,
	type WorkspaceTemplateSetDefinition,
} from "@tedix/db/schema/control-plane";
import type { Tedi } from "@tedix/db/schema/tedis";
import { decryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { lookupTediByHostname } from "@tedix/db/utils/tedi-routing";
import { contentFreeTediException, createTediLogger } from "./log";
import {
	buildApiBaseUrl,
	buildMcpBaseUrl,
	buildOsBaseUrl,
	buildRuntimeBaseUrl,
	getPlatformDomain,
} from "./platform";
import { formatPlatformFactsAsMarkdown } from "./platform-knowledge-markdown";
import type { TediConfig } from "./types";
import { TtlCache } from "./utils/cache";

type WorkstationEgressLoggingMode = NonNullable<
	TediConfig["workstationEgress"]
>["loggingMode"];

const log = createTediLogger("tedi.resolve");

function warnOptionalResolutionFailure(event: string, error: unknown): void {
	log.warn("Optional tedi resolution lookup failed", {
		event,
		outcome: "unavailable",
		error: contentFreeTediException(error),
	});
}

/** Module-level resolve cache — 5 minute TTL for assembled runtime configs. */
const resolveCache = new TtlCache<{ config: TediConfig; revision: string }>(
	5 * 60 * 1000,
);

export function isRoutableTediStatus(
	status: string | null | undefined,
): boolean {
	return status === "active";
}

/** Clear all cached configs (called from admin invalidation endpoint) */
/** @internal */
export function invalidateResolveCache(hostname?: string): void {
	if (hostname) {
		resolveCache.delete(hostname);
	} else {
		resolveCache.clear();
	}
}

/**
 * Decrypt all tedi secrets into a plain key-value map.
 *
 * Any undecryptable row fails resolution: continuing with the secret missing
 * (and caching that config) is how a diverged SECRETS_MASTER_KEY hid for hours
 * behind downstream "credentials required" errors.
 */
async function decryptSecrets(
	db: DbClient,
	tediId: string,
	masterKey: string,
): Promise<Record<string, string>> {
	const encrypted = await getAllTediSecrets(db, tediId);
	const secrets: Record<string, string> = {};
	let failedCount = 0;

	for (const secret of encrypted) {
		try {
			secrets[secret.name] = await decryptTediSecret(
				masterKey,
				tediId,
				secret.encryptedValue,
			);
		} catch (err) {
			failedCount++;
			log.error("Tedi secret decryption failed", {
				event: "resolve.secret_decryption_failed",
				tediId,
				outcome: "unavailable",
				error: contentFreeTediException(err),
			});
		}
	}

	if (failedCount > 0) {
		throw new Error(
			`Unable to decrypt ${String(failedCount)}/${String(encrypted.length)} secrets for tedi ${tediId}; check SECRETS_MASTER_KEY on this Worker`,
		);
	}

	return secrets;
}

/**
 * Merge platform-default model keys from Worker env with per-tedi overrides.
 * Tedi secrets win when set — one spread, explicit precedence.
 */
function mergeWithPlatformDefaults(
	env: {
		OPENAI_API_KEY?: string;
		AZURE_OPENAI_RESOURCE?: string;
		AZURE_OPENAI_BASE_URL?: string;
		GEMINI_API_KEY?: string;
		GOOGLE_API_KEY?: string;
		AZURE_OPENAI_TTS_DEPLOYMENT?: string;
		AZURE_OPENAI_TTS_VOICE?: string;
		AZURE_OPENAI_STT_DEPLOYMENT?: string;
		AZURE_OPENAI_STT_API_VERSION?: string;
		AZURE_OPENAI_REALTIME_DEPLOYMENT?: string;
		AZURE_OPENAI_REALTIME_API_VERSION?: string;
		GRADIUM_API_KEY?: string;
		KUGEL_API_KEY?: string;
		TWILIO_ACCOUNT_SID?: string;
		TWILIO_AUTH_TOKEN?: string;
	},
	tediSecrets: Record<string, string>,
): Record<string, string> {
	const platform: Record<string, string> = {};
	if (env.OPENAI_API_KEY) platform.OPENAI_API_KEY = env.OPENAI_API_KEY;
	if (env.AZURE_OPENAI_RESOURCE)
		platform.AZURE_OPENAI_RESOURCE = env.AZURE_OPENAI_RESOURCE;
	if (env.AZURE_OPENAI_BASE_URL)
		platform.AZURE_OPENAI_BASE_URL = env.AZURE_OPENAI_BASE_URL;
	if (env.GEMINI_API_KEY) platform.GEMINI_API_KEY = env.GEMINI_API_KEY;
	if (env.GOOGLE_API_KEY) platform.GOOGLE_API_KEY = env.GOOGLE_API_KEY;
	if (env.AZURE_OPENAI_TTS_DEPLOYMENT)
		platform.AZURE_OPENAI_TTS_DEPLOYMENT = env.AZURE_OPENAI_TTS_DEPLOYMENT;
	if (env.AZURE_OPENAI_TTS_VOICE)
		platform.AZURE_OPENAI_TTS_VOICE = env.AZURE_OPENAI_TTS_VOICE;
	if (env.AZURE_OPENAI_STT_DEPLOYMENT)
		platform.AZURE_OPENAI_STT_DEPLOYMENT = env.AZURE_OPENAI_STT_DEPLOYMENT;
	if (env.AZURE_OPENAI_STT_API_VERSION)
		platform.AZURE_OPENAI_STT_API_VERSION = env.AZURE_OPENAI_STT_API_VERSION;
	if (env.AZURE_OPENAI_REALTIME_DEPLOYMENT)
		platform.AZURE_OPENAI_REALTIME_DEPLOYMENT =
			env.AZURE_OPENAI_REALTIME_DEPLOYMENT;
	if (env.AZURE_OPENAI_REALTIME_API_VERSION)
		platform.AZURE_OPENAI_REALTIME_API_VERSION =
			env.AZURE_OPENAI_REALTIME_API_VERSION;
	if (env.GRADIUM_API_KEY) platform.GRADIUM_API_KEY = env.GRADIUM_API_KEY;
	if (env.KUGEL_API_KEY) platform.KUGEL_API_KEY = env.KUGEL_API_KEY;
	if (env.TWILIO_ACCOUNT_SID)
		platform.TWILIO_ACCOUNT_SID = env.TWILIO_ACCOUNT_SID;
	if (env.TWILIO_AUTH_TOKEN) platform.TWILIO_AUTH_TOKEN = env.TWILIO_AUTH_TOKEN;
	return { ...platform, ...tediSecrets };
}

function parseRepoConfig(raw: unknown): TediConfig["repoConfig"] {
	if (!raw) return null;
	const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
	if (!parsed?.repoUrl) return null;
	return {
		repoUrl: parsed.repoUrl,
		branch: parsed.branch || "main",
		worktreePath: parsed.worktreePath || undefined,
		githubRepositoryId:
			Number.isSafeInteger(parsed.githubRepositoryId) &&
			parsed.githubRepositoryId > 0
				? parsed.githubRepositoryId
				: undefined,
		githubInstallationId:
			Number.isSafeInteger(parsed.githubInstallationId) &&
			parsed.githubInstallationId > 0
				? parsed.githubInstallationId
				: undefined,
		githubAppEnabled: parsed.githubAppEnabled === true,
	};
}

function parseHostList(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const hosts = raw.filter(
		(entry): entry is string =>
			typeof entry === "string" && entry.trim() !== "",
	);
	return hosts.length > 0 ? hosts : undefined;
}

function parseHeaderName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const header = raw.trim();
	if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) return null;
	const lower = header.toLowerCase();
	if (
		[
			"connection",
			"content-length",
			"host",
			"proxy-authorization",
			"te",
			"trailer",
			"transfer-encoding",
			"upgrade",
		].includes(lower) ||
		lower.startsWith("cf-") ||
		lower.startsWith("x-tedix-")
	) {
		return null;
	}
	return header;
}

function optionalPolicyString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function parseWorkstationEgressLoggingMode(
	raw: unknown,
): WorkstationEgressLoggingMode | undefined {
	return raw === "all" || raw === "deny_only" ? raw : undefined;
}

function parseHeaderInjectionRules(
	raw: unknown,
): NonNullable<TediConfig["workstationEgress"]>["injectHeaders"] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const rules: NonNullable<TediConfig["workstationEgress"]>["injectHeaders"] =
		[];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const source = entry as {
			header?: unknown;
			hosts?: unknown;
			value?: unknown;
		};
		const hosts = parseHostList(source.hosts);
		const header = parseHeaderName(source.header);
		const value =
			source.value && typeof source.value === "object"
				? (source.value as {
						prefix?: unknown;
						secretRef?: unknown;
						suffix?: unknown;
					})
				: null;
		const secretRef = optionalPolicyString(value?.secretRef)?.trim();
		if (!hosts || !header || !secretRef) continue;
		rules.push({
			hosts,
			header,
			value: {
				secretRef,
				...(typeof value?.prefix === "string" ? { prefix: value.prefix } : {}),
				...(typeof value?.suffix === "string" ? { suffix: value.suffix } : {}),
			},
		});
	}
	return rules.length > 0 ? rules : undefined;
}

/**
 * Parse `runtimePolicy.workstationEgress` into the TediConfig egress field.
 * Returns null when no policy fields are present so the launcher applies its
 * deny-all default.
 */
function parseWorkstationEgress(raw: unknown): TediConfig["workstationEgress"] {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as {
		allowedHosts?: unknown;
		deniedHosts?: unknown;
		injectHeaders?: unknown;
		artifactsRepository?: unknown;
		loggingMode?: unknown;
	};
	const allowedHosts = parseHostList(source.allowedHosts);
	const deniedHosts = parseHostList(source.deniedHosts);
	const injectHeaders = parseHeaderInjectionRules(source.injectHeaders);
	const artifactsRepository = (() => {
		const value = source.artifactsRepository;
		if (!value || typeof value !== "object") return undefined;
		const { host, path } = value as Record<string, unknown>;
		return typeof host === "string" &&
			/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(host) &&
			typeof path === "string" &&
			/^\/git\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.git$/.test(path)
			? { host, path }
			: undefined;
	})();
	const loggingMode = parseWorkstationEgressLoggingMode(source.loggingMode);
	if (
		!allowedHosts &&
		!deniedHosts &&
		!injectHeaders &&
		!artifactsRepository &&
		!loggingMode
	) {
		return null;
	}
	return {
		...(allowedHosts ? { allowedHosts } : {}),
		...(deniedHosts ? { deniedHosts } : {}),
		...(injectHeaders ? { injectHeaders } : {}),
		...(artifactsRepository ? { artifactsRepository } : {}),
		...(loggingMode ? { loggingMode } : {}),
	};
}

/**
 * Convert a DB Tedi row + decrypted secrets into the runtime TediConfig
 */
async function tediToConfig(
	tedi: Tedi,
	secrets: Record<string, string>,
	configOptions: {
		apiUrl?: string;
		descopeProjectId?: string;
		descopeBaseUrl?: string;
		platformDomain?: string;
	} = {},
	controlPlane?: {
		runtimeProfileConfig?: RuntimeProfileConfig | null;
		policyPackDefinition?: PolicyPackDefinition | null;
		workspaceTemplateSetDefinition?: WorkspaceTemplateSetDefinition | null;
	},
): Promise<TediConfig> {
	// Also extract channel tokens from the channels JSON column as fallbacks
	let channels: NonNullable<Tedi["channels"]> | null = null;
	if (typeof tedi.channels === "string") {
		try {
			channels = JSON.parse(tedi.channels) as NonNullable<Tedi["channels"]>;
		} catch {
			channels = {} as NonNullable<Tedi["channels"]>;
		}
	} else {
		channels = tedi.channels;
	}

	// Channel tokens: prefer tedi_secrets, fall back to channels config
	if (!secrets.TELEGRAM_BOT_TOKEN && channels?.telegram?.botToken) {
		secrets.TELEGRAM_BOT_TOKEN = channels.telegram.botToken;
	}

	const platformDomain = configOptions.platformDomain;
	const runtimeBaseUrl = platformDomain
		? buildRuntimeBaseUrl(tedi.slug, platformDomain)
		: undefined;
	const osBaseUrl = platformDomain ? buildOsBaseUrl(platformDomain) : undefined;
	const mcpBaseUrl = platformDomain
		? buildMcpBaseUrl(platformDomain)
		: undefined;

	// Runtime sleep policy from runtime profile JSON. Path:
	// runtime_profiles.config.runtimePolicy.alwaysOn (boolean, optional).
	// Undefined falls through to the channel-token heuristic in index.ts.
	const runtimePolicy =
		controlPlane?.runtimeProfileConfig &&
		typeof controlPlane.runtimeProfileConfig === "object" &&
		"runtimePolicy" in controlPlane.runtimeProfileConfig &&
		typeof (controlPlane.runtimeProfileConfig as { runtimePolicy?: unknown })
			.runtimePolicy === "object"
			? ((
					controlPlane.runtimeProfileConfig as {
						runtimePolicy?: Record<string, unknown>;
					}
				).runtimePolicy ?? null)
			: null;
	const alwaysOn =
		runtimePolicy && typeof runtimePolicy.alwaysOn === "boolean"
			? runtimePolicy.alwaysOn
			: undefined;

	// Per-workstation egress allow/deny lists, config-driven from
	// runtime_profiles.config.runtimePolicy.workstationEgress. Applied to the
	// Cloudflare Sandbox body in index.ts. Absent → deny-all default (resolved
	// in runtime/workstation-egress.ts).
	const workstationEgress = parseWorkstationEgress(
		runtimePolicy?.workstationEgress,
	);

	return {
		id: tedi.id,
		slug: tedi.slug,
		displayName: tedi.displayName || tedi.name,
		r2BucketName: tedi.r2BucketName ?? null,
		organizationId: tedi.organizationId || null,
		organizationDescopeTenantId: null,
		ownerUserId: tedi.ownerUserId ?? null,
		platformDomain,
		apiBaseUrl: configOptions.apiUrl,
		runtimeBaseUrl,
		osBaseUrl,
		mcpBaseUrl,
		descopeProjectId: configOptions.descopeProjectId,
		descopeBaseUrl: configOptions.descopeBaseUrl,
		descopeMcpResourceId: tedi.descopeMcpResourceId ?? null,
		secrets,
		alwaysOn,
		runtimeProfileConfig: controlPlane?.runtimeProfileConfig ?? null,
		policyPackDefinition: controlPlane?.policyPackDefinition ?? null,
		workspaceTemplateSetDefinition:
			controlPlane?.workspaceTemplateSetDefinition ?? null,
		repoConfig: parseRepoConfig(tedi.repoConfig),
		runtimeKind: tedi.runtimeKind ?? "agent",
		isolateAgentId: tedi.isolateAgentId ?? null,
		workstationEgress,
	};
}

/**
 * Resolve a tedi from the incoming request hostname.
 * Supports custom domains and subdomain routing via lookupTediByHostname.
 * Decrypts secrets from tedi_secrets table for runtime materialization.
 */
export async function resolveTedi(
	d1: D1Database,
	hostname: string,
	environment: string,
	masterKey?: string,
	descope?: { projectId?: string; baseUrl?: string },
	apiUrl?: string,
	platformEnv?: {
		OPENAI_API_KEY?: string;
		AZURE_OPENAI_RESOURCE?: string;
		AZURE_OPENAI_BASE_URL?: string;
		GEMINI_API_KEY?: string;
		GOOGLE_API_KEY?: string;
		AZURE_OPENAI_TTS_DEPLOYMENT?: string;
		AZURE_OPENAI_TTS_VOICE?: string;
		AZURE_OPENAI_STT_DEPLOYMENT?: string;
		AZURE_OPENAI_STT_API_VERSION?: string;
		AZURE_OPENAI_REALTIME_DEPLOYMENT?: string;
		AZURE_OPENAI_REALTIME_API_VERSION?: string;
		GRADIUM_API_KEY?: string;
		KUGEL_API_KEY?: string;
		TWILIO_ACCOUNT_SID?: string;
		TWILIO_AUTH_TOKEN?: string;
	},
): Promise<TediConfig | null> {
	const db = createDbClient(d1);
	const platformDomain = getPlatformDomain(environment);

	const tedi = await lookupTediByHostname(db, hostname, platformDomain);
	if (!tedi) return null;
	if (!isRoutableTediStatus(tedi.status)) {
		resolveCache.delete(hostname);
		return null;
	}

	const cached = resolveCache.get(hostname);
	const revision = JSON.stringify([
		tedi.id,
		tedi.updatedAt,
		tedi.runtimeProfileId,
		tedi.policyPackId,
		tedi.workspaceTemplateSetId,
	]);
	if (cached?.revision === revision) return cached.config;
	if (cached) resolveCache.delete(hostname);

	// Decrypt secrets if master key is available
	const tediSecrets = masterKey
		? await decryptSecrets(db, tedi.id, masterKey)
		: {};
	const secrets = mergeWithPlatformDefaults(platformEnv ?? {}, tediSecrets);

	// Control-plane FKs should be set in D1; resolve still falls back to the
	// published system defaults so cron/workspace generation cannot silently
	// no-op on older rows. The fallback reads the head revision of the
	// `system-default` slug rather than a compiled-in id, so publishing a new
	// revision moves it.
	const [
		runtimeProfile,
		policyPack,
		workspaceTemplateSet,
		organization,
		topPlatformFacts,
		muscleMemoryEntries,
	] = await Promise.all([
		(tedi.runtimeProfileId
			? getRuntimeProfileById(db, tedi.runtimeProfileId)
			: getSystemDefaultRuntimeProfile(db)
		).catch((err) => {
			warnOptionalResolutionFailure("resolve.runtime_profile_load_failed", err);
			return null;
		}),
		(tedi.policyPackId
			? getPolicyPackById(db, tedi.policyPackId)
			: getSystemDefaultPolicyPack(db)
		).catch((err) => {
			warnOptionalResolutionFailure("resolve.policy_pack_load_failed", err);
			return null;
		}),
		(tedi.workspaceTemplateSetId
			? getWorkspaceTemplateSetById(db, tedi.workspaceTemplateSetId)
			: getSystemDefaultWorkspaceTemplateSet(db)
		).catch((err) => {
			warnOptionalResolutionFailure(
				"resolve.workspace_template_set_load_failed",
				err,
			);
			return null;
		}),
		tedi.organizationId
			? getOrganizationById(db, tedi.organizationId).catch((err) => {
					warnOptionalResolutionFailure(
						"resolve.organization_load_failed",
						err,
					);
					return null;
				})
			: Promise.resolve(null),
		tedi.organizationId
			? getTopPlatformFacts(db, tedi.organizationId, {
					tediId: tedi.id,
					limit: 30,
				}).catch((err) => {
					warnOptionalResolutionFailure(
						"resolve.platform_knowledge_load_failed",
						err,
					);
					return [];
				})
			: Promise.resolve([]),
		tedi.organizationId
			? listMuscleMemory(db, tedi.organizationId, tedi.id, {
					limit: 30,
				}).catch((err) => {
					warnOptionalResolutionFailure(
						"resolve.muscle_memory_load_failed",
						err,
					);
					return [];
				})
			: Promise.resolve([]),
	]);

	const controlPlane = {
		runtimeProfileConfig: runtimeProfile?.config ?? null,
		policyPackDefinition: policyPack?.definition ?? null,
		workspaceTemplateSetDefinition: workspaceTemplateSet?.templates ?? null,
	};

	const config = await tediToConfig(
		tedi,
		secrets,
		{
			apiUrl: apiUrl || buildApiBaseUrl(platformDomain),
			descopeProjectId: descope?.projectId,
			descopeBaseUrl: descope?.baseUrl,
			platformDomain,
		},
		controlPlane,
	);

	config.environment = environment;

	config.organizationDescopeTenantId = organization?.descopeTenantId ?? null;

	if (topPlatformFacts.length > 0) {
		config.platformKnowledge =
			formatPlatformFactsAsMarkdown(topPlatformFacts) ?? undefined;
	}

	// listMuscleMemory applies the evidence gate. Executable entries need the
	// additional governance invariant that their runtime provider allowlist is
	// explicit; legacy null-allowlist rows remain visible administratively but
	// are never injected into a tedi's active procedural memory.
	const activeMuscle = muscleMemoryEntries.filter(
		(entry) =>
			!entry.codeModule ||
			(Array.isArray(entry.allowedNamespaces) &&
				entry.allowedNamespaces.length > 0),
	);
	if (activeMuscle.length > 0) {
		config.muscleMemory = formatMuscleMemoryAsMarkdown(activeMuscle);
	}

	// Refuse to cache configs with broken control-plane fetches. A null
	// policyPackDefinition when policyPackId is set indicates a transient
	// fetch failure (not absence of a configured pack) — caching would lock
	// in the broken config for 5 minutes and silently disable cron bootstrap,
	// directive injection, and other policy-driven behavior.
	const hasBrokenPolicyPack =
		tedi.policyPackId && controlPlane.policyPackDefinition === null;
	const hasBrokenRuntimeProfile =
		tedi.runtimeProfileId && controlPlane.runtimeProfileConfig === null;
	const hasBrokenWorkspaceTemplates =
		tedi.workspaceTemplateSetId &&
		controlPlane.workspaceTemplateSetDefinition === null;
	if (
		hasBrokenPolicyPack ||
		hasBrokenRuntimeProfile ||
		hasBrokenWorkspaceTemplates
	) {
		console.warn(
			`[resolve] skipping cache for ${tedi.id} (${hostname}) — control-plane fetch returned null:`,
			{
				policyPackBroken: !!hasBrokenPolicyPack,
				runtimeProfileBroken: !!hasBrokenRuntimeProfile,
				workspaceTemplatesBroken: !!hasBrokenWorkspaceTemplates,
			},
		);
		return config;
	}

	resolveCache.set(hostname, { config, revision });
	return config;
}

/**
 * Format muscle memory entries as markdown for runtime prompt hydration.
 */
function formatMuscleMemoryAsMarkdown(
	entries: Array<{
		name: string;
		kind: string;
		description: string | null;
		usageCount: number;
		successCount: number;
		failureCount: number;
		origin: string;
		sourceSkillId: string | null;
		lastUsedAt: string | null;
	}>,
): string {
	const lines = [
		"# Muscle Memory — Instant Recall Patterns",
		"",
		"> These are your crystallized action patterns — proven procedures with high success rates.",
		"> Use them directly without looking up the full skill. Track usage with `track_muscle_usage`.",
		"",
	];
	for (const entry of entries) {
		const successRate =
			entry.usageCount > 0
				? Math.round(
						(entry.successCount / (entry.successCount + entry.failureCount)) *
							100,
					)
				: 0;
		lines.push(`## ${entry.name} (${entry.kind})`);
		if (entry.description) {
			lines.push(entry.description);
		}
		lines.push(
			`- **Usage:** ${entry.usageCount} times, ${successRate}% success`,
		);
		lines.push(
			`- **Origin:** ${entry.origin}${entry.sourceSkillId ? ` (skill: ${entry.sourceSkillId})` : ""}`,
		);
		if (entry.lastUsedAt) {
			lines.push(`- **Last used:** ${entry.lastUsedAt}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

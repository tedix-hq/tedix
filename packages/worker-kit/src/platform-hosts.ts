/**
 * Tedix's own hostnames come from Worker vars so a self-hosted installation can
 * use its own domains. Every setting falls back to the hostname Tedix Cloud
 * uses today, so leaving a var unset keeps the current behaviour.
 */

/** Production and local-tunnel domains Tedix Cloud serves today. */
export const DEFAULT_PLATFORM_DOMAINS: readonly string[] = [
	"tedix.dev",
	"tedix.tech",
];

function normalizeHost(value: string): string {
	return value.trim().toLowerCase().replace(/^\.+/, "");
}

/** Vars that name the installation's own domain; unset keeps Tedix Cloud's. */
export interface PlatformDomainEnv {
	ENVIRONMENT?: string;
	PLATFORM_DOMAIN?: string;
}

/**
 * `PLATFORM_DOMAIN`, or the domain Tedix Cloud serves this lane on today:
 * `tedix.dev` in production, `tedix.tech` everywhere else.
 */
export function platformDomain(env: PlatformDomainEnv): string {
	return hostSetting(
		env.PLATFORM_DOMAIN,
		env.ENVIRONMENT === "production" ? "tedix.dev" : "tedix.tech",
	);
}

/** One hostname var, or `fallback` when the var is unset or blank. */
export function hostSetting(
	value: string | undefined,
	fallback: string,
): string {
	const host = value ? normalizeHost(value) : "";
	return host || fallback;
}

/**
 * `PLATFORM_DOMAINS` as a list (comma-separated, e.g. "example.com,example.dev"),
 * or Tedix's own domains when the var is unset or lists nothing.
 */
export function platformDomains(env: { PLATFORM_DOMAINS?: string }): string[] {
	const domains = (env.PLATFORM_DOMAINS ?? "")
		.split(",")
		.map(normalizeHost)
		.filter(Boolean);
	return domains.length > 0
		? [...new Set(domains)]
		: [...DEFAULT_PLATFORM_DOMAINS];
}

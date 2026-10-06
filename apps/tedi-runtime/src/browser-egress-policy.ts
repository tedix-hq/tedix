import type { BrowserHostnamePolicy } from "@tedix/api-contract/schemas/tedi";

export type BrowserEgressDecision =
	| { decision: "allow"; hostname: string }
	| {
			decision: "deny";
			hostname: string | null;
			reason:
				| "hostname_denied"
				| "hostname_not_allowed"
				| "invalid_url"
				| "uninspectable_cdp"
				| "uninspectable_html";
	  };

function matchesHostname(pattern: string, hostname: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(2);
		return hostname.length > suffix.length && hostname.endsWith(`.${suffix}`);
	}
	return pattern === hostname;
}

export function hasBrowserHostnameRestrictions(
	policies: readonly (BrowserHostnamePolicy | undefined)[],
): boolean {
	return policies.some(
		(policy) =>
			Boolean(policy?.allowedHostnames.length) ||
			Boolean(policy?.deniedHostnames.length),
	);
}

export function browserEgressDecision(
	rawUrl: string,
	policies: readonly (BrowserHostnamePolicy | undefined)[],
): BrowserEgressDecision {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { decision: "deny", hostname: null, reason: "invalid_url" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { decision: "deny", hostname: null, reason: "invalid_url" };
	}
	const hostname = url.hostname.toLowerCase();
	for (const policy of policies) {
		if (!policy) continue;
		if (
			policy.deniedHostnames.some((pattern) =>
				matchesHostname(pattern, hostname),
			)
		) {
			return { decision: "deny", hostname, reason: "hostname_denied" };
		}
		if (
			policy.allowedHostnames.length > 0 &&
			!policy.allowedHostnames.some((pattern) =>
				matchesHostname(pattern, hostname),
			)
		) {
			return { decision: "deny", hostname, reason: "hostname_not_allowed" };
		}
	}
	return { decision: "allow", hostname };
}

export function browserToolEgressDecision(
	toolName: string,
	input: unknown,
	policies: readonly (BrowserHostnamePolicy | undefined)[],
): BrowserEgressDecision | null {
	if (!hasBrowserHostnameRestrictions(policies)) return null;
	if (toolName === "browser_execute") {
		return { decision: "deny", hostname: null, reason: "uninspectable_cdp" };
	}
	const record =
		typeof input === "object" && input !== null
			? (input as Record<string, unknown>)
			: {};
	if (typeof record.url === "string") {
		return browserEgressDecision(record.url, policies);
	}
	return { decision: "deny", hostname: null, reason: "uninspectable_html" };
}

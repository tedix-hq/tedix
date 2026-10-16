import {
	browserAllowedHostnames,
	type BrowserHostnamePolicy,
} from "@tedix/api-contract/schemas/tedi";

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
			Boolean(browserAllowedHostnames(policy).length) ||
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
		const allowedHostnames = browserAllowedHostnames(policy);
		if (
			allowedHostnames.length > 0 &&
			!allowedHostnames.some((pattern) => matchesHostname(pattern, hostname))
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

/** True when every hostname `pattern` matches is matched by an entry of `list`. */
function patternCoveredBy(pattern: string, list: readonly string[]): boolean {
	if (list.includes("*")) return true;
	if (pattern === "*") return false;
	if (!pattern.startsWith("*.")) {
		return list.some((entry) => matchesHostname(entry, pattern));
	}
	const suffix = pattern.slice(2);
	return list.some(
		(entry) =>
			entry === pattern ||
			(entry.startsWith("*.") && matchesHostname(entry, suffix)),
	);
}

/** True when some hostname matches both patterns. */
function patternsOverlap(a: string, b: string): boolean {
	if (a === "*" || b === "*" || a === b) return true;
	const aWild = a.startsWith("*.");
	const bWild = b.startsWith("*.");
	if (aWild && bWild)
		return patternCoveredBy(a, [b]) || patternCoveredBy(b, [a]);
	if (aWild) return matchesHostname(a, b);
	if (bWild) return matchesHostname(b, a);
	return false;
}

/**
 * How the hostname policies apply to a persistent browser, whose CDP code
 * cannot be inspected per call. Browser Run guardrails enforce an allowlist
 * on every request the browser makes, between tool calls and after a
 * restart, but cannot express a denylist. A policy is therefore enforceable
 * when its allowlists intersect to a non-empty set and every denied pattern
 * already falls outside that set.
 */
export type PersistentBrowserEgress =
	| { enforceable: true; allowedDomains?: string[] }
	| {
			enforceable: false;
			reason: "hostname_not_allowed" | "uninspectable_cdp";
	  };

export function persistentBrowserEgress(
	policies: readonly (BrowserHostnamePolicy | undefined)[],
): PersistentBrowserEgress {
	let allowed: string[] | undefined;
	for (const policy of policies) {
		const list = browserAllowedHostnames(policy);
		if (list.length === 0) continue;
		const current = allowed;
		allowed = current
			? [
					...new Set([
						...current.filter((pattern) => patternCoveredBy(pattern, list)),
						...list.filter((pattern) => patternCoveredBy(pattern, current)),
					]),
				]
			: [...new Set(list)];
	}
	if (allowed?.includes("*")) allowed = undefined;
	if (allowed?.length === 0) {
		return { enforceable: false, reason: "hostname_not_allowed" };
	}
	const denied = policies.flatMap((policy) => policy?.deniedHostnames ?? []);
	const effective = allowed;
	if (
		denied.some(
			(pattern) =>
				!effective ||
				effective.some((entry) => patternsOverlap(entry, pattern)),
		)
	) {
		return { enforceable: false, reason: "uninspectable_cdp" };
	}
	return effective
		? { enforceable: true, allowedDomains: effective.sort() }
		: { enforceable: true };
}

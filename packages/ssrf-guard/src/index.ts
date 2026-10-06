/**
 * Shared SSRF protection utilities.
 *
 * Validates URLs to prevent Server-Side Request Forgery attacks by blocking
 * requests to private networks, loopback addresses, link-local ranges,
 * and internal Tedix services.
 *
 * This is the single source of truth for host/IP validation across the
 * platform. It is imported directly by both the MCP edge (outbound URL
 * validation for external tool calls and OAuth redirects) and the workstation
 * sandbox runtime (default-deny egress interception). Keep it pure: no
 * Workers/DOM/Node globals beyond `URL` (plus the WinterCG `fetch`/`Response`
 * surface used only inside `guardedFetch`), so it stays testable in a plain
 * `node` Vitest environment and bundles cleanly into every Worker.
 *
 * NOT THE BOUNDARY. This runs BEFORE DNS, on the hostname and literal as
 * written, so it cannot see a public name that resolves — or rebinds — to a
 * private address. Its job is a legible, attributable refusal at connect time:
 * a caller learns immediately that `169.254.169.254` is off limits, and the
 * audit log records the attempt. The actual boundary is the platform's
 * `global_fetch_strictly_public` compatibility flag, which every Worker that
 * fetches a caller- or model-chosen URL must carry (enforced for importers of
 * this package by `scripts/lint-wrangler.ts`). Do not let a passing check here
 * be read as proof that a request was safe to make.
 */

/** Blocked internal service hostnames.
 *
 * tedi.club stays after the staging lane was retired: Tedix still owns the
 * zone and it still has proxied wildcard DNS (*.mcp, *.cms, *.tedi), so it
 * remains a reachable internal-looking target. Dropping it here would WIDEN
 * what a fetch can reach, which is the opposite of a cleanup.
 */
const BLOCKED_TEDIX_HOSTS = new Set([
	"api.tedix.dev",
	"api.tedi.club",
	"api.tedix.tech",
	"mcp.tedix.dev",
	"mcp.tedi.club",
	"mcp.tedix.tech",
]);

/** Blocked tedix-owned domain suffixes (the apex is blocked too). */
const BLOCKED_TEDIX_DOMAIN_SUFFIXES = [
	".tedix.dev",
	".tedi.club",
	".tedix.tech",
];

/**
 * Blocked local-resolution hostnames and suffixes. These never name a
 * tedix-owned service: they resolve on the caller's own host or network
 * (mDNS, cloud metadata such as `metadata.google.internal`, loopback names).
 */
const BLOCKED_LOCAL_HOSTS = new Set(["localhost"]);
const BLOCKED_LOCAL_DOMAIN_SUFFIXES = [".local", ".localhost", ".internal"];

/**
 * IPv4 regex patterns for private/reserved ranges:
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 * - 127.0.0.0/8 (loopback)
 * - 169.254.0.0/16 (link-local)
 * - 100.64.0.0/10 (carrier-grade NAT / CGNAT)
 * - 192.0.2.0/24 (TEST-NET-1)
 * - 198.18.0.0/15 (benchmarking, RFC 2544)
 * - 224.0.0.0/4 (multicast)
 * - 0.0.0.0
 */
const PRIVATE_IPV4_RE =
	/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.2\.|198\.1[89]\.|127\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|(22[4-9]|23\d)\.|0\.0\.0\.0$)/;

/**
 * Parse one IPv4 host part the way `inet_aton` does: hex (`0x7f`),
 * octal (`0177`), or decimal (`127`). Returns null for non-numeric parts.
 */
function parseIPv4Part(part: string): number | null {
	if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part.slice(2), 16);
	if (/^0[0-7]*$/.test(part)) return part === "0" ? 0 : parseInt(part, 8);
	if (/^[1-9]\d*$/.test(part)) return parseInt(part, 10);
	return null;
}

/**
 * Normalize any `inet_aton`-style numeric IPv4 host to canonical dotted
 * decimal, or null when the hostname is not a numeric IPv4 form. Handles
 * dotted hex (`0x7f.0.0.1`), dotted octal (`0177.0.0.1`), packed decimal
 * (`2130706433`), packed hex (`0x7f000001`), and the 2/3-part shorthand
 * forms (`127.1`, `127.0.1`) — every form the socket layer would happily
 * connect to a private address.
 *
 * Defense in depth: the WHATWG URL parser already canonicalizes most of these
 * for special schemes, so this catches raw hostnames that never went through
 * `new URL()` normalization plus any parser that leaves them alone.
 */
function normalizeIPv4Host(hostname: string): string | null {
	const parts = hostname.split(".");
	if (parts.length === 0 || parts.length > 4) return null;
	if (parts.some((part) => part.length === 0)) return null;
	const values: number[] = [];
	for (const part of parts) {
		const value = parseIPv4Part(part);
		if (value === null || Number.isNaN(value)) return null;
		values.push(value);
	}
	const last = values[values.length - 1];
	if (last === undefined) return null;
	const prefix = values.slice(0, -1);
	if (prefix.some((value) => value > 0xff)) return null;
	const lastByteCount = 4 - prefix.length;
	if (last >= 2 ** (8 * lastByteCount)) return null;
	let total = 0;
	for (const value of prefix) total = total * 256 + value;
	total = total * 2 ** (8 * lastByteCount) + last;
	const a = Math.floor(total / 2 ** 24) % 256;
	const b = Math.floor(total / 2 ** 16) % 256;
	const c = Math.floor(total / 2 ** 8) % 256;
	const d = total % 256;
	return `${a}.${b}.${c}.${d}`;
}

/**
 * Parse an IPv6 address (without brackets) into its eight 16-bit groups.
 * Handles `::` compression, embedded dotted IPv4 tails, and zone indexes.
 * Returns null when the address does not parse as IPv6.
 */
function parseIPv6Groups(address: string): number[] | null {
	const zoneIndex = address.indexOf("%");
	const bare = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
	if (bare.length === 0) return null;

	const compressionIndex = bare.indexOf("::");
	if (
		compressionIndex !== -1 &&
		bare.indexOf("::", compressionIndex + 1) !== -1
	) {
		return null; // more than one "::"
	}

	const expandParts = (raw: string): number[] | null => {
		if (raw.length === 0) return [];
		const parts = raw.split(":");
		const groups: number[] = [];
		for (let i = 0; i < parts.length; i += 1) {
			const part = parts[i];
			if (part === undefined || part.length === 0) return null;
			if (part.includes(".")) {
				// Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) — must be last.
				if (i !== parts.length - 1) return null;
				const dotted = normalizeIPv4Host(part);
				if (!dotted) return null;
				const bytes = dotted.split(".").map(Number);
				const [b0, b1, b2, b3] = bytes;
				if (
					b0 === undefined ||
					b1 === undefined ||
					b2 === undefined ||
					b3 === undefined
				) {
					return null;
				}
				groups.push(b0 * 256 + b1, b2 * 256 + b3);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
			groups.push(parseInt(part, 16));
		}
		return groups;
	};

	if (compressionIndex === -1) {
		const groups = expandParts(bare);
		return groups && groups.length === 8 ? groups : null;
	}

	const headGroups = expandParts(bare.slice(0, compressionIndex));
	const tailGroups = expandParts(bare.slice(compressionIndex + 2));
	if (!headGroups || !tailGroups) return null;
	const missing = 8 - headGroups.length - tailGroups.length;
	if (missing < 1) return null; // "::" must stand for at least one group
	return [
		...headGroups,
		...Array.from({ length: missing }, () => 0),
		...tailGroups,
	];
}

/**
 * Detect private/reserved IPv6 addresses.
 * Handles bracket-wrapped addresses like [::1], and normalizes every textual
 * form first (so `[0:0:0:0:0:0:0:0001]`, `[0::1]`, and friends all count as
 * loopback). A bracketed host that fails to parse as IPv6 is treated as
 * private (fail closed) — no legitimate URL produces one.
 */
function isPrivateIPv6(hostname: string): boolean {
	// Strip brackets if present
	const addr =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;

	// Must look like IPv6
	if (!addr.includes(":")) return false;

	const groups = parseIPv6Groups(addr.toLowerCase());
	if (!groups) return true; // declared IPv6 but unparseable — refuse

	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
	if (
		g0 === undefined ||
		g1 === undefined ||
		g2 === undefined ||
		g3 === undefined ||
		g4 === undefined ||
		g5 === undefined ||
		g6 === undefined ||
		g7 === undefined
	) {
		return true;
	}

	const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

	// :: (unspecified) and ::1 (loopback) — any textual form
	if (leadingZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
		return true;
	}

	// fc00::/7 (unique local)
	if ((g0 & 0xfe00) === 0xfc00) return true;

	// fe80::/10 (link-local)
	if ((g0 & 0xffc0) === 0xfe80) return true;

	// IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
	// forms — check the embedded IPv4 against the private ranges.
	if (leadingZero && (g5 === 0xffff || g5 === 0)) {
		const dotted = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
		if (PRIVATE_IPV4_RE.test(dotted)) return true;
	}

	return false;
}

export interface ValidateUrlOptions {
	/** Allow http:// (not just https://). Typically true only in dev. */
	allowHttp?: boolean;
	/**
	 * Allow tedix-owned/internal hostnames (api.*, mcp.*, *.tedix.tech,
	 * *.tedix.dev, etc.). DEV-ONLY escape hatch so external tools can reach our
	 * own tunneled development services, plus the deliberate lane for platform code that
	 * fetches its OWN managed `*.mcp.tedix.dev`-style origins from config.
	 * Private/loopback/link-local IPs stay blocked regardless. MUST never be
	 * set for a URL an external party chose in production.
	 */
	allowInternalHosts?: boolean;
	/**
	 * Allow tedix-owned hostnames ONLY (api.*, mcp.*, `*.tedix.dev`,
	 * `*.tedix.tech`, `*.tedi.club` and their apexes) while keeping every
	 * local-resolution name blocked: `localhost`, `*.localhost`, `*.local`,
	 * `*.internal` (cloud metadata) — plus, as always, every private/loopback/
	 * link-local IP literal. This is the lane for platform code whose caller
	 * may legitimately name a Tedix-served origin (a tenant's own
	 * `{slug}.mcp.tedix.dev` MCP endpoint, a `{slug}.cms.tedix.dev` site to
	 * render) but must never reach the Worker's own host or network. A subset
	 * of `allowInternalHosts`, which also unblocks the local names.
	 */
	allowTedixHosts?: boolean;
}

/**
 * Validate a URL for SSRF safety. Returns an error string if blocked, null if OK.
 */
export function validateUrl(
	rawUrl: string,
	options: ValidateUrlOptions = {},
): string | null {
	try {
		const url = new URL(rawUrl);

		// Protocol check
		if (!options.allowHttp && url.protocol !== "https:") {
			return "URL must use HTTPS";
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return "URL must use HTTP(S)";
		}

		const hostname = url.hostname.toLowerCase();

		// Internal tedix hosts — blocked in prod; allowed in dev (allowInternalHosts)
		// so external tools can reach our own tunnel'd dev services. Private/
		// loopback IP checks below always run regardless of this flag.
		if (!options.allowInternalHosts) {
			// Exact blocked hosts
			if (
				BLOCKED_LOCAL_HOSTS.has(hostname) ||
				(!options.allowTedixHosts && BLOCKED_TEDIX_HOSTS.has(hostname))
			) {
				return "Blocked host";
			}

			// Blocked domain suffixes
			const suffixes = options.allowTedixHosts
				? BLOCKED_LOCAL_DOMAIN_SUFFIXES
				: [...BLOCKED_TEDIX_DOMAIN_SUFFIXES, ...BLOCKED_LOCAL_DOMAIN_SUFFIXES];
			for (const suffix of suffixes) {
				if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) {
					return "Cannot connect to internal services";
				}
			}
		}

		// Private IPv4 — canonical dotted decimal
		if (PRIVATE_IPV4_RE.test(hostname)) {
			return "Cannot connect to private networks";
		}

		// Numeric IP forms (packed decimal/hex, dotted hex/octal, shorthand) —
		// resolve to dotted-decimal and re-check.
		const normalized = normalizeIPv4Host(hostname);
		if (normalized && PRIVATE_IPV4_RE.test(normalized)) {
			return "Cannot connect to private networks";
		}

		// Private IPv6
		if (isPrivateIPv6(hostname)) {
			return "Cannot connect to private networks";
		}

		return null;
	} catch {
		return "Invalid URL";
	}
}

/**
 * Typed error thrown by `guardedFetch` when the target URL — or any redirect
 * hop it returns — fails `validateUrl`, or when a redirect chain exceeds the
 * hop cap. Carries the offending URL and the validator's reason so callers
 * can log an attributable refusal.
 */
export class SsrfBlockedError extends Error {
	readonly url: string;
	readonly reason: string;

	constructor(url: string, reason: string) {
		super(`SSRF protection blocked ${url}: ${reason}`);
		this.name = "SsrfBlockedError";
		this.url = url;
		this.reason = reason;
	}
}

export interface GuardedFetchOptions extends ValidateUrlOptions {
	/**
	 * Maximum number of redirect hops to follow manually. Default 3. Every hop
	 * is re-validated with `validateUrl` before it is fetched.
	 */
	maxRedirects?: number;
	/**
	 * Fetch implementation. Defaults to the global `fetch`. Injectable so
	 * callers that thread a `fetchFn` (and tests) keep the guard in the loop.
	 */
	fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Request headers that must not follow a redirect to a different origin. */
const CREDENTIAL_HEADER_NAMES = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
]);

/**
 * Portable spelling of `HeadersInit`: derived from `RequestInit` so this file
 * type-checks under every consumer's lib set (DOM, workers-types, node) — not
 * all of them declare the `HeadersInit` global by name.
 */
type GuardedHeadersInit = NonNullable<RequestInit["headers"]>;

/** Structural view of a `Headers` instance; enough to enumerate it. */
interface HeadersLike {
	forEach(callback: (value: string, name: string) => void): void;
}

function headerEntries(headers: GuardedHeadersInit): Array<[string, string]> {
	if (Array.isArray(headers)) {
		return headers.map(([name, value]) => [String(name), String(value)]);
	}
	if (typeof (headers as HeadersLike).forEach === "function") {
		const entries: Array<[string, string]> = [];
		(headers as HeadersLike).forEach((value, name) => {
			entries.push([name, value]);
		});
		return entries;
	}
	return Object.entries(headers as Record<string, string>);
}

function stripCredentialHeaders(
	headers: GuardedHeadersInit | undefined,
): Array<[string, string]> | undefined {
	if (!headers) return undefined;
	return headerEntries(headers).filter(
		([name]) => !CREDENTIAL_HEADER_NAMES.has(name.toLowerCase()),
	);
}

/**
 * SSRF-guarded `fetch`.
 *
 * Validates the URL with `validateUrl`, forces `redirect: "manual"`, and
 * follows redirects itself up to `maxRedirects` hops — re-validating every
 * `Location` target and stripping credential headers (Authorization, Cookie,
 * Proxy-Authorization) whenever a hop crosses origins. Throws
 * `SsrfBlockedError` when the initial URL or any hop fails validation, or when
 * the chain exceeds the cap. A redirect-status response WITHOUT a `Location`
 * header (e.g. 304) is returned as-is.
 *
 * Same caveat as `validateUrl`: this is a pre-DNS check, not the boundary —
 * the Worker must still carry `global_fetch_strictly_public`.
 */
export async function guardedFetch(
	url: string | URL,
	init: RequestInit = {},
	options: GuardedFetchOptions = {},
): Promise<Response> {
	const { maxRedirects = 3, fetchFn, ...validateOptions } = options;
	const doFetch: (u: string, i?: RequestInit) => Promise<Response> =
		fetchFn ?? ((u, i) => fetch(u, i));

	let currentUrl = typeof url === "string" ? url : url.toString();
	let headers: GuardedHeadersInit | undefined = init.headers ?? undefined;
	let method = (init.method ?? "GET").toUpperCase();
	let body = init.body;

	for (let hop = 0; ; hop += 1) {
		const validationError = validateUrl(currentUrl, validateOptions);
		if (validationError) {
			throw new SsrfBlockedError(currentUrl, validationError);
		}

		const response = await doFetch(currentUrl, {
			...init,
			method,
			headers,
			body,
			redirect: "manual",
		});

		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get("Location");
		if (!location) return response; // 304 etc. — no target to follow

		let nextUrl: string;
		try {
			nextUrl = new URL(location, currentUrl).toString();
		} catch {
			throw new SsrfBlockedError(location, "Invalid redirect URL");
		}
		if (hop >= maxRedirects) {
			throw new SsrfBlockedError(
				nextUrl,
				`Redirect limit exceeded (${maxRedirects})`,
			);
		}

		// Discard the unread redirect body so the connection can be reused.
		try {
			await response.body?.cancel();
		} catch {
			/* already consumed or not cancellable */
		}

		// Credentials never follow a cross-origin redirect.
		if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
			headers = stripCredentialHeaders(headers);
		}

		// Per the fetch spec, 303 always switches to GET; historically 301/302
		// do the same for POST. The body never follows the redirect.
		if (
			response.status === 303 ||
			((response.status === 301 || response.status === 302) &&
				method === "POST")
		) {
			method = "GET";
			body = undefined;
		}

		currentUrl = nextUrl;
	}
}

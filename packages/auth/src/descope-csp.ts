/**
 * Content-Security-Policy for pages that embed a Descope flow.
 *
 * Base is Descope's published policy for custom-domain projects
 * (docs.descope.com/security-best-practices/content-security-policy), tightened
 * with a per-request nonce in place of `'unsafe-inline'` for scripts. That swap
 * is the part that buys anything: with `'unsafe-inline'` the policy constrains
 * little beyond which origins may be fetched.
 *
 * Verified against the live project by loading the real `sign-up-or-in` flow
 * under this exact policy: it reaches `ready` with zero violations across 81
 * requests — scripts from descopecdn.com, flow config/theme/markup from the
 * auth host, styles from fonts.googleapis.com, fonts from fonts.gstatic.com.
 */

/** Extra origins a specific surface needs beyond the Descope baseline. */
export interface DescopeCspExtras {
	/** Additional `script-src` origins (e.g. a CDN the page imports from). */
	scriptSrc?: readonly string[];
	/** Additional `connect-src` origins. */
	connectSrc?: readonly string[];
	/**
	 * Replacement `img-src` source list. A surface that renders user- or
	 * tenant-supplied image URLs (avatars from a social IdP, app and connector
	 * logos) cannot enumerate origins, and images are not the vector this policy
	 * exists to close — `script-src` is. Passing `https: data: blob:` here is a
	 * deliberate, documented trade, not an oversight.
	 */
	imgSrc?: readonly string[];
	/**
	 * Send violation reports to a same-origin endpoint. Without this the policy
	 * still blocks, but a violation exists only as a line in whichever browser
	 * console happened to be open — a policy that breaks a screen for real users
	 * looks exactly like one that works.
	 *
	 * Emits BOTH mechanisms because neither covers the field alone:
	 * `report-to` is the current Reporting API (and needs the matching
	 * `Reporting-Endpoints` response header — see `reportingEndpointsHeader`),
	 * while the deprecated `report-uri` is still the only one Safari honours.
	 * Browsers that understand `report-to` ignore `report-uri`, so supporting
	 * both costs one duplicate report on no browser.
	 */
	report?: { group: string; endpointPath: string };
}

/**
 * Cloudflare Web Analytics' Automatic Setup appends this script to every
 * `text/html` response at the zone edge, *after* the Worker returns — so it
 * carries no nonce of ours and must be allowed by origin or every page on the
 * zone reports a violation and loses analytics. The beacon then posts back to
 * `cloudflareinsights.com`.
 */
export const CLOUDFLARE_BEACON_SCRIPT_ORIGIN =
	"https://static.cloudflareinsights.com";
export const CLOUDFLARE_BEACON_CONNECT_ORIGIN =
	"https://cloudflareinsights.com";

function authOriginOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		// Never emit a broken policy because a config value was malformed.
		return "https://auth.tedix.dev";
	}
}

export function createCspNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes));
}

/**
 * Build the policy for a page that mounts a Descope flow.
 *
 * Two directives are deliberately looser than they could be, and should stay
 * that way:
 *
 * - `static.descope.com` and `cdn.jsdelivr.net` remain in `script-src` even
 *   though the first flow screen never requests them. Descope documents them,
 *   and later screens (captcha, other components) can. A screen that dies on a
 *   missing origin is worse than the marginal tightening.
 * - `form-action` is left unset. A SAML POST binding submits cross-origin, so
 *   `'self'` would break SSO for little gain next to `script-src`.
 *
 * `style-src` keeps `'unsafe-inline'`: the Descope web components inject styles
 * at runtime, and nonce-ing styles makes browsers *ignore* `'unsafe-inline'`,
 * which breaks the flow's rendering.
 */
export function descopeFlowContentSecurityPolicy(
	baseUrl: string,
	nonce: string,
	extras: DescopeCspExtras = {},
): string {
	const authOrigin = authOriginOf(baseUrl);
	const script = [
		"'self'",
		`'nonce-${nonce}'`,
		"https://descopecdn.com",
		"https://static.descope.com",
		"https://cdn.jsdelivr.net",
		...(extras.scriptSrc ?? []),
	].join(" ");
	const connect = ["'self'", authOrigin, ...(extras.connectSrc ?? [])].join(
		" ",
	);

	return [
		"default-src 'self'",
		"base-uri 'none'",
		"object-src 'none'",
		`connect-src ${connect}`,
		`script-src ${script}`,
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://descopecdn.com",
		`img-src ${
			extras.imgSrc?.join(" ") ??
			`'self' ${authOrigin} https://static.descope.com https://descopecdn.com data: blob:`
		}`,
		"font-src 'self' https://fonts.gstatic.com https://descopecdn.com data:",
		`frame-src 'self' ${authOrigin} https://descopecdn.com`,
		"worker-src 'self' blob:",
		...(extras.report
			? [
					`report-to ${extras.report.group}`,
					`report-uri ${extras.report.endpointPath}`,
				]
			: []),
	].join("; ");
}

/**
 * Value for the `Reporting-Endpoints` response header that names the group the
 * `report-to` directive points at.
 *
 * The URL is absolute on purpose. The header's grammar is a structured-fields
 * dictionary of strings, and a relative path is not reliably resolved — Chrome
 * drops the endpoint and reporting silently does nothing, which is the exact
 * failure this whole change exists to end.
 */
export function reportingEndpointsHeader(
	group: string,
	endpointUrl: string,
): string {
	return `${group}="${endpointUrl}"`;
}

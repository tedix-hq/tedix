/**
 * Whether a request path names a tedi DO `/__internal/*` route under any
 * spelling. The DO matches those routes by exact pathname, so the caller
 * check decodes percent-escapes, resolves dot segments and collapses repeated
 * slashes before deciding: a caller must not reach a privileged handler
 * through a spelling the exact match would miss on a later rewrite.
 */
export function targetsInternalRoute(url: URL): boolean {
	let pathname = url.pathname;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// Undecodable escapes stay literal; they are compared as written.
	}
	// Resolve `.`/`..` segments the decode may have revealed.
	pathname = new URL(pathname.replace(/\/{2,}/g, "/"), "https://internal")
		.pathname;
	return /^\/__internal(?:\/|$)/i.test(pathname.replace(/\/{2,}/g, "/"));
}

/**
 * Astro Middleware
 *
 * Adds Cache-Control headers to prevent ChatGPT HTML caching, and a
 * REPORT-ONLY Content-Security-Policy on HTML documents (see
 * `contentSecurityPolicyReportOnly` below).
 *
 * CORS is handled by public/_headers for static assets (JS, CSS, fonts).
 * SSR HTML is fetched server-side by MCP, so CORS doesn't apply there.
 *
 * This also deliberately opts every SSR response out of Cloudflare's
 * Workers Cache (the regionally-tiered cache behind the Worker, in front of
 * its entrypoints; see `wrangler.jsonc`'s top-level `cache` field). That
 * feature keys purely on entrypoint + request URL (path+query) + `Vary`
 * header values + `ctx.props` — it does not key on arbitrary request
 * headers. Every SSR route here (`/[app]/r/[layout]`, `/[app]/r/item-detail`,
 * `/[app]/r/preview`, top-level `/preview`) embeds per-request content
 * delivered via `X-Tedix-App-Theme` (org branding) and/or
 * `X-Tedix-Layout-Spec` (tool widget layout) headers set by apps/mcp
 * (see `lib/app-theme.ts`, `lib/widget-spec.ts`) — content that is not part
 * of the cache key. Today that header content happens to be a deterministic
 * function of (app slug, layout id) per apps/mcp's current call sites, but
 * that is an invariant owned by a sibling app, not enforced here, and
 * apps/mcp already plumbs an unused `dynamicLayoutSpec` override path. A
 * URL-keyed cache would serve a stale or wrong org's branding/layout the
 * moment that invariant changes, with no local signal that anything broke.
 * Until org/app identity and layout content are made cache-key-visible
 * (e.g. a purge-tagged split route for branding-only payloads), do not
 * enable Workers Cache for this app — `Cache-Control: no-store` here is the
 * explicit, unambiguous way to keep it disabled regardless of how
 * Cloudflare's cache implementation treats `no-cache`.
 */

import { CSP_REPORT_GROUP, CSP_REPORT_PATH } from "@tedix/auth/csp-report";
import { reportingEndpointsHeader } from "@tedix/auth/descope-csp";
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { applyPrivateSurfaceRobotsPolicy } from "./lib/private-surface-policy";

/**
 * Report-only Content-Security-Policy for widget documents.
 *
 * ## Why report-only, and what "enforcing" would even mean here
 *
 * These headers only reach a browser on a direct navigation to
 * `mcp-ui.{tedix.dev,tedix.tech}`. In the product path they do not:
 * `apps/mcp` fetches this HTML server-side (`fetchWidgetHtmlForApp`), rewrites
 * its relative URLs, and hands the bytes to the host as MCP resource text —
 * ChatGPT and Tedix OS then render that string in a sandbox document of their own
 * with the CSP they choose (`openai/widgetCSP`, `ui.csp`). Our response
 * headers are discarded at that boundary.
 *
 * So this policy governs direct navigation: the preview/design URLs that
 * `preview_widget` and `design_widget_ui` hand out, `/{app}/r/{layout}`
 * opened by an operator, and anything a crawler or a user reaches by URL.
 * The report-only policy measures that direct-navigation surface; embedded
 * product documents use their host-selected CSP.
 * `script-src` is deliberately left strict (`'self'`, no `'unsafe-inline'`) so
 * the reports say something: Astro's island hydration emits inline script, and
 * the report stream is how we learn precisely what has to be nonced or hashed
 * before any of this can be promoted to the enforcing header.
 *
 * On a built Worker (`/{app}/r/{layout}` under `wrangler dev`) there are
 * exactly two inline scripts per island route — Astro's
 * `client:only` directive shim and its `astro-island` custom-element
 * definition — and zero on non-island routes. Both are static and
 * deploy-stable, so this policy costs two reports per page load, not a flood,
 * and the enforcing version is two `'sha256-…'` entries (or Astro's built-in
 * CSP hash generation), not `'unsafe-inline'`.
 *
 * ## `frame-ancestors`
 *
 * Present only as a probe, and only because report-only cannot break anything.
 * The embedding contract is not knowable from inside this repo: no consumer we
 * can see frames this origin by URL (hosts inline the HTML instead), but
 * `openai/widgetDomain` is published to ChatGPT as `env.MCP_UI_URL` — this
 * exact origin — and how OpenAI uses it is their implementation detail. Naming
 * `'none'` here makes the browser report every framing, which is the maximum
 * information available for zero product risk; it is not a proposed enforcing
 * value. Do not copy it to `Content-Security-Policy` on the strength of this
 * comment. Read the reports first: if the answer is "nobody frames us", the
 * enforcing value is `'none'`; if ChatGPT does, it is that origin; if the
 * reports are ambiguous, `frame-ancestors` stays out of the enforcing policy
 * entirely rather than being guessed, because guessing it wrong takes down the
 * main distribution channel.
 */
function contentSecurityPolicyReportOnly(): string {
	const origins = [env.API_URL, env.MCP_URL]
		.map((value) => {
			try {
				return value ? new URL(value).origin : null;
			} catch {
				return null;
			}
		})
		.filter((value): value is string => value !== null);

	return [
		"default-src 'self'",
		"base-uri 'none'",
		"object-src 'none'",
		// Strict on purpose — see the note above. Astro's inline island
		// bootstrap is expected to report; that report is the deliverable.
		"script-src 'self'",
		// Not strict, and should not become strict: tenant branding is injected
		// as an inline <style> at SSR time (AppThemeLayout) and React writes
		// inline style attributes. Nonce-ing styles makes browsers ignore
		// 'unsafe-inline' entirely, which would blank tenant branding for no
		// gain next to script-src.
		"style-src 'self' 'unsafe-inline'",
		// Model- and tenant-supplied product images, thumbnails, and logos have
		// no enumerable origin set. Held to https so the scheme allowlist in
		// `@tedix/widget-ui/safe-url` and this directive agree.
		"img-src 'self' https: data:",
		"font-src 'self' data:",
		`connect-src ${["'self'", ...origins].join(" ")}`,
		"form-action 'none'",
		"frame-src 'none'",
		"worker-src 'self' blob:",
		"frame-ancestors 'none'",
		`report-to ${CSP_REPORT_GROUP}`,
		`report-uri ${CSP_REPORT_PATH}`,
	].join("; ");
}

export const onRequest = defineMiddleware(async (context, next) => {
	const response = await next();

	// Clone headers to add cache control
	const newHeaders = new Headers(response.headers);
	// Widget documents are host resources and operator previews, not public
	// pages. The header survives direct navigation but does not alter the HTML
	// body that apps/mcp fetches and returns as an MCP resource.
	applyPrivateSurfaceRobotsPolicy(newHeaders);

	// Prevent stale HTML caching - ChatGPT must revalidate to get latest bundle
	// hashes. `no-store` is explicit and unambiguous: it also keeps Cloudflare's
	// Workers Cache (behind-the-Worker, opt-in via `Cache-Control`) from ever
	// storing these header-driven, per-org/per-layout SSR responses.
	newHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
	newHeaders.set("Pragma", "no-cache"); // HTTP/1.0 compatibility

	// Documents only. Attaching a policy to the report endpoint's own response
	// or to a static asset buys nothing and, on the report endpoint, invites a
	// loop.
	const isDocument =
		context.request.method === "GET" &&
		(newHeaders.get("Content-Type") ?? "").includes("text/html");

	if (isDocument) {
		// Absolute: the `Reporting-Endpoints` grammar is a structured-fields
		// dictionary of strings and browsers do not reliably resolve a relative
		// path — Chrome drops the endpoint and reports nothing while the header
		// looks correct.
		newHeaders.set(
			"Reporting-Endpoints",
			reportingEndpointsHeader(
				CSP_REPORT_GROUP,
				new URL(CSP_REPORT_PATH, context.request.url).toString(),
			),
		);
		newHeaders.set(
			"Content-Security-Policy-Report-Only",
			contentSecurityPolicyReportOnly(),
		);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
});

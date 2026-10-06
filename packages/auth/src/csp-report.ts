import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * Terminate Content-Security-Policy violation reports.
 *
 * Pairs with `descopeFlowContentSecurityPolicy`'s `report` extra. Each surface
 * mounts this at its OWN origin rather than pointing every surface at one
 * endpoint on `apps/api`: a cross-origin reporting endpoint needs a CORS
 * preflight that the browser's reporting agent issues inconsistently, so a
 * shared handler behind two thin same-origin routes is the shape that actually
 * delivers reports.
 *
 * The endpoint is unauthenticated by construction — the browser sends the
 * report, not the app, so there is no session to present and anyone can POST
 * here. Everything below is written against that: bounded body, bounded report
 * count, bounded strings, and a same-site check on the reporting document.
 */

/**
 * Path each surface mounts the handler at. Shared so the policy's `report-uri`
 * and the route that answers it cannot drift apart.
 *
 * No leading underscore, which would otherwise be the natural name for an
 * internal endpoint: TanStack Router reads a leading `_` in a route filename as
 * a PATHLESS layout route, so `_csp-report.ts` would register no URL at all and
 * the product surface would emit a policy pointing at a 404.
 */
export const CSP_REPORT_PATH = "/csp-report";

/** `report-to` group name, matched by the `Reporting-Endpoints` header. */
export const CSP_REPORT_GROUP = "csp";

/** One violation, normalized across the two wire formats. */
export interface CspViolationRecord {
	/** Page that violated the policy. */
	documentUrl: string;
	/** Resource the policy blocked (or `inline`/`eval`). */
	blockedUrl: string;
	/** Directive actually enforced, e.g. `script-src-elem`. */
	effectiveDirective: string;
	/** `enforce` for a blocking policy, `report` for Report-Only. */
	disposition: string;
	/** Script that triggered it, when the browser reports one. */
	sourceFile: string;
	lineNumber: number;
	columnNumber: number;
	/** First bytes of the offending inline script, when reported. */
	sample: string;
	userAgent: string;
}

/**
 * Where accepted violations go. Kept a callback rather than an Analytics Engine
 * binding so this module stays runtime-neutral and unit-testable, and so a
 * surface without the binding can still log.
 */
export type CspReportSink = (violations: CspViolationRecord[]) => void;

export interface HandleCspReportOptions {
	/**
	 * Reject a body larger than this without reading it all. Reports are small;
	 * anything near this is abuse or a runaway policy.
	 */
	maxBodyBytes?: number;
	/** Drop anything past this many reports in one payload. */
	maxReports?: number;
	/** Truncate every captured string to this length. */
	maxFieldLength?: number;
}

const DEFAULTS = {
	maxBodyBytes: 64 * 1024,
	maxReports: 32,
	maxFieldLength: 512,
} as const;

function str(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value.length > max ? value.slice(0, max) : value;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Reporting API (`application/reports+json`) entry. camelCase keys, wrapped in
 * an envelope carrying `type` and `user_agent`.
 */
function fromReportingApi(
	entry: unknown,
	max: number,
): CspViolationRecord | null {
	if (!isRecord(entry)) return null;
	if (entry.type !== "csp-violation") return null;
	const body = entry.body;
	if (!isRecord(body)) return null;
	return {
		documentUrl: str(body.documentURL ?? entry.url, max),
		blockedUrl: str(body.blockedURL, max),
		effectiveDirective: str(body.effectiveDirective, max),
		disposition: str(body.disposition, max),
		sourceFile: str(body.sourceFile, max),
		lineNumber: num(body.lineNumber),
		columnNumber: num(body.columnNumber),
		sample: str(body.sample, max),
		userAgent: str(entry.user_agent, max),
	};
}

/**
 * Legacy `report-uri` (`application/csp-report`) body. kebab-case keys under a
 * `csp-report` wrapper, and no user-agent — Safari still sends only this.
 */
function fromLegacyReportUri(
	payload: unknown,
	userAgent: string,
	max: number,
): CspViolationRecord | null {
	if (!isRecord(payload)) return null;
	const body = payload["csp-report"];
	if (!isRecord(body)) return null;
	return {
		documentUrl: str(body["document-uri"], max),
		blockedUrl: str(body["blocked-uri"], max),
		// `effective-directive` is the precise one but is not always present;
		// `violated-directive` is the original spec field and always is.
		effectiveDirective: str(
			body["effective-directive"] ?? body["violated-directive"],
			max,
		),
		disposition: str(body.disposition, max),
		sourceFile: str(body["source-file"], max),
		lineNumber: num(body["line-number"]),
		columnNumber: num(body["column-number"]),
		sample: str(body["script-sample"], max),
		userAgent: str(userAgent, max),
	};
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

/**
 * Handle a POST to {@link CSP_REPORT_PATH}.
 *
 * ALWAYS answers 204 once the method is right, including for a body that fails
 * to parse. A non-2xx makes the browser's reporting agent retry with backoff,
 * which turns one malformed report into sustained load for no gain — the only
 * thing an error status buys here is a worse outage.
 */
export async function handleCspReport(
	request: Request,
	sink: CspReportSink,
	options: HandleCspReportOptions = {},
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response(null, { status: 405, headers: { Allow: "POST" } });
	}

	const maxBodyBytes = options.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
	const maxReports = options.maxReports ?? DEFAULTS.maxReports;
	const max = options.maxFieldLength ?? DEFAULTS.maxFieldLength;

	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBodyBytes) {
		return new Response(null, { status: 413 });
	}

	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return new Response(null, { status: 204 });
	}
	// content-length is advisory — a chunked body can exceed it.
	if (raw.length > maxBodyBytes) return new Response(null, { status: 204 });

	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return new Response(null, { status: 204 });
	}

	const userAgent = request.headers.get("user-agent") ?? "";
	const parsed = Array.isArray(payload)
		? payload
				.slice(0, maxReports)
				.map((entry) => fromReportingApi(entry, max))
				.filter((v): v is CspViolationRecord => v !== null)
		: [fromLegacyReportUri(payload, userAgent, max)].filter(
				(v): v is CspViolationRecord => v !== null,
			);

	// Same-site check. The endpoint is same-origin with the pages it serves, so
	// a report about a document on another host is either noise or someone
	// POSTing here directly. Dropped — but counted out loud, because a host
	// mismatch caused by a proxy rewrite would otherwise discard every report
	// while looking exactly like "no violations".
	const selfHost = hostOf(request.url);
	const accepted: CspViolationRecord[] = [];
	const rejectedHosts = new Set<string>();
	for (const violation of parsed) {
		const host = hostOf(violation.documentUrl);
		if (selfHost && host && host !== selfHost) {
			rejectedHosts.add(host);
			continue;
		}
		accepted.push(violation);
	}
	if (rejectedHosts.size > 0) {
		console.warn(
			`[csp-report] dropped ${parsed.length - accepted.length} report(s) from foreign host(s) ${[...rejectedHosts].join(", ")} at ${selfHost}`,
		);
	}

	if (accepted.length > 0) {
		try {
			sink(accepted);
		} catch (error) {
			// A telemetry failure must not turn into a retry storm.
			console.error("[csp-report] sink failed", error);
		}
	}

	return new Response(null, { status: 204 });
}

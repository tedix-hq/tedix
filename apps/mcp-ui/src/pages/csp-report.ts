/**
 * CSP violation reporting endpoint for the widget origin.
 *
 * Same-origin with the documents it collects for, following the doctrine in
 * `packages/auth/src/csp-report.ts`: every surface terminates its own reports
 * because a cross-origin reporting endpoint needs a preflight that browsers'
 * reporting agents issue inconsistently. The handler, its bounds, and its
 * same-site filter are shared with Tedix OS — only the sink label differs.
 *
 * The sink is one bounded console line per violation, which Workers
 * observability ingests. There is deliberately no Analytics Engine dataset
 * behind it: the `CSP_REPORTS` binding wrote `tedix_csp_reports_*` that nothing
 * in the repo ever queried, so the write-only dataset was deleted rather than
 * kept as history nobody reads. The endpoint still accepts and discards every
 * report. `src/middleware.ts` skips non-GET responses, so this POST never gets
 * a policy header of its own.
 */

import { handleCspReport } from "@tedix/auth/csp-report";
import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = ({ request }) =>
	handleCspReport(request, (violations) => {
		for (const violation of violations) {
			console.warn(
				`[csp] ${violation.effectiveDirective} blocked ${violation.blockedUrl} on ${violation.documentUrl}`,
			);
		}
	});

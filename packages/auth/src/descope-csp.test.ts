import { describe, expect, it } from "vite-plus/test";

import { CSP_REPORT_GROUP, CSP_REPORT_PATH } from "./csp-report.ts";
import {
	CLOUDFLARE_BEACON_CONNECT_ORIGIN,
	CLOUDFLARE_BEACON_SCRIPT_ORIGIN,
	createCspNonce,
	descopeFlowContentSecurityPolicy,
	reportingEndpointsHeader,
} from "./descope-csp.ts";

function directives(policy: string): Record<string, string> {
	return Object.fromEntries(
		policy.split("; ").map((part) => {
			const [name, ...rest] = part.split(" ");
			return [name, rest.join(" ")];
		}),
	);
}

describe("descopeFlowContentSecurityPolicy", () => {
	it("carries the nonce instead of 'unsafe-inline' for scripts", () => {
		const d = directives(
			descopeFlowContentSecurityPolicy("https://auth.tedix.dev", "N0NCE"),
		);
		expect(d["script-src"]).toContain("'nonce-N0NCE'");
		// The whole point of the nonce — 'unsafe-inline' would defeat it.
		expect(d["script-src"]).not.toContain("'unsafe-inline'");
	});

	it("keeps 'unsafe-inline' for styles and no nonce there", () => {
		// The Descope components inject styles at runtime; a style nonce makes
		// browsers ignore 'unsafe-inline' and breaks the flow's rendering.
		const d = directives(
			descopeFlowContentSecurityPolicy("https://auth.tedix.dev", "N0NCE"),
		);
		expect(d["style-src"]).toContain("'unsafe-inline'");
		expect(d["style-src"]).not.toContain("nonce-");
	});

	it("allows every origin the live flow was observed to use", () => {
		const d = directives(
			descopeFlowContentSecurityPolicy("https://auth.tedix.dev", "N0NCE"),
		);
		expect(d["script-src"]).toContain("https://descopecdn.com");
		expect(d["connect-src"]).toContain("https://auth.tedix.dev");
		expect(d["style-src"]).toContain("https://fonts.googleapis.com");
		expect(d["font-src"]).toContain("https://fonts.gstatic.com");
	});

	it("does not set form-action, which would break a SAML POST binding", () => {
		const policy = descopeFlowContentSecurityPolicy(
			"https://auth.tedix.dev",
			"N0NCE",
		);
		expect(policy).not.toContain("form-action");
	});

	it("scopes connect/img/frame to the configured auth origin", () => {
		const d = directives(
			descopeFlowContentSecurityPolicy("https://auth.tedi.club", "N0NCE"),
		);
		expect(d["connect-src"]).toContain("https://auth.tedi.club");
		expect(d["img-src"]).toContain("https://auth.tedi.club");
		expect(d["frame-src"]).toContain("https://auth.tedi.club");
		expect(d["connect-src"]).not.toContain("auth.tedix.dev");
	});

	it("falls back to the default auth origin rather than emitting a broken policy", () => {
		const d = directives(descopeFlowContentSecurityPolicy("not a url", "N"));
		expect(d["connect-src"]).toContain("https://auth.tedix.dev");
	});

	it("merges surface-specific extras, e.g. the Cloudflare beacon", () => {
		// Cloudflare Web Analytics appends its script at the zone edge AFTER the
		// Worker responds, so it never carries our nonce and must be allowed by
		// origin or every page on the zone reports a violation.
		const d = directives(
			descopeFlowContentSecurityPolicy("https://auth.tedix.dev", "N0NCE", {
				scriptSrc: [CLOUDFLARE_BEACON_SCRIPT_ORIGIN],
				connectSrc: [CLOUDFLARE_BEACON_CONNECT_ORIGIN],
			}),
		);
		expect(d["script-src"]).toContain(CLOUDFLARE_BEACON_SCRIPT_ORIGIN);
		expect(d["connect-src"]).toContain(CLOUDFLARE_BEACON_CONNECT_ORIGIN);
	});
});

describe("descopeFlowContentSecurityPolicy violation reporting", () => {
	const withReport = () =>
		descopeFlowContentSecurityPolicy("https://auth.tedix.dev", "N", {
			report: { group: CSP_REPORT_GROUP, endpointPath: CSP_REPORT_PATH },
		});

	it("emits no reporting directives unless a surface asks for them", () => {
		const policy = descopeFlowContentSecurityPolicy(
			"https://auth.tedix.dev",
			"N",
		);
		expect(policy).not.toContain("report-to");
		expect(policy).not.toContain("report-uri");
	});

	it("emits both mechanisms, because neither covers the field alone", () => {
		// `report-to` is the current Reporting API; the deprecated `report-uri` is
		// still the only one Safari honours. Browsers that understand `report-to`
		// ignore `report-uri`, so both costs a duplicate report on no browser.
		const d = directives(withReport());
		expect(d["report-to"]).toBe(CSP_REPORT_GROUP);
		expect(d["report-uri"]).toBe(CSP_REPORT_PATH);
	});

	it("keeps the rest of the policy untouched when reporting is on", () => {
		const d = directives(withReport());
		expect(d["script-src"]).toContain("'nonce-N'");
		expect(d["script-src"]).not.toContain("'unsafe-inline'");
		expect(d["object-src"]).toBe("'none'");
	});

	it("names the same group the report-to directive points at", () => {
		// A `Reporting-Endpoints` group that does not match `report-to` delivers
		// nothing while both headers look individually correct.
		const header = reportingEndpointsHeader(
			CSP_REPORT_GROUP,
			`https://os.tedix.dev${CSP_REPORT_PATH}`,
		);
		expect(header).toBe(
			`${CSP_REPORT_GROUP}="https://os.tedix.dev/csp-report"`,
		);
		expect(header.startsWith(`${directives(withReport())["report-to"]}=`)).toBe(
			true,
		);
	});

	it("quotes the endpoint, as the structured-fields grammar requires", () => {
		const header = reportingEndpointsHeader("csp", "https://os.tedix.dev/x");
		expect(header).toMatch(/^csp="https:\/\/os\.tedix\.dev\/x"$/);
	});
});

describe("createCspNonce", () => {
	it("mints a fresh, non-trivial nonce each call", () => {
		const a = createCspNonce();
		const b = createCspNonce();
		expect(a).not.toBe(b);
		expect(a.length).toBeGreaterThanOrEqual(16);
	});
});

describe("descopeFlowContentSecurityPolicy img-src override", () => {
	it("defaults to the narrow Descope-only image sources", () => {
		expect(
			descopeFlowContentSecurityPolicy("https://auth.tedix.dev", "N"),
		).toContain(
			"img-src 'self' https://auth.tedix.dev https://static.descope.com https://descopecdn.com data: blob:",
		);
	});

	it("lets a surface widen images without weakening script-src", () => {
		const policy = descopeFlowContentSecurityPolicy(
			"https://auth.tedix.dev",
			"N",
			{ imgSrc: ["https:", "data:", "blob:"] },
		);
		expect(policy).toContain("img-src https: data: blob:");
		expect(policy).toContain("'nonce-N'");
		expect(policy).not.toContain("script-src 'self' https:");
	});
});

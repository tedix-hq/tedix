import { describe, expect, it } from "vite-plus/test";
import { redactRequestLogMessage } from "./request-log-redaction";

describe("redactRequestLogMessage", () => {
	it("removes OAuth callback query values while retaining the route", () => {
		expect(
			redactRequestLogMessage(
				"<-- GET /oauth/mcp/callback?code=secret-code&state=sealed-state&iss=https%3A%2F%2Fmcp.cloudflare.com",
			),
		).toBe("<-- GET /oauth/mcp/callback?[query-redacted]");
	});

	it("does not change ordinary request logs", () => {
		expect(redactRequestLogMessage("--> GET /health 200 3ms")).toBe(
			"--> GET /health 200 3ms",
		);
	});
});

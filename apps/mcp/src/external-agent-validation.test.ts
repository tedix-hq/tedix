import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	externalAgentValidationFailureResponse,
	recordExternalAgentValidation,
} from "./external-agent-validation";

afterEach(() => vi.restoreAllMocks());

describe("externalAgentValidationFailureResponse", () => {
	it("reports a canonical missing active session as inactive", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = externalAgentValidationFailureResponse({
			code: "NOT_FOUND",
			status: 404,
		});

		expect(response.status).toBe(403);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		await expect(response.json()).resolves.toMatchObject({
			error: "external_agent_inactive",
		});
		expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
			_mcp: "auth",
			event: "external_agent_validation_failed",
			outcome: "inactive",
			errorCode: "NOT_FOUND",
			retryable: false,
		});
	});

	it("reports a transient upstream failure as validation unavailable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = externalAgentValidationFailureResponse({
			code: "SERVICE_UNAVAILABLE",
			status: 503,
		});

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("2");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		await expect(response.json()).resolves.toMatchObject({
			error: "external_agent_validation_unavailable",
			retryAfter: 2,
		});
		expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
			outcome: "validation_unavailable",
			errorCode: "SERVICE_UNAVAILABLE",
			retryable: true,
		});
	});

	it("does not mislabel an unexpected validation failure as inactive", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = externalAgentValidationFailureResponse(
			new Error("identity mismatch"),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: "external_agent_validation_unavailable",
		});
	});
});

describe("recordExternalAgentValidation", () => {
	function analyticsEnv(
		writeDataPoint: ReturnType<typeof vi.fn>,
	): CloudflareEnv {
		return {
			ENVIRONMENT: "production",
			ANALYTICS: { writeDataPoint },
		} as unknown as CloudflareEnv;
	}

	it("records a successful validation duration without identity fields", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const writeDataPoint = vi.fn();

		recordExternalAgentValidation({
			env: analyticsEnv(writeDataPoint),
			appId: "app-1",
			appSlug: "tedix-unified",
			organizationId: "org-1",
			durationMs: 17,
		});

		expect(writeDataPoint).toHaveBeenCalledWith({
			blobs: [
				"auth_validation",
				"app-1",
				"tedix-unified",
				"org-1",
				"external_agent_session",
				"",
				"",
				"",
				"",
				"external_agent",
				"",
				"",
				"",
			],
			doubles: [1, 17, 0, 0, 0],
			indexes: ["app-1"],
		});
	});

	it.each([
		[{ code: "NOT_FOUND", status: 404 }, "inactive", 0],
		[{ code: "SERVICE_UNAVAILABLE", status: 503 }, "validation_unavailable", 0],
	])("records bounded failure outcome %s", (error, outcome, success) => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const writeDataPoint = vi.fn();

		recordExternalAgentValidation({
			env: analyticsEnv(writeDataPoint),
			organizationId: "org-1",
			durationMs: 23,
			error,
		});

		const point = writeDataPoint.mock.calls[0]?.[0] as {
			blobs: string[];
			doubles: number[];
		};
		expect(point.blobs[0]).toBe("auth_validation");
		expect(point.blobs[5]).toBe(outcome);
		expect(point.blobs).not.toContain("NOT_FOUND");
		expect(point.blobs).not.toContain("SERVICE_UNAVAILABLE");
		expect(point.doubles.slice(0, 2)).toEqual([success, 23]);
	});
});

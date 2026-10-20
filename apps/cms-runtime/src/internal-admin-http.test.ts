import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
	databaseSchemaDiagnosticResponse,
	databaseStorageAdminResponse,
} from "./database-admin";
import { errorResponse } from "./internal-admin-http";

afterEach(() => {
	vi.restoreAllMocks();
});

const STACK_MARKER = "stack-marker-7f3a1c";

function failingDatabaseEnv(error: unknown) {
	return {
		CMS_INTERNAL_AUTH_TOKEN: "internal-secret",
		DB_DO: {
			idFromName: () => "id",
			get: () => ({
				query: async () => {
					throw error;
				},
			}),
		},
	} as never;
}

function markedError(message: string): Error {
	const error = new Error(message);
	error.stack = `Error: ${message}\n    at ${STACK_MARKER} (/srv/emdash/internal.ts:1:1)`;
	return error;
}

function adminRequest(url: URL): Request {
	return new Request(url, {
		headers: { "X-Tedix-CMS-Internal-Auth": "internal-secret" },
	});
}

describe("errorResponse", () => {
	test("serializes a code and the error message, never the stack", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = errorResponse(
			502,
			"cms_probe_failed",
			markedError("probe failed"),
		);
		expect(response.status).toBe(502);
		const text = await response.text();
		expect(text).not.toContain(STACK_MARKER);
		expect(text).not.toContain("stack");
		expect(JSON.parse(text)).toEqual({
			ok: false,
			success: false,
			code: "cms_probe_failed",
			error: "probe failed",
		});
		expect(logged).toHaveBeenCalledTimes(1);
	});

	test("truncates long messages and falls back to the code for non-Error throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const long = await errorResponse(
			502,
			"cms_probe_failed",
			new Error("x".repeat(500)),
		).json();
		expect((long as { error: string }).error).toHaveLength(200);
		const thrownString = await errorResponse(
			502,
			"cms_probe_failed",
			`raw ${STACK_MARKER}`,
		).json();
		expect(thrownString).toMatchObject({ error: "cms_probe_failed" });
		expect(JSON.stringify(thrownString)).not.toContain(STACK_MARKER);
	});
});

describe("internal admin handlers", () => {
	test("storage and schema probes report failures without stack frames", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const env = failingDatabaseEnv(markedError("SQLITE_BUSY"));
		const storageUrl = new URL(
			"https://tenant.cms.tedix.dev/_tedix/internal/database-runtime/storage",
		);
		const storage = await databaseStorageAdminResponse({
			env,
			request: adminRequest(storageUrl),
			slug: "tenant",
			url: storageUrl,
		});
		expect(storage?.status).toBe(502);
		const storageText = await storage!.text();
		expect(storageText).not.toContain(STACK_MARKER);
		expect(JSON.parse(storageText)).toMatchObject({
			ok: false,
			code: "cms_storage_query_failed",
			error: "SQLITE_BUSY",
		});

		const schemaUrl = new URL(
			"https://tenant.cms.tedix.dev/_tedix/internal/database-runtime/schema-diagnostic",
		);
		const schema = await databaseSchemaDiagnosticResponse({
			env,
			request: adminRequest(schemaUrl),
			slug: "tenant",
			url: schemaUrl,
		});
		expect(schema?.status).toBe(502);
		const schemaText = await schema!.text();
		expect(schemaText).not.toContain(STACK_MARKER);
		expect(JSON.parse(schemaText)).toMatchObject({
			ok: false,
			code: "cms_schema_diagnostic_failed",
		});
	});
});

import { describe, expect, test } from "bun:test";
import { healthResponseError } from "./health-response";

describe("development health response", () => {
	test.each(["", " ", "\t\r\n"])(
		"rejects blank Worker revision %j without changing other health modes",
		(deployedSha) => {
			const body = JSON.stringify({ status: "ok", deployedSha });
			expect(healthResponseError(body, "worker")).toContain(
				"start the Worker-backed OS",
			);
			expect(healthResponseError(body, "json")).toBeNull();
			expect(
				healthResponseError(
					JSON.stringify({ status: "ok", runtime: "fixtures", deployedSha }),
					"fixtures",
				),
			).toBeNull();
		},
	);

	test.each(["unknown", "abc123", " abc123 "])(
		"accepts nonblank Worker revision %j",
		(deployedSha) => {
			expect(
				healthResponseError(
					JSON.stringify({ status: "ok", deployedSha }),
					"worker",
				),
			).toBeNull();
		},
	);

	test("rejects HTML, invalid JSON, arrays, and failed status even with HTTP 200", () => {
		for (const body of [
			"<!doctype html><title>OS</title>",
			"",
			"[]",
			"null",
			'{"status":"error"}',
		]) {
			expect(healthResponseError(body, "json")).not.toBeNull();
		}
	});
	test("distinguishes fixtures from the real OS Worker in both directions", () => {
		const fixtures =
			'{"status":"ok","runtime":"fixtures","auth":"disabled","data":"in-memory"}';
		const worker = '{"status":"ok","deployedSha":"unknown"}';
		expect(healthResponseError(fixtures, "fixtures")).toBeNull();
		expect(healthResponseError(worker, "worker")).toBeNull();
		expect(healthResponseError(fixtures, "worker")).toContain(
			"start the Worker-backed OS",
		);
		expect(healthResponseError(worker, "fixtures")).not.toBeNull();
		expect(healthResponseError('{"status":"ok"}', "worker")).not.toBeNull();
	});
});

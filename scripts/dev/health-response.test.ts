import { describe, expect, test } from "bun:test";
import { healthResponseError } from "./health-response";

describe("development health response", () => {
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

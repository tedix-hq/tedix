import { ORPCError, ValidationError } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import {
	describeValidationIssues,
	enrichInputValidationError,
} from "./input-validation-error";

/**
 * Reproduce the shape oRPC throws when input-schema validation fails (see
 * @orpc/server validateInput): BAD_REQUEST + "Input validation failed" with the
 * standard-schema issues on both `cause` (ValidationError) and `data.issues`.
 */
function inputValidationError(
	issues: Array<{ message: string; path?: Array<PropertyKey> }>,
): ORPCError<"BAD_REQUEST", { issues: unknown }> {
	return new ORPCError("BAD_REQUEST", {
		message: "Input validation failed",
		data: { issues },
		cause: new ValidationError({ message: "Input validation failed", issues }),
	});
}

describe("describeValidationIssues", () => {
	it("renders field-first, de-duplicated lines", () => {
		expect(
			describeValidationIssues([
				{ message: "Required", path: ["content"] },
				{ message: "Required", path: ["content"] },
				{ message: "Expected string", path: ["conversationId"] },
			]),
		).toBe("content: Required; conversationId: Expected string");
	});

	it("labels an empty path as (root) and missing message as invalid", () => {
		expect(describeValidationIssues([{ message: "", path: [] }])).toBe(
			"(root): invalid",
		);
	});

	it("flattens nested and object-keyed path segments", () => {
		expect(
			describeValidationIssues([
				{ message: "Required", path: ["attachments", 0, { key: "content" }] },
			]),
		).toBe("attachments.0.content: Required");
	});

	it("returns null for non-arrays / empty", () => {
		expect(describeValidationIssues([])).toBeNull();
		expect(describeValidationIssues(undefined)).toBeNull();
	});
});

describe("enrichInputValidationError", () => {
	it("names the missing required field in the message (ask content)", () => {
		const enriched = enrichInputValidationError(
			inputValidationError([
				{ message: "Invalid input: expected string", path: ["content"] },
			]),
		);
		expect(enriched).toBeInstanceOf(ORPCError);
		const orpcError = enriched as ORPCError<string, unknown>;
		expect(orpcError.message).toBe(
			"Input validation failed: content: Invalid input: expected string",
		);
		// Field name is now discoverable from the bare message alone.
		expect(orpcError.message).toContain("content");
		expect(orpcError.code).toBe("BAD_REQUEST");
	});

	it("preserves the structured issues payload on data", () => {
		const original = inputValidationError([
			{ message: "Required", path: ["content"] },
		]);
		const enriched = enrichInputValidationError(original) as ORPCError<
			string,
			{ issues: unknown }
		>;
		expect(enriched).not.toBe(original);
		expect(enriched.data).toEqual(original.data);
	});

	it("falls back to data.issues when cause is not a ValidationError", () => {
		const error = new ORPCError("BAD_REQUEST", {
			message: "Input validation failed",
			data: { issues: [{ message: "Required", path: ["content"] }] },
		});
		const enriched = enrichInputValidationError(error) as ORPCError<
			string,
			unknown
		>;
		expect(enriched.message).toBe("Input validation failed: content: Required");
	});

	it("leaves unrelated ORPCErrors untouched", () => {
		const notFound = new ORPCError("NOT_FOUND", { message: "Run not found" });
		expect(enrichInputValidationError(notFound)).toBe(notFound);

		const otherBadRequest = new ORPCError("BAD_REQUEST", {
			message: "Message content or attachment required",
		});
		expect(enrichInputValidationError(otherBadRequest)).toBe(otherBadRequest);
	});

	it("returns a validation error unchanged when it carries no issues", () => {
		const noIssues = new ORPCError("BAD_REQUEST", {
			message: "Input validation failed",
		});
		expect(enrichInputValidationError(noIssues)).toBe(noIssues);
	});

	it("passes through non-ORPCError values", () => {
		const plain = new Error("boom");
		expect(enrichInputValidationError(plain)).toBe(plain);
	});
});

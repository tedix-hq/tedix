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

/**
 * Issue shapes below mirror zod 4's standard-schema output: oRPC forwards the
 * validator's raw issues, so `code`, `keys` and `maximum` are available to
 * turn "what is wrong" into "what to send instead".
 */
describe("describeValidationIssues hints", () => {
	it("explains a wrong root shape with received and expected key names", () => {
		// `get_work_items_by_id({ ids: [...] })` against a `{ id }` schema.
		expect(
			describeValidationIssues([
				{
					code: "invalid_type",
					expected: "string",
					path: ["id"],
					message: "Invalid input: expected string, received undefined",
				},
				{
					code: "unrecognized_keys",
					keys: ["ids"],
					path: [],
					message: 'Unrecognized key: "ids"',
				},
			]),
		).toBe(
			'id: Invalid input: expected string, received undefined; (root): Unrecognized key: "ids"; received keys: [ids]; expected: [id]',
		);
	});

	it("lists received keys alone when no root field is missing", () => {
		expect(
			describeValidationIssues([
				{
					code: "unrecognized_keys",
					keys: ["view", "idPrefix"],
					path: [],
					message: 'Unrecognized keys: "view", "idPrefix"',
				},
			]),
		).toBe(
			'(root): Unrecognized keys: "view", "idPrefix"; received keys: [view, idPrefix]',
		);
	});

	it("does not count a nested missing field as an expected root key", () => {
		expect(
			describeValidationIssues([
				{
					code: "invalid_type",
					path: ["filters", "status"],
					message: "Invalid input: expected string, received undefined",
				},
			]),
		).toBe(
			"filters.status: Invalid input: expected string, received undefined",
		);
	});

	it("tells a caller how to resolve a short id on a UUID issue", () => {
		expect(
			describeValidationIssues([
				{
					code: "invalid_format",
					format: "uuid",
					path: ["id"],
					message: "Invalid UUID",
				},
			]),
		).toBe(
			'id: Invalid UUID; id must be a full UUID; resolve a short id with list_work_item_cli_rows({ view: "board", idPrefix })',
		);
	});

	it("names the maximum and paging for limit too big", () => {
		expect(
			describeValidationIssues([
				{
					code: "too_big",
					maximum: 100,
					inclusive: true,
					path: ["limit"],
					message: "Too big: expected number to be <=100",
				},
			]),
		).toBe(
			"limit: Too big: expected number to be <=100; send limit ≤ 100 and page with offset",
		);
	});

	it("reads the maximum from the message when the issue carries none", () => {
		expect(
			describeValidationIssues([
				{ path: ["limit"], message: "Too big: expected number to be <=50" },
			]),
		).toContain("send limit ≤ 50 and page with offset");
	});

	it("never echoes a submitted value, only key names", () => {
		const secret = "submitted-value-must-not-appear";
		const described = describeValidationIssues([
			{
				code: "invalid_format",
				format: "uuid",
				input: secret,
				path: ["id"],
				message: "Invalid UUID",
			},
			{
				code: "unrecognized_keys",
				keys: ["token"],
				input: { token: secret },
				path: [],
				message: 'Unrecognized key: "token"',
			},
			{
				code: "too_big",
				maximum: 100,
				input: 9999,
				path: ["limit"],
				message: "Too big: expected number to be <=100",
			},
		]);
		expect(described).not.toContain(secret);
		expect(described).not.toContain("9999");
		expect(described).toContain("received keys: [token]");
	});

	it("caps the description at 300 characters and clips long key names", () => {
		const described = describeValidationIssues([
			{
				code: "unrecognized_keys",
				keys: Array.from({ length: 20 }, (_, i) => `k${i}-${"x".repeat(60)}`),
				path: [],
				message: "Unrecognized keys",
			},
			...Array.from({ length: 5 }, (_, i) => ({
				code: "invalid_format",
				path: [`ref${i}`],
				message: "Invalid UUID",
			})),
		]);
		expect(described).not.toBeNull();
		expect(described?.length).toBeLessThanOrEqual(300);
		expect(described?.endsWith("…")).toBe(true);
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

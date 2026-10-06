import { describe, expect, it } from "vite-plus/test";
import { isDurableObjectResetError } from "./durable-object-reset";

/** Build the rejection shape workerd hands the calling Worker. */
function rejection(
	message: string,
	flags: Record<string, boolean>,
): Error & Record<string, boolean> {
	return Object.assign(new Error(message), flags);
}

describe("isDurableObjectResetError", () => {
	it("classifies the production storage-timeout shape with no retryable flag", () => {
		expect(
			isDurableObjectResetError(
				rejection("Durable Object reset.", {
					remote: true,
					overloaded: true,
					durableObjectReset: true,
				}),
			),
		).toBe(true);
	});

	it("classifies a code-deploy reset", () => {
		expect(
			isDurableObjectResetError(
				rejection("Durable Object reset because its code was updated.", {
					remote: true,
					retryable: true,
					durableObjectReset: true,
				}),
			),
		).toBe(true);
	});

	it("classifies a bare lost connection", () => {
		expect(
			isDurableObjectResetError(
				rejection("Network connection lost.", {
					remote: true,
					retryable: true,
				}),
			),
		).toBe(true);
	});

	it("does not classify a live object shedding load as a reset", () => {
		expect(
			isDurableObjectResetError(
				rejection("Durable Object is overloaded.", {
					remote: true,
					overloaded: true,
				}),
			),
		).toBe(false);
	});

	it("does not classify ordinary failures, including reset-shaped prose", () => {
		expect(
			isDurableObjectResetError(
				new Error("Attempt failed due to internal workflows error"),
			),
		).toBe(false);
		expect(
			isDurableObjectResetError(
				new Error("Durable Object reset because its code was updated."),
			),
		).toBe(false);
		expect(isDurableObjectResetError(null)).toBe(false);
		expect(isDurableObjectResetError("Durable Object reset.")).toBe(false);
		expect(isDurableObjectResetError(undefined)).toBe(false);
	});

	it("requires literal true flags", () => {
		expect(
			isDurableObjectResetError(
				Object.assign(new Error("reset"), {
					durableObjectReset: "true",
					retryable: 1,
				}),
			),
		).toBe(false);
	});
});

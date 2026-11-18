import { describe, expect, it } from "vite-plus/test";
import { apiContract } from "./contracts/api";
import { baseErrorConstructors, baseErrors } from "./errors";

describe("declared API errors", () => {
	it("declares shared guard errors on every procedure", () => {
		const missing: string[] = [];
		function visit(value: unknown, path: string) {
			if (!value || typeof value !== "object") return;
			if ("~orpc" in value) {
				const definition = value["~orpc"] as {
					errorMap: Record<string, unknown>;
				};
				for (const code of Object.keys(baseErrors)) {
					if (!(code in definition.errorMap)) missing.push(`${path}: ${code}`);
				}
				return;
			}
			for (const [key, child] of Object.entries(value)) {
				visit(child, `${path}/${key}`);
			}
		}
		visit(apiContract, "");
		expect(missing).toEqual([]);
	});

	it("preserves messages, data and causes in shared error constructors", () => {
		const cause = new Error("upstream failure");
		const data = { expectedRevision: 1, currentRevision: 2 };
		const error = baseErrorConstructors.CONFLICT({
			message: "Revision changed",
			data,
			cause,
		});
		expect(error).toMatchObject({
			code: "CONFLICT",
			message: "Revision changed",
			defined: true,
		});
		expect(error.data).toBe(data);
		expect(error.cause).toBe(cause);
	});
});

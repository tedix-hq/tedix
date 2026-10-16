import { describe, expect, it } from "bun:test";
import { readGatewayProjection } from "./gateway-projection";

describe("gateway projection code", () => {
	it.each([false, true])(
		"round-trips argument and projection keys as data (projection=%s)",
		async (project) => {
			const value =
				'\"); throw new Error("injected"); // </script><script> & \\ \n\u2028\u2029';
			const input = { value };
			const row = { [value]: value, omitted: "other" };
			const client = {
				runCode: async (source: string) =>
					new Function("tools", `return (${source})()`)({
						read: async (args: unknown) => {
							expect(args).toEqual(input);
							return { [value]: [row] };
						},
					}),
			};
			expect(
				await readGatewayProjection(
					client,
					"tools.read",
					input,
					project ? [value] : undefined,
					value,
				),
			).toEqual({
				[value]: [project ? { [value]: value } : row],
			});
		},
	);
});

import { describe, expect, it, vi } from "vite-plus/test";
import { contentFreeMcpException, createMcpLogger } from "./log";

describe("contentFreeMcpException", () => {
	it("keeps standard cause types without caught messages", () => {
		const error = new Error("outer bearer secret", {
			cause: new TypeError("inner bearer secret"),
		});
		expect(contentFreeMcpException(error)).toEqual({
			name: "Error",
			message: "Content omitted",
			cause: { name: "TypeError", message: "Content omitted" },
		});
	});

	it("does not carry a custom Error.name into the emitted log", () => {
		const error = new Error("message bearer secret");
		error.name = "CustomBearerSecret123";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			createMcpLogger("mcp.test").warn("MCP operation failed", {
				event: "mcp.test.failed",
				error: contentFreeMcpException(error),
			});
			expect(warn.mock.calls[0]?.[0]).toMatchObject({
				event: "mcp.test.failed",
				exception: {
					type: "UnknownThrown",
					message: "Content omitted",
				},
			});
			expect(JSON.stringify(warn.mock.calls)).not.toContain("BearerSecret");
			expect(JSON.stringify(warn.mock.calls)).not.toContain("bearer secret");
		} finally {
			warn.mockRestore();
		}
	});
});

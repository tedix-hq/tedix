import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { laneSession } from "./lane";
describe("lane attribution and dispatch", () => {
	it("uses the child identity instead of its launcher's inherited Claude id", () => {
		expect(
			laneSession({ CODEX_THREAD_ID: "child", CLAUDE_CODE_SESSION_ID: "lead" }),
		).toBe("codex:child");
		expect(
			laneSession({
				TEDIX_AGENT_SESSION: "claude-code:explicit",
				CODEX_THREAD_ID: "child",
			}),
		).toBe("claude-code:explicit");
		expect(() => laneSession({})).toThrow("own host session");
	});
	it("documents the command without connecting or requiring credentials", () => {
		const text = execFileSync(
			process.execPath,
			[fileURLToPath(new URL("./index.ts", import.meta.url)), "lane", "--help"],
			{ encoding: "utf8" },
		);
		expect(text).toContain("tedix lane start");
		expect(text).toContain("own Codex/Claude session");
	});
});

it("rejects a blank human next click before connecting or settling Work", async () => {
	const { runLane } = await import("./lane");
	await expect(runLane(["done", "--needs-user", "   "])).rejects.toThrow(
		"exact next click",
	);
});

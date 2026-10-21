import { expect, it } from "vite-plus/test";
import { WorkExecutorSchema } from "./work-items";
import { WorkAgentSessionHarnessSchema } from "./work-agent-sessions";
import { isHostSessionId } from "../utils/host-session-id";

it("accepts native OpenCode identities and the any-local routing assignment", () => {
	expect(WorkExecutorSchema.parse("opencode")).toBe("opencode");
	expect(WorkExecutorSchema.parse("any-local")).toBe("any-local");
	expect(WorkAgentSessionHarnessSchema.parse("opencode")).toBe("opencode");
	expect(WorkAgentSessionHarnessSchema.safeParse("any-local").success).toBe(
		false,
	);
	for (const id of [
		"ses_0123456789abABCDEFGHIJKLMN",
		"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
		"quiet-river",
	])
		expect(isHostSessionId(id)).toBe(true);
	for (const id of [
		"ses_0123456789abABCDEFGHIJKLMN\n",
		"ses_0123456789abshort",
		"../ses_0123456789abABCDEFGHIJKLMN",
	])
		expect(isHostSessionId(id)).toBe(false);
});

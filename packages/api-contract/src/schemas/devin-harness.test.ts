import { expect, it } from "vite-plus/test";
import { WorkExecutorSchema } from "./work-items";
import { WorkAgentSessionHarnessSchema } from "./work-agent-sessions";
import { isHostSessionId } from "../utils/host-session-id";
import { AttentionSourceSchema } from "./attention-layout";

it("accepts Devin for Work, session reports and activity filters", () => {
	expect(WorkExecutorSchema.parse("devin")).toBe("devin");
	expect(WorkAgentSessionHarnessSchema.parse("devin")).toBe("devin");
	expect(AttentionSourceSchema.parse("local_devin")).toBe("local_devin");
	for (const id of ["quiet-river", "11111111-1111-4111-8111-111111111111"])
		expect(isHostSessionId(id)).toBe(true);
	for (const id of ["../quiet-river", "quiet-river\n", "quiet-river:other", ""])
		expect(isHostSessionId(id)).toBe(false);
});

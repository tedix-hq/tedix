import { expect, it } from "vite-plus/test";
import * as z from "zod";
import { agentTurnTriageContract } from "@tedix/api-contract/contracts/agent-turn-triage";
import { workAgentSessionsContract } from "@tedix/api-contract/contracts/work-agent-sessions";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";

it("projects OpenCode in the MCP status, ledger and decision harness enums", () => {
	const schema = (procedure: unknown) =>
		z.toJSONSchema(procedureInputSchema(procedure) as z.ZodType);
	const status = schema(workAgentSessionsContract.report);
	const ledger = schema(workAgentSessionsContract.recordEvents);
	const decisions = schema(agentTurnTriageContract.importSessionDecisions);
	expect(status).toHaveProperty("properties.harness.enum", [
		"claude-code",
		"codex",
		"opencode",
		"devin",
		"tedi",
		"skill",
	]);
	expect(ledger).toHaveProperty(
		"properties.events.items.properties.harness.enum",
		["claude-code", "codex", "opencode", "devin", "tedi", "skill"],
	);
	expect(decisions).toHaveProperty(
		"properties.decisions.items.properties.harness.enum",
		["claude-code", "codex", "opencode"],
	);
	expect(status.additionalProperties).toBe(false);
});

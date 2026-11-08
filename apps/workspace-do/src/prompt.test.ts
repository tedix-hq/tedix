import { stepLabel } from "./wire";
import { describe, expect, test } from "bun:test";
import {
	BINDING_NAMES,
	describeBinding,
	renderEnvDeclarations,
} from "./declarations";
import {
	buildSystemPrompt,
	dynamicPromptSuffix,
	staticPromptPrefix,
} from "./prompt";

describe("prompt", () => {
	test("typed sheet and presentation methods are discoverable and writes are labeled", () => {
		for (const [binding, type] of [
			["sheets", "Sheets"],
			["presentations", "Presentations"],
		] as const) {
			expect(describeBinding(binding)).toContain(`interface ${type}`);
			expect(renderEnvDeclarations()).toContain(`${binding}: ${type}`);
			expect(stepLabel(binding, "read").kind).toBe("read");
			for (const method of ["replace", "edit"])
				expect(stepLabel(binding, method).kind).toBe("write");
		}
	});

	test("static prefix is identical across turns and carries every binding", () => {
		const a = staticPromptPrefix();
		const b = staticPromptPrefix();
		expect(a).toBe(b);
		for (const name of BINDING_NAMES) expect(a).toContain(`${name}:`);
		expect(a).toContain("interface Env");
	});

	test("dynamic suffix comes after the prefix", () => {
		const prompt = buildSystemPrompt({
			workspaceName: "Programme workspace",
			nowIso: "2026-11-07T17:00:00.000Z",
			tediPrompt: "You are Pat Example, a tedi.",
		});
		expect(prompt.startsWith(staticPromptPrefix())).toBe(true);
		expect(prompt.indexOf("Workspace: Programme workspace")).toBeGreaterThan(
			prompt.indexOf("interface Env"),
		);
		expect(
			dynamicPromptSuffix({ workspaceName: "x", nowIso: "t" }),
		).not.toContain("tedi");
	});

	test("describeBinding returns one binding whole, unknown names null", () => {
		expect(describeBinding("work")).toContain("interface Work");
		expect(describeBinding("work")).not.toContain("interface Outputs");
		expect(describeBinding("nope")).toBeNull();
		expect(renderEnvDeclarations()).toContain("interface Work");
	});
});

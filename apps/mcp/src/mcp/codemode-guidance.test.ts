import { describe, expect, it } from "vite-plus/test";

import { modernDiscoverInstructions } from "../codemode-fast-paths";
import { ATTENTION_GUIDANCE } from "./attention-guidance";
import {
	buildCodeModeDescription,
	capServerInstructions,
	codeModeInstructionParts,
	MAX_CODEMODE_DESCRIPTION_CHARS,
	MAX_SERVER_INSTRUCTIONS_CHARS,
} from "./codemode-guidance";
import { CONNECT_PAYMENT_DENIED } from "./connect-payment-policy";

// A Connect gateway aggregates many organizations' namespaces.
const manyNamespaces = Array.from(
	{ length: 120 },
	(_, i) => [`organization_namespace_${i}`, 40 - (i % 40)] as const,
);

function connectDescription(compactTypes = "") {
	return buildCodeModeDescription({
		toolCount: 1_800,
		namespaceCount: manyNamespaces.length,
		namespaces: manyNamespaces,
		moduleNames: ["zod", "date-fns"],
		compactTypes,
		connectionAppSlug: "connect",
	});
}

describe("code tool description budget", () => {
	it("keeps the Connect description within 4,000 characters", () => {
		const { description } = connectDescription();
		expect(description.length).toBeLessThanOrEqual(
			MAX_CODEMODE_DESCRIPTION_CHARS,
		);
		expect(MAX_CODEMODE_DESCRIPTION_CHARS).toBeLessThanOrEqual(4_000);
	});

	it("keeps the discovery loop, approvals and result envelope", () => {
		const { description } = connectDescription();
		for (const required of [
			"discover.search",
			"discover.describe",
			"includeOutputSchema",
			"authorized: false",
			"Never guess tool names",
			"confirmDestructive",
			"__tedix_truncated",
			"__tedix_result_handle",
			"discover.read_result",
			"completionEvidence",
			"nearestNamespaces",
			"codemode.__runtime()",
			"no host, fs, require, process or external fetch",
			"more (discover.list_namespaces())",
			CONNECT_PAYMENT_DENIED,
		])
			expect(description).toContain(required);
	});

	it("drops per-tool types that would pass the budget", () => {
		const huge = `declare namespace big {\n${"  function x(): void;\n".repeat(500)}}`;
		const result = connectDescription(huge);
		expect(result.compactTypesInlined).toBe(false);
		expect(result.description).not.toContain("declare namespace big");
		expect(result.description.length).toBeLessThanOrEqual(
			MAX_CODEMODE_DESCRIPTION_CHARS,
		);
	});

	it("inlines per-tool types that fit", () => {
		const result = buildCodeModeDescription({
			toolCount: 3,
			namespaceCount: 4,
			namespaces: [["crm", 3]],
			moduleNames: [],
			compactTypes: "declare namespace crm { function list(): void; }",
			connectionAppSlug: "crm-app",
		});
		expect(result.compactTypesInlined).toBe(true);
		expect(result.description).toContain("declare namespace crm");
		expect(result.description).not.toContain(CONNECT_PAYMENT_DENIED);
	});
});

describe("server instructions budget", () => {
	it("keeps the Connect Code Mode instructions within 4,096 characters, untruncated", () => {
		const instructions = modernDiscoverInstructions(
			{
				app: { slug: "tedix", name: "Tedix" },
				metadata: { mcpConfig: { codeMode: true } },
			} as never,
			"connect",
		);
		expect(instructions).toBeDefined();
		expect(instructions!.length).toBeLessThanOrEqual(
			MAX_SERVER_INSTRUCTIONS_CHARS,
		);
		expect(MAX_SERVER_INSTRUCTIONS_CHARS).toBeLessThanOrEqual(4_096);
		expect(instructions).not.toContain("(truncated");
		for (const part of codeModeInstructionParts("connect"))
			expect(instructions).toContain(part);
	});

	it("carries the guidance moved out of the code tool description", () => {
		const text = codeModeInstructionParts("connect").join("\n");
		for (const required of [
			ATTENTION_GUIDANCE,
			"supportedClaims",
			"evidenceRefs",
			"read_execution",
			"retry.blocked",
			"flow.run({ source, capabilities })",
			"flow.status",
			"tedix flow run --file plan.ts --watch",
			"start_external_agent_session_for_host",
			"agentSessionId on every code call",
			"ui.get_catalog()",
			"ui.validate_layout()",
			"ui.create_view(",
			"ui.create_mcp_app(",
			"ui.create_health_sweep(",
			"/skill-runs/{runId}/media/{artifactPath}",
			"?kind=video",
			CONNECT_PAYMENT_DENIED,
		])
			expect(text).toContain(required);
		expect(codeModeInstructionParts("paymesh").join("\n")).toContain(
			'_meta["x402/payment"]',
		);
	});

	it("caps long tenant text and keeps platform guidance first", () => {
		const platform = codeModeInstructionParts("connect");
		const { instructions, truncated } = capServerInstructions(
			[...platform, "tenant ".repeat(2_000)],
			"find skills with `discover.search`",
		);
		expect(truncated).toBe(true);
		expect(instructions!.length).toBeLessThanOrEqual(
			MAX_SERVER_INSTRUCTIONS_CHARS,
		);
		for (const part of platform) expect(instructions).toContain(part);
	});
});

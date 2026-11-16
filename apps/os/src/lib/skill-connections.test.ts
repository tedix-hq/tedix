import { describe, expect, it } from "vite-plus/test";
import { deriveSkillConnections } from "./skill-connections";

const WORKFLOW = `export default { async run(event, step, env) {
	await step.do("orders", async () => env.MCP.storefront.list_orders({}));
	await step.do("report", async () => env.MCP.sheets.write_report({}));
	await step.do("note", async () => env.MCP.os.create_output({}));
} };`;

const skill = (overrides: Record<string, unknown> = {}) => ({
	content: "# Doc",
	files: { "scripts/workflow.ts": WORKFLOW },
	inputSchema: null,
	mcpAppBindings: { storefront: "app-storefront" } as Record<string, string>,
	...overrides,
});

const installed = [
	{ appId: "app-storefront", appName: "Storefront", badge: "ready" as const },
	{ appId: "app-mail", appName: "Mail", badge: "setup_needed" as const },
];

describe("deriveSkillConnections", () => {
	it("names each connection by its installed app and says whether it is ready", () => {
		const connections = deriveSkillConnections(skill(), installed);
		expect(
			connections.map((connection) => [
				connection.namespace,
				connection.label,
				connection.status,
				connection.tools.map((tool) => tool.label),
			]),
		).toEqual([
			["sheets", "Sheets", "no_app", ["Write report"]],
			["storefront", "Storefront", "ready", ["List orders"]],
			["os", "Tedix", "built_in", ["Create output"]],
		]);
		expect(connections[1]).toMatchObject({
			appId: "app-storefront",
			tools: [{ call: "storefront.list_orders", label: "List orders" }],
		});
	});

	it("passes on what the installed app needs", () => {
		const [mail] = deriveSkillConnections(
			skill({
				files: null,
				mcpAppBindings: { gmail: "app-mail" },
				tools: ["gmail.send_message", "gmail"],
			}),
			installed,
		);
		expect(mail).toMatchObject({
			label: "Mail",
			status: "setup_needed",
			tools: [{ call: "gmail.send_message", label: "Send message" }],
		});
	});

	it("claims nothing while the installed apps are not read", () => {
		expect(
			deriveSkillConnections(skill(), undefined).map((c) => c.status),
		).toEqual(["unknown", "unknown", "built_in"]);
	});

	it("claims nothing for a version saved before links were recorded", () => {
		expect(
			deriveSkillConnections(skill({ mcpAppBindings: null }), installed).map(
				(c) => [c.namespace, c.status],
			),
		).toEqual([
			["sheets", "unknown"],
			["storefront", "unknown"],
			["os", "built_in"],
		]);
	});

	it("does not call a linked app ready when it is not among the installed apps", () => {
		expect(
			deriveSkillConnections(
				skill({ mcpAppBindings: { storefront: "app-elsewhere" } }),
				installed,
			).find((c) => c.namespace === "storefront"),
		).toMatchObject({ label: "Storefront", status: "unknown" });
	});

	it("lists nothing for a skill that names no connection", () => {
		expect(
			deriveSkillConnections(
				skill({ files: null, mcpAppBindings: null }),
				installed,
			),
		).toEqual([]);
	});
});

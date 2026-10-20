import { describe, it, expect } from "vite-plus/test";
import {
	mapToolsListResult,
	mapResourcesListResult,
	mapResourceTemplatesListResult,
	mapPromptsListResult,
} from "./list-mappers";
describe("list mappers", () => {
	it("filters tools with invalid x-mcp-header annotations from snapshots", () => {
		const out = mapToolsListResult("srv", {
			tools: [
				{
					name: "good",
					inputSchema: {
						type: "object",
						properties: {
							tenant: { type: "string", "x-mcp-header": "Tenant" },
						},
					},
				},
				{
					name: "bad",
					inputSchema: {
						type: "object",
						properties: {
							tenant: { type: "string", "x-mcp-header": "Bad Header" },
						},
					},
				},
				{
					name: "duplicate",
					inputSchema: {
						type: "object",
						properties: {
							a: { type: "string", "x-mcp-header": "Tenant" },
							b: { type: "string", "x-mcp-header": "tenant" },
						},
					},
				},
			],
		});

		expect(out.map((tool) => tool.name)).toEqual(["good"]);
	});
	it("retains resource, template and prompt metadata while filtering missing identifiers", () => {
		const icons = [
			{ src: "https://example.com/icon.svg", sizes: "any", theme: "dark" },
		];
		const metadata = { "io.tedix/version": "2" };
		const resources = mapResourcesListResult("srv", {
			resources: [
				{
					uri: "skill://review/SKILL.md",
					icons,
					_meta: metadata,
					annotations: { priority: 0.8 },
				},
				{ name: "missing URI" },
			],
		});
		expect(resources).toHaveLength(1);
		expect(resources[0]).toMatchObject({
			serverId: "srv",
			uri: "skill://review/SKILL.md",
			icons: [
				{ src: "https://example.com/icon.svg", sizes: ["any"], theme: "dark" },
			],
			_meta: metadata,
			annotations: { priority: 0.8 },
		});
		expect(
			mapResourceTemplatesListResult("srv", {
				resourceTemplates: [
					{ uriTemplate: "file:///{path}", title: "Files", _meta: metadata },
					{},
				],
			}),
		).toMatchObject([
			{
				serverId: "srv",
				uriTemplate: "file:///{path}",
				title: "Files",
				_meta: metadata,
			},
		]);
		expect(
			mapPromptsListResult("srv", {
				prompts: [
					{
						name: "review",
						arguments: [{ name: "input", required: true }, null, {}],
						_meta: metadata,
					},
					{},
				],
			}),
		).toMatchObject([
			{
				serverId: "srv",
				name: "review",
				arguments: [{ name: "input", required: true }],
				_meta: metadata,
			},
		]);
	});
});

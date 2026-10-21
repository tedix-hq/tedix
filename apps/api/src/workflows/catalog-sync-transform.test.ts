import { describe, expect, it } from "vite-plus/test";
import {
	isChatGPTFormat,
	isClaudeFormat,
	isChatGPTAppsListFormat,
	isChatGPTActionsFormat,
	isClaudeServersFormat,
	mapCategory,
	mapConnectorType,
	mapDistributionChannel,
	mapDeveloperType,
	mapReviewStatus,
	mapAppStatus,
	mapAuthTypes,
	transformClaudeEntry,
	transformChatGPTAppsListEntry,
	transformChatGPTActionsEntry,
	transformClaudeServerEntry,
} from "./catalog-sync-transform";

const formats = [
	["connectors", isChatGPTFormat],
	["entries", isClaudeFormat],
	["apps", isChatGPTAppsListFormat],
	["links", isChatGPTActionsFormat],
	["servers", isClaudeServersFormat],
] as const;

describe("catalog format detectors", () => {
	for (const [key, detect] of formats) {
		it(`accepts only the ${key} array shape`, () => {
			for (const [otherKey] of formats) {
				expect(detect({ [otherKey]: [] })).toBe(otherKey === key);
			}
			for (const invalid of [
				null,
				undefined,
				false,
				1,
				"data",
				[],
				{},
				{ [key]: {} },
				{ [key]: null },
			]) {
				expect(detect(invalid)).toBe(false);
			}
		});
	}
});

describe("catalog mappers", () => {
	it("keeps recognized values and falls back for unknown or absent values", () => {
		for (const [map, recognized] of [
			[mapCategory, "PRODUCTIVITY"],
			[mapDistributionChannel, "INDIVIDUAL"],
			[mapDeveloperType, "THIRD_PARTY"],
			[mapReviewStatus, "RELEASED"],
		] as const) {
			expect(map(recognized)).toBe(recognized);
			expect(map("UNRECOGNIZED")).toBeNull();
			expect(map(null)).toBeNull();
		}
		expect(mapConnectorType("SERVICE")).toBe("SERVICE");
		expect(mapConnectorType("UNRECOGNIZED")).toBe("MCP");
	});

	it("normalizes app status and disables private visibility", () => {
		expect(mapAppStatus(" enabled ")).toBe("ENABLED");
		expect(mapAppStatus("disabled")).toBe("DISABLED");
		expect(mapAppStatus("pending")).toBe("PENDING");
		expect(mapAppStatus(" only_me ")).toBe("DISABLED");
		for (const status of [null, undefined, "", "UNRECOGNIZED"]) {
			expect(mapAppStatus(status)).toBeNull();
		}
	});

	it("drops unknown auth types and preserves recognized types in order", () => {
		expect(mapAuthTypes(null)).toEqual([]);
		expect(mapAuthTypes([{ type: "UNRECOGNIZED" }])).toEqual([]);
		expect(
			mapAuthTypes([
				{ type: "OAUTH" },
				{ type: "UNRECOGNIZED" },
				{ type: "NONE" },
				{ type: "API_KEY" },
			]),
		).toEqual(["OAUTH", "NONE", "API_KEY"]);
	});
});

describe("catalog entry transformers", () => {
	it("maps an extension with no logo and selects its HTTP transport", () => {
		expect(
			transformClaudeEntry({
				id: "fictional-extension",
				icon_url: null,
				upload_date: null,
				is_allowlisted: true,
				manifest: {
					name: "fictional-tool",
					display_name: "Fictional Tool",
					description: "A sample tool",
					author: { name: "Example Studio", url: "https://studio.example" },
					server: {
						transport: [
							{ type: "stdio" },
							{ type: "sse", url: "https://tool.example/mcp" },
						],
					},
					privacy_policies: ["https://tool.example/privacy"],
				},
			}),
		).toMatchObject({
			source: "claude",
			sourceAppId: "fictional-extension",
			name: "Fictional Tool",
			baseUrl: "https://tool.example/mcp",
			logoUrl: null,
			developer: "Example Studio",
			website: "https://studio.example",
			privacyPolicy: "https://tool.example/privacy",
			developerType: "TRUSTED_PARTNER",
			reviewStatus: "RELEASED",
			rawData: null,
		});
		expect(
			transformClaudeEntry({
				id: "minimal",
				icon_url: null,
				upload_date: null,
				manifest: { name: "Minimal" },
			}),
		).toMatchObject({
			name: "Minimal",
			baseUrl: null,
			developerType: "THIRD_PARTY",
			reviewStatus: "PENDING",
		});
	});

	it("maps an apps entry with unknown category and missing logos", () => {
		expect(
			transformChatGPTAppsListEntry({
				id: "fictional-app",
				name: "Fictional App",
				branding: { category: "UNRECOGNIZED" },
				connector_type: "UNRECOGNIZED",
				distribution_channel: "UNRECOGNIZED",
				app_metadata: {
					developer: "Example Studio",
					review: { status: "UNRECOGNIZED" },
				},
				labels: {
					consequential: "true",
					retrievable: "true",
					interactive: "false",
				},
			}),
		).toMatchObject({
			source: "chatgpt",
			sourceAppId: "fictional-app",
			name: "Fictional App",
			category: null,
			connectorType: "MCP",
			distributionChannel: null,
			developer: "Example Studio",
			logoUrl: null,
			logoUrlDark: null,
			hasWrites: true,
			hasFileSearch: true,
			hasInteractive: false,
			reviewStatus: null,
			rawData: null,
		});
	});

	it("maps an action with unknown auth and missing logos", () => {
		expect(
			transformChatGPTActionsEntry({
				id: "fictional-link",
				connector_id: "fictional-connector",
				connector_name: "Fictional Actions",
				auth_type: "UNRECOGNIZED",
				actions: ["save"],
				connector_supports_full_actions: true,
			}),
		).toMatchObject({
			source: "chatgpt",
			sourceAppId: "fictional-connector",
			name: "Fictional Actions",
			authTypes: null,
			authRequired: undefined,
			logoUrl: null,
			logoUrlDark: null,
			hasWrites: true,
			supportsFullActions: true,
			rawData: null,
		});
	});

	it.each([
		["OAUTH", true],
		["API_KEY", true],
		["NONE", false],
	] as const)("maps %s action auth", (auth_type, authRequired) => {
		expect(
			transformChatGPTActionsEntry({
				id: "link",
				connector_id: "connector",
				auth_type,
			}),
		).toMatchObject({
			name: "connector",
			authTypes: [auth_type],
			authRequired,
			hasWrites: false,
		});
	});

	it("maps a minimal server with no logo", () => {
		expect(
			transformClaudeServerEntry({
				server: { name: "fictional-server", title: "Fictional Server" },
			}),
		).toMatchObject({
			source: "claude",
			sourceAppId: "fictional-server",
			name: "Fictional Server",
			logoUrl: null,
			baseUrl: null,
			developerType: "THIRD_PARTY",
			reviewStatus: "PENDING",
			authRequired: true,
			authTypes: null,
			rawData: null,
		});
	});

	it.each([
		["https://assets.example/icon.svg", "https://assets.example/icon.svg"],
		["data:image/png;base64,AA==", "data:image/png;base64,AA=="],
		[
			undefined,
			"https://www.google.com/s2/favicons?domain=studio.example&sz=128",
		],
	])("resolves server logo %s", (iconUrl, logoUrl) => {
		expect(
			transformClaudeServerEntry({
				server: {
					name: "fictional-server",
					remotes: [
						{ type: "streamable-http", url: "https://tool.example/mcp" },
					],
				},
				_meta: {
					"io.modelcontextprotocol.registry/official": { status: "active" },
					"com.anthropic.api/mcp-registry": {
						uuid: "fictional-id",
						displayName: "Fictional Tool",
						iconUrl,
						author: { url: "https://studio.example" },
						isAuthless: true,
						permissions: "Read and WRITE",
					},
				},
			}),
		).toMatchObject({
			sourceAppId: "fictional-id",
			name: "Fictional Tool",
			baseUrl: "https://tool.example/mcp",
			logoUrl,
			hasWrites: true,
			authTypes: ["NONE"],
			authRequired: false,
			developerType: "TRUSTED_PARTNER",
			reviewStatus: "RELEASED",
		});
	});
});

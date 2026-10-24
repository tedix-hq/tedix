import type { McpSkillEntry } from "@tedix/mcp-shared/skills";
import { MCP_SKILLS_EXTENSION } from "@tedix/mcp-shared/skills";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { McpClientManager } from "./client-manager";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

async function skill(name: string) {
	const uri = `skill://example/${name}/SKILL.md`;
	const text = `---\nname: ${name}\ndescription: Test guidance\n---\n\n# ${name}\n`;
	const bytes = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	const entry: McpSkillEntry = {
		uri,
		frontmatter: { name, description: "Test guidance" },
		resources: [
			{
				uri,
				size: bytes.byteLength,
				digest: `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
			},
		],
	};
	return { entry, text };
}

type Page = { skills: McpSkillEntry[]; nextCursor?: string };

function harness(mode: "sdk" | "stateless") {
	const manager = new McpClientManager();
	const requests: Array<{ method: string; params?: Record<string, unknown> }> =
		[];
	const extensions = { [MCP_SKILLS_EXTENSION]: {} };
	const state = {
		page: async (_cursor?: string): Promise<Page> => ({ skills: [] }),
		read: (_uri: string): unknown => ({ contents: [] }),
	};
	async function respond(
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> {
		requests.push({ method, params });
		switch (method) {
			case "server/discover":
				return {
					resultType: "complete",
					supportedVersions: ["2026-07-28"],
					capabilities: { extensions },
				};
			case "skills/list":
				return state.page(params?.cursor as string | undefined);
			case "resources/read":
				return state.read(String(params?.uri));
			case "tools/list":
				return { tools: [] };
			case "resources/list":
				return {
					resources: [{ uri: "https://example.com/manual", name: "manual" }],
				};
			case "resources/templates/list":
				return { resourceTemplates: [] };
			case "prompts/list":
				return { prompts: [] };
			default:
				throw new Error("Unexpected test MCP method");
		}
	}
	globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
		const request = JSON.parse(String(init?.body)) as {
			id: unknown;
			method: string;
			params?: Record<string, unknown>;
		};
		return Response.json({
			jsonrpc: "2.0",
			id: request.id,
			result: await respond(request.method, request.params),
		});
	}) as typeof fetch;
	const client = {
		getServerCapabilities: () => ({ resources: {}, tools: {}, prompts: {} }),
		listTools: () => respond("tools/list"),
		listResources: () => respond("resources/list"),
		listResourceTemplates: () => respond("resources/templates/list"),
		listPrompts: () => respond("prompts/list"),
		request: (request: { method: string; params?: Record<string, unknown> }) =>
			respond(request.method, request.params),
		readResource: ({ uri }: { uri: string }) =>
			respond("resources/read", { uri }),
	};
	(manager as unknown as { connections: Map<string, unknown> }).connections.set(
		"provider",
		{
			mode,
			config: {
				url: "https://provider.example/mcp",
				transport: "streamable-http",
			},
			info: { serverId: "provider", url: "https://provider.example/mcp" },
			tools: [],
			resources: [],
			skills: [],
			resourceTemplates: [],
			prompts: [],
			guidance: [],
			extensions,
			...(mode === "sdk" ? { client } : {}),
		},
	);
	return { manager, state, requests };
}

describe.each(["sdk", "stateless"] as const)(
	"MCP skill integrity through %s connections",
	(mode) => {
		it("publishes every index page and verifies both public read APIs", async () => {
			const first = await skill("first");
			const second = await skill("second");
			const { manager, state, requests } = harness(mode);
			state.page = async (cursor) =>
				cursor === undefined
					? { skills: [first.entry], nextCursor: "two" }
					: { skills: [second.entry] };
			state.read = (uri) => ({
				contents: [
					{ uri, text: uri === first.entry.uri ? first.text : second.text },
				],
			});
			await manager.refreshConnection("provider");
			expect(
				manager.listGuidanceResources("provider").map((entry) => entry.uri),
			).toEqual([first.entry.uri, second.entry.uri]);
			expect(
				requests
					.filter((request) => request.method === "skills/list")
					.map((request) => request.params?.cursor),
			).toEqual([undefined, "two"]);
			expect(await manager.readResource("provider", first.entry.uri)).toEqual({
				contents: [{ uri: first.entry.uri, text: first.text }],
			});
			expect(
				(await manager.readGuidance("provider", second.entry.uri)).text,
			).toContain("# second");
		});

		it("retains the complete previous manifest and guidance after a cursor loop", async () => {
			const prior = await skill("prior");
			const partial = await skill("partial");
			const { manager, state, requests } = harness(mode);
			state.page = async () => ({ skills: [prior.entry] });
			await manager.refreshConnection("provider");
			state.page = async () => ({
				skills: [partial.entry],
				nextCursor: "loop",
			});
			requests.length = 0;
			await manager.refreshConnection("provider");
			expect(
				requests.filter((request) => request.method === "skills/list"),
			).toHaveLength(2);
			expect(
				manager.listGuidanceResources("provider").map((entry) => entry.uri),
			).toEqual([prior.entry.uri]);
			state.read = (uri) => ({
				contents: [{ uri, text: prior.text.replace("# prior", "# other") }],
			});
			await expect(
				manager.readResource("provider", prior.entry.uri),
			).rejects.toThrow("digest");
		});

		it("does not retry tampered bytes over raw transport", async () => {
			const prior = await skill("prior");
			const { manager, state, requests } = harness(mode);
			state.page = async () => ({ skills: [prior.entry] });
			await manager.refreshConnection("provider");
			state.read = (uri) => ({
				contents: [{ uri, text: prior.text.replace("# prior", "# other") }],
			});
			requests.length = 0;
			await expect(
				manager.readGuidance("provider", prior.entry.uri),
			).rejects.toThrow("digest");
			expect(
				requests.filter((request) => request.method === "resources/read"),
			).toHaveLength(1);
		});

		it("rejects unlisted static resources before IO and preserves ordinary resources", async () => {
			const prior = await skill("prior");
			const { manager, state, requests } = harness(mode);
			state.page = async () => ({ skills: [prior.entry] });
			await manager.refreshConnection("provider");
			requests.length = 0;
			await expect(
				manager.readResource("provider", "skill://example/prior/private.md"),
			).rejects.toThrow("unlisted resource");
			expect(requests).toHaveLength(0);
			const ordinary = {
				contents: [
					{ uri: "https://example.com/manual", text: "ordinary" },
					{ uri: "https://example.com/appendix", text: "appendix" },
				],
			};
			state.read = () => ordinary;
			expect(
				await manager.readResource("provider", "https://example.com/manual"),
			).toEqual(ordinary);
		});

		it("keeps resource, guidance and integrity snapshots together while refresh awaits a page", async () => {
			const prior = await skill("prior");
			const next = await skill("next");
			const { manager, state } = harness(mode);
			state.page = async () => ({ skills: [prior.entry] });
			await manager.refreshConnection("provider");
			let release!: (page: Page) => void;
			let entered!: () => void;
			const pending = new Promise<Page>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			state.page = async () => {
				entered();
				return pending;
			};
			const refreshing = manager.refreshConnection("provider");
			await started;
			expect(
				manager
					.listResources("provider")
					.some((resource) => resource.uri === prior.entry.uri),
			).toBe(true);
			expect(
				manager.listGuidanceResources("provider").map((entry) => entry.uri),
			).toEqual([prior.entry.uri]);
			state.read = (uri) => ({
				contents: [{ uri, text: prior.text.replace("# prior", "# other") }],
			});
			await expect(
				manager.readResource("provider", prior.entry.uri),
			).rejects.toThrow("digest");
			release({ skills: [next.entry] });
			await refreshing;
			expect(
				manager.listGuidanceResources("provider").map((entry) => entry.uri),
			).toEqual([next.entry.uri]);
		});
	},
);

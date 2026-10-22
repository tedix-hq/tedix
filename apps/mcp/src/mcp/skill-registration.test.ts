import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { ApiClient } from "../lib/api-client";
import { StepBudgetExceededError } from "../lib/step-budget";
import type { ServerContext } from "./server-context";
import { registerAppSkills } from "./skill-registration";
import { __resetSkillSnapshotCache } from "./skill-snapshot-cache";

type ToolCall = {
	name: string;
	callback: (args: unknown) => Promise<unknown>;
};

type ResourceCall = {
	name: string;
	uri: unknown;
	metadata: Record<string, unknown>;
	callback: (...args: unknown[]) => Promise<unknown>;
};

type FakeServer = {
	server: { setRequestHandler: (...args: unknown[]) => void };
	registerTool: (
		name: string,
		config: Record<string, unknown>,
		callback: (args: unknown) => Promise<unknown>,
	) => { description?: string; update: (value: unknown) => void };
	registerResource: (
		name: string,
		uri: unknown,
		metadata: Record<string, unknown>,
		callback: (...args: unknown[]) => Promise<unknown>,
	) => object;
	setRequestHandler: (...args: unknown[]) => void;
	toolCalls: ToolCall[];
	resourceCalls: ResourceCall[];
	requestHandlers: unknown[][];
};

let agentSequence = 0;

function createFakeServer(): FakeServer {
	const toolCalls: ToolCall[] = [];
	const resourceCalls: ResourceCall[] = [];
	const requestHandlers: unknown[][] = [];
	const server: FakeServer = {
		server: {
			setRequestHandler(...args: unknown[]) {
				requestHandlers.push(args);
			},
		},
		toolCalls: [],
		resourceCalls: [],
		requestHandlers: [],
		registerTool(
			name: string,
			_config: Record<string, unknown>,
			callback: (args: unknown) => Promise<unknown>,
		) {
			toolCalls.push({ name, callback });
			return { description: "", update: vi.fn() };
		},
		registerResource(
			name: string,
			uri: unknown,
			metadata: Record<string, unknown>,
			callback: (...args: unknown[]) => Promise<unknown>,
		) {
			resourceCalls.push({ name, uri, metadata, callback });
			return {};
		},
		setRequestHandler(...args: unknown[]) {
			requestHandlers.push(args);
		},
	};
	server.toolCalls = toolCalls;
	server.resourceCalls = resourceCalls;
	server.requestHandlers = requestHandlers;
	return server;
}

function skill(id: string, files: Record<string, string> | null = null) {
	return {
		id,
		title: id,
		slug: id,
		summary: `${id} summary`,
		description: `${id} description`,
		content: `---\nname: ${id}\n---\n\n# ${id}`,
		files,
		tags: ["test"],
		toolIds: [],
		successCount: 0,
		revision: 1,
		appId: "app-test",
		audience: ["assistant"],
		r2Path: null,
		updatedAt: "2026-10-22T00:00:00.000Z",
		createdAt: "2026-10-21T00:00:00.000Z",
	};
}

function createAgent(
	server: FakeServer,
	listByApp: () => Promise<{ skills: unknown[] }>,
	options: { appId?: string; appSlug?: string } = {},
): ServerContext {
	return {
		server,
		appId: options.appId ?? "app-test",
		appSlug: options.appSlug ?? "sample-app",
		upstreamAppId: undefined,
		appMetadata: { mcpConfig: {} },
		callerIdentity: { organizationId: "org-test", tediId: "tedi-test" },
		apiClient: {
			skills: {
				listByApp,
				listByOrg: async () => ({ entries: [] }),
			},
		} as unknown as ApiClient,
		env: { GIT_SHA: `test-${agentSequence++}` },
		ctx: { waitUntil: (promise: Promise<unknown>) => void promise },
		loadedTools: new Map(),
		registeredTools: new Map(),
		registeredResources: new Map(),
		appToolIds: new Set(),
		appResourceIds: new Set(),
		toolSkillMap: new Map(),
	} as unknown as ServerContext;
}

beforeEach(() => {
	__resetSkillSnapshotCache();
});

afterEach(() => {
	__resetSkillSnapshotCache();
	vi.restoreAllMocks();
});

describe("registerAppSkills", () => {
	it("returns without an app or API client", async () => {
		const server = createFakeServer();
		const agent = createAgent(server, async () => ({ skills: [] }), {
			appId: undefined,
		});
		(agent as { apiClient?: unknown }).apiClient = undefined;

		await registerAppSkills(agent);

		expect(server.toolCalls).toHaveLength(0);
		expect(server.resourceCalls).toHaveLength(0);
		expect(server.requestHandlers).toHaveLength(0);
	});

	it("registers verb-first tools and ordered skill resources", async () => {
		const server = createFakeServer();
		const agent = createAgent(server, async () => ({
			skills: [
				skill("alpha", {
					"scripts/run.sh": "#!/bin/sh",
					"references/guide.md": "# Guide",
				}),
				skill("empty"),
			],
		}));

		await registerAppSkills(agent);

		expect(server.toolCalls.map((call) => call.name)).toEqual([
			"list_skills",
			"read_skill",
		]);
		const directResources = server.resourceCalls.filter(
			(call) => typeof call.uri === "string",
		);
		expect(directResources.map((resource) => resource.uri)).toEqual([
			"skill://sample-app/alpha/SKILL.md",
			"skill://sample-app/empty/SKILL.md",
		]);
		expect(directResources[0]?.metadata.mimeType).toBe("text/markdown");

		const directoryRead = (
			server as FakeServer & {
				tedixSkillDirectoryReadHandler: (input: { uri: string }) => {
					resources: Array<Record<string, unknown>>;
				};
			}
		).tedixSkillDirectoryReadHandler;
		expect(
			directoryRead({ uri: "skill://sample-app/alpha" }).resources,
		).toEqual([
			{
				uri: "skill://sample-app/alpha/SKILL.md",
				name: "SKILL.md",
				mimeType: "text/markdown",
			},
			{
				uri: "skill://sample-app/alpha/references",
				name: "references",
				mimeType: "inode/directory",
			},
			{
				uri: "skill://sample-app/alpha/scripts",
				name: "scripts",
				mimeType: "inode/directory",
			},
		]);
		expect(
			directoryRead({ uri: "skill://sample-app/alpha/references" }).resources,
		).toEqual([
			{
				uri: "skill://sample-app/alpha/references/guide.md",
				name: "guide.md",
				mimeType: "text/markdown",
			},
		]);
	});

	it("never renders more than eight skill digests concurrently", async () => {
		let inFlight = 0;
		let maximumInFlight = 0;
		vi.stubGlobal("crypto", {
			subtle: {
				digest: vi.fn(async () => {
					inFlight++;
					maximumInFlight = Math.max(maximumInFlight, inFlight);
					await Promise.resolve();
					inFlight--;
					return new ArrayBuffer(32);
				}),
			},
		});
		const server = createFakeServer();
		const skills = Array.from({ length: 20 }, (_, index) =>
			skill(`skill-${index}`),
		);

		await registerAppSkills(createAgent(server, async () => ({ skills })));

		expect(maximumInFlight).toBe(8);
	});

	it("degrades to the empty extension when the upstream skill list fails", async () => {
		const server = createFakeServer();
		const error = new StepBudgetExceededError("test", 1);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await registerAppSkills(
			createAgent(server, async () => {
				throw error;
			}),
		);

		expect(server.toolCalls).toHaveLength(0);
		expect(server.resourceCalls).toHaveLength(0);
		expect(server.requestHandlers).toHaveLength(2);
		expect(warn).toHaveBeenCalled();
	});
});

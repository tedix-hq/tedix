import { describe, expect, it } from "vite-plus/test";
import { MCP_STRUCTURED_CALL_META_KEY } from "@tedix/api-contract/schemas/mcp-native-transport";
import { TedixMcpRuntime } from "./runtime";
import type { McpToolInfo } from "./types";

const supported = {
	name: "code",
	meta: { [MCP_STRUCTURED_CALL_META_KEY]: { version: 1 } },
};
function fixture(
	tools: Pick<McpToolInfo, "name" | "meta">[],
	reply: (args: Record<string, unknown>) => unknown,
) {
	const calls: Array<{
		server: string;
		name: string;
		args: Record<string, unknown>;
		options: Record<string, unknown>;
	}> = [];
	const runtime = new TedixMcpRuntime({
		manager: {
			listConnections: () => [
				{ serverId: "tedix-unified" },
				{ serverId: "example-unified" },
			],
			listTools: (server: string) =>
				server === "example-unified" ? tools : [supported],
			callTool: async (
				server: string,
				name: string,
				args: Record<string, unknown>,
				options: Record<string, unknown>,
			) => {
				calls.push({ server, name, args, options });
				return reply(args);
			},
		} as never,
		platform: {
			listServers: async () => [],
			resolveCredentials: async () => ({ headers: {} }),
		},
	});
	runtime.ensureSynced = async () => {};
	const execute = () =>
		runtime.executeTool(
			"tedix_mcp_call_tool",
			{ callable: "work.list", args: { limit: 1 } },
			{
				resultAudience: "machine",
				binding: {
					conversationId: "conversation",
					runId: "run",
					embeddedSessionToken: "fictional-session",
				},
			},
		);
	return { runtime, calls, execute };
}
const response = {
	content: [],
	structuredContent: {
		executionId: "execution",
		result: { data: [1] },
		completionEvidence: { status: "succeeded" },
		actionReceipts: [{ verified: true }],
	},
};

describe("structured single-call routing", () => {
	it("uses the explicit selected-server capability and preserves the execution envelope", async () => {
		const native = fixture([supported], () => response);
		const legacy = fixture([{ name: "code" }], () => response);
		expect(await native.execute()).toEqual(await legacy.execute());
		expect(native.calls).toHaveLength(1);
		expect(native.calls[0]).toMatchObject({
			server: "example-unified",
			name: "code",
			args: { invocation: { callable: "work.list", args: { limit: 1 } } },
			options: { embeddedSessionToken: "fictional-session" },
		});
		expect(native.calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
		expect(native.calls[0]?.options.onTaskInputRequired).toBeTypeOf("function");
		expect(legacy.calls[0]?.args).toEqual({
			code: 'async () => await work.list({"limit":1})',
		});
	});
	it("never infers support from a different server", async () => {
		const f = fixture([{ name: "code" }], () => response);
		await f.execute();
		expect(f.calls[0]?.args).toHaveProperty("code");
	});
	it.each([
		{
			tools: [
				{
					name: "code",
					meta: { [MCP_STRUCTURED_CALL_META_KEY]: { version: 2 } },
				},
			],
		},
		{ tools: [{ ...supported, name: "other" }, { name: "code" }] },
		{ tools: [supported, { name: "code" }] },
	])(
		"rejects malformed or ambiguous capability before dispatch",
		async ({ tools }) => {
			const f = fixture(tools, () => response);
			await expect(f.execute()).rejects.toThrow();
			expect(f.calls).toHaveLength(0);
		},
	);
	it("does not repeat an invocation after authorization denial", async () => {
		const f = fixture([supported], () => ({
			isError: true,
			content: [{ type: "text", text: "Permission revoked" }],
		}));
		await expect(f.execute()).rejects.toThrow("Permission revoked");
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]?.args).toHaveProperty("invocation");
	});
	it("keeps authored code on the JavaScript path even when structured calls are supported", async () => {
		const f = fixture([supported], () => response);
		await f.runtime.executeTool(
			"tedix_mcp_code",
			{ code: "async () => 1" },
			{ resultAudience: "machine" },
		);
		expect(f.calls[0]?.args).toEqual({ code: "async () => 1" });
	});
});

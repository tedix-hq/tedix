import { describe, expect, test } from "vite-plus/test";
import {
	bindModernMcpRequest,
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_CLIENT_INFO_META_KEY,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_MODERN_PROTOCOL_VERSION,
} from "./protocol";

describe("bindModernMcpRequest", () => {
	test("binds method, target, and the protocol-owned metadata triplet", () => {
		const bound = bindModernMcpRequest(
			"tools/call",
			{
				name: "list_orders",
				_meta: {
					traceparent: "00-abc-def-01",
					[MCP_PROTOCOL_VERSION_META_KEY]: "forged",
				},
			},
			{
				clientName: "test-host",
				clientCapabilities: { extensions: { tasks: {} } },
			},
		);

		expect(bound.headers).toEqual({
			[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_PROTOCOL_VERSION,
			[MCP_METHOD_HEADER]: "tools/call",
			[MCP_NAME_HEADER]: "list_orders",
		});
		expect(bound.params._meta).toMatchObject({
			traceparent: "00-abc-def-01",
			[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
			[MCP_CLIENT_INFO_META_KEY]: { name: "test-host", version: "1.0.0" },
			[MCP_CLIENT_CAPABILITIES_META_KEY]: {
				extensions: { tasks: {} },
			},
		});
	});

	test("binds server discovery to its method without a name header", () => {
		const bound = bindModernMcpRequest(
			"server/discover",
			{},
			{ clientName: "test-host" },
		);

		expect(bound.headers).toEqual({
			[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_PROTOCOL_VERSION,
			[MCP_METHOD_HEADER]: "server/discover",
		});
	});

	test("binds skills/get to its skill URI", () => {
		const uri = "skill://tedix/deploy-worker/SKILL.md";
		const bound = bindModernMcpRequest(
			"skills/get",
			{ uri },
			{ clientName: "test-host" },
		);
		expect(bound.headers[MCP_NAME_HEADER]).toBe(uri);
	});

	test("binds a task method to its task id", () => {
		const bound = bindModernMcpRequest(
			"tasks/get",
			{ taskId: "task-1" },
			{ clientName: "test-host" },
		);
		expect(bound.headers[MCP_NAME_HEADER]).toBe("task-1");
	});
});

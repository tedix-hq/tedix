/**
 * A small MCP server over JSON-RPC so outside agents and the gateway call
 * into the workspace object with the same tools a chat turn has.
 */
import { BINDING_NAMES, describeBinding } from "./declarations";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_SERVER_INFO_META_KEY,
	isModernMcpRequest,
} from "@tedix/mcp-shared/protocol";

export interface McpHost {
	sendTurn(input: {
		actorId: string;
		actorKind: "user" | "tedi" | "external_agent" | "service";
		text: string;
		tediId?: string;
	}): Promise<{ turnId: string }>;
	awaitTurn(
		turnId: string,
		timeoutMs: number,
	): Promise<{
		status: "running" | "finished" | "failed" | "cancelled";
		text?: string;
		error?: string;
	}>;
	readChangeRecords(query: {
		afterSequence?: number;
		limit?: number;
	}): Promise<unknown[]>;
	readEvents(input: {
		conversationId?: string | null;
		after?: number;
		limit?: number;
	}): Promise<unknown[]>;
}

export const MCP_TOOLS = [
	{
		name: "send_turn",
		description:
			"Ask this workspace's agent a question or give it a task. Returns the answer when it finishes within the wait, otherwise a turn id to poll with read_turn.",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string" },
				tediId: {
					type: "string",
					description: "Run the turn as this tedi (guest), optional",
				},
				waitSeconds: { type: "number", default: 25 },
			},
			required: ["text"],
		},
	},
	{
		name: "read_turn",
		description: "Current status and final text of a turn started earlier.",
		inputSchema: {
			type: "object",
			properties: { turnId: { type: "string" } },
			required: ["turnId"],
		},
	},
	{
		name: "read_events",
		description:
			"Replay the workspace's event ledger after a sequence number: turn.started, assistant.delta, step.started/finished, approval.requested, turn.finished, each with its timestamp.",
		inputSchema: {
			type: "object",
			properties: {
				conversationId: { type: "string" },
				afterSeq: { type: "number", default: 0 },
				limit: { type: "number" },
			},
		},
	},
	{
		name: "read_change_records",
		description:
			"Change records of this workspace: what changed, who, decision, how to undo.",
		inputSchema: {
			type: "object",
			properties: {
				afterSequence: { type: "number" },
				limit: { type: "number" },
			},
		},
	},
	{
		name: "describe_binding",
		description: `TypeScript declaration of one sandbox binding: ${BINDING_NAMES.join(", ")}.`,
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
	},
] as const;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

const SERVER_INFO = { name: "tedix-workspace", version: "1" };

function result(request: JsonRpcRequest, value: Record<string, unknown>) {
	const meta = request.params?._meta;
	const modern = isRecord(meta) && isModernMcpRequest(meta);
	return {
		jsonrpc: "2.0",
		id: request.id ?? null,
		result: modern
			? {
					...value,
					resultType: "complete",
					_meta: { [MCP_SERVER_INFO_META_KEY]: SERVER_INFO },
				}
			: value,
	};
}

function failure(id: JsonRpcRequest["id"], code: number, message: string) {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textContent(value: unknown, isError = false) {
	return {
		content: [
			{
				type: "text",
				text:
					typeof value === "string" ? value : JSON.stringify(value, null, 1),
			},
		],
		isError,
	};
}

export async function handleMcpRequest(
	host: McpHost,
	caller: {
		actorId: string;
		actorKind: McpHost extends never
			? never
			: "user" | "tedi" | "external_agent" | "service";
	},
	body: unknown,
): Promise<unknown> {
	const request = body as JsonRpcRequest;
	if (
		!request ||
		request.jsonrpc !== "2.0" ||
		typeof request.method !== "string"
	)
		return failure(null, -32600, "Invalid request");
	switch (request.method) {
		case "server/discover":
			return result(request, {
				resultType: "complete",
				supportedVersions: [MCP_MODERN_PROTOCOL_VERSION, "2025-06-18"],
				capabilities: { tools: {} },
			});
		case "initialize":
			return result(request, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			});
		case "notifications/initialized":
		case "ping":
			return result(request, {});
		case "tools/list":
			return result(request, { tools: MCP_TOOLS });
		case "tools/call": {
			const name = String(request.params?.name ?? "");
			const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
			try {
				switch (name) {
					case "send_turn": {
						const { turnId } = await host.sendTurn({
							actorId: caller.actorId,
							actorKind: caller.actorKind,
							text: String(args.text ?? ""),
							...(typeof args.tediId === "string"
								? { tediId: args.tediId }
								: {}),
						});
						const wait = Math.min(
							Math.max(Number(args.waitSeconds ?? 25), 0),
							55,
						);
						const outcome = await host.awaitTurn(turnId, wait * 1000);
						return result(
							request,
							textContent({ turnId, ...outcome }, outcome.status === "failed"),
						);
					}
					case "read_turn":
						return result(
							request,
							textContent(await host.awaitTurn(String(args.turnId ?? ""), 0)),
						);
					case "read_change_records":
						return result(
							request,
							textContent(
								await host.readChangeRecords({
									...(typeof args.afterSequence === "number"
										? { afterSequence: args.afterSequence }
										: {}),
									...(typeof args.limit === "number"
										? { limit: args.limit }
										: {}),
								}),
							),
						);
					case "read_events":
						return result(
							request,
							textContent(
								await host.readEvents({
									...(typeof args.conversationId === "string"
										? { conversationId: args.conversationId }
										: {}),
									after: Number(args.afterSeq ?? 0),
									...(typeof args.limit === "number"
										? { limit: args.limit }
										: {}),
								}),
							),
						);
					case "describe_binding": {
						const declaration = describeBinding(String(args.name ?? ""));
						return result(
							request,
							textContent(
								declaration ?? "Unknown binding",
								declaration === null,
							),
						);
					}
					default:
						return failure(request.id, -32602, `Unknown tool ${name}`);
				}
			} catch (error) {
				return result(
					request,
					textContent(
						error instanceof Error ? error.message : String(error),
						true,
					),
				);
			}
		}
		default:
			return failure(request.id, -32601, `Method not found: ${request.method}`);
	}
}

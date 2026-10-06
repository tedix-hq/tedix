import * as z from "zod";
import {
	DURABLE_CODE_DELEGATION_HEADER,
	verifyDurableCodeDelegation,
	type DurableCodeOperation,
} from "@tedix/mcp-shared/auth/durable-code-delegation";
import {
	RunTediDurableCodeInputSchema,
	ListTediCodeExecutionsInputSchema,
	GetTediCodeExecutionInputSchema,
	RejectTediCodeExecutionInputSchema,
} from "@tedix/api-contract/schemas/tedi-durable-code";
import { requiredTediMcpToolScope } from "@tedix/mcp-shared/auth/scopes";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_CLIENT_INFO_META_KEY,
} from "@tedix/mcp-shared/protocol";
import type { TediMcpCaller } from "./mcp-authorization";

// The API relay supplies protocol attribution, not additional tool arguments
// or authority. The MCP transport still validates its header/body binding.
const protocolMetadata = z.strictObject({
	[MCP_PROTOCOL_VERSION_META_KEY]: z.literal(MCP_MODERN_PROTOCOL_VERSION),
	[MCP_CLIENT_CAPABILITIES_META_KEY]: z.strictObject({}),
	[MCP_CLIENT_INFO_META_KEY]: z
		.strictObject({
			name: z.string().min(1).max(256),
			version: z.string().min(1).max(256),
		})
		.optional(),
});

const execution = z.strictObject({
	execution_id: GetTediCodeExecutionInputSchema.shape.executionId,
});
const argumentsSchemas = {
	run_durable_code: RunTediDurableCodeInputSchema.omit({ tediId: true }),
	list_code_executions: ListTediCodeExecutionsInputSchema.omit({
		tediId: true,
	}),
	get_code_execution: execution,
	approve_code_execution: execution,
	reject_code_execution: execution.extend({
		seq: RejectTediCodeExecutionInputSchema.shape.seq,
	}),
	rollback_code_execution: execution,
	recover_code_execution: execution,
};

/** Provenance is accepted only after the named tedi binding established trust.
 * It narrows one request; it is neither a bearer credential nor a replay grant. */
export async function resolveDurableCodeDelegation(input: {
	request: Request;
	trustedServiceBinding: boolean;
	tediId: string;
	organizationId: string;
	now: number;
}): Promise<
	| { kind: "absent" }
	| { kind: "denied"; reason: string }
	| { kind: "verified"; caller: TediMcpCaller; canManage: boolean }
> {
	const encoded = input.request.headers.get(DURABLE_CODE_DELEGATION_HEADER);
	if (encoded === null) return { kind: "absent" };
	if (!input.trustedServiceBinding)
		return { kind: "denied", reason: "untrusted_transport" };
	try {
		const body = z
			.strictObject({
				jsonrpc: z.literal("2.0"),
				id: z.union([z.string(), z.number()]),
				method: z.literal("tools/call"),
				params: z.strictObject({
					name: z.string(),
					arguments: z.unknown(),
					_meta: protocolMetadata.optional(),
				}),
			})
			.parse(await input.request.clone().json());
		if (!Object.hasOwn(argumentsSchemas, body.params.name))
			return { kind: "denied", reason: "invalid_operation" };
		const operation = body.params.name as DurableCodeOperation;
		const args = argumentsSchemas[operation].parse(body.params.arguments);
		const verified = await verifyDurableCodeDelegation({
			transport: "trusted-service-binding",
			envelope: JSON.parse(encoded),
			tediId: input.tediId,
			organizationId: input.organizationId,
			operation,
			arguments: args,
			now: input.now,
		});
		if (!verified.ok) return { kind: "denied", reason: verified.reason };
		const operator = verified.delegation.operator;
		const canManage =
			operator.classification === "human" &&
			verified.delegation.capability === "mcp:tedis.admin";
		return {
			kind: "verified",
			canManage,
			caller: {
				method: "service",
				principalType:
					operator.classification === "human"
						? "user"
						: operator.classification === "tedi"
							? "tedi"
							: operator.classification === "api-key"
								? "api_key"
								: "client",
				principalId: operator.subject,
				delegatedToolName: operation,
				scopes: [requiredTediMcpToolScope(operation)],
			},
		};
	} catch {
		return { kind: "denied", reason: "invalid_request" };
	}
}

/** Recovery cannot borrow direct JWT/API-key or generic binding management. */
export function canRecoverDurableCode(
	delegation: Awaited<ReturnType<typeof resolveDurableCodeDelegation>>,
): boolean {
	return (
		delegation.kind === "verified" &&
		delegation.canManage &&
		delegation.caller.principalType === "user" &&
		delegation.caller.delegatedToolName === "recover_code_execution"
	);
}

/** Overwrite untrusted copies on every edge hop, including denied callers. */
export function applyDurableCodeRecoveryAuthority(
	headers: Headers,
	delegation: Awaited<ReturnType<typeof resolveDurableCodeDelegation>>,
): void {
	headers.set(
		"X-Tedix-Auth-Can-Recover-Durable-Code",
		String(canRecoverDurableCode(delegation)),
	);
}

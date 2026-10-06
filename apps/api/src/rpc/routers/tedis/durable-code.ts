import type * as z from "zod";
import {
	TediDurableCodeOutputSchema,
	ListTediCodeExecutionsOutputSchema,
	GetTediCodeExecutionOutputSchema,
	RejectTediCodeExecutionOutputSchema,
	RollbackTediCodeExecutionOutputSchema,
	RecoverTediCodeExecutionOutputSchema,
} from "@tedix/api-contract/schemas/tedi-durable-code";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { buildRuntimeUrl } from "@tedix/db/utils/tedi-routing";
import {
	createDurableCodeDelegation,
	createMachineDurableCodeDelegation,
	type DurableCodeCaller,
	DURABLE_CODE_DELEGATION_HEADER,
	requiredDurableCodeCapability,
	type DurableCodeOperation,
} from "@tedix/mcp-shared/auth/durable-code-delegation";
import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import { bindModernMcpRequest } from "@tedix/mcp-shared/protocol";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { requireOrgId } from "../../org-scope";
import {
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "./helpers";

/** Classifications use authenticated fields populated by withAuth, never JWT shape alone. */
function durableCodeCaller(
	context: BaseContext,
	organizationId: string,
): DurableCodeCaller {
	const principal = {
		authenticated: true,
		verified: true,
		orgId: organizationId,
		audiences: [] as string[],
		scopes: [] as string[],
	};
	const trusted = isServiceBinding(context.headers);
	const callerType = context.headers.get("X-Tedix-Caller-Type");
	if (
		context.authType === "user" &&
		trusted &&
		callerType === "mcp-edge-user" &&
		!context.externalAgentPrincipalId &&
		!context.tediId &&
		context.user?.sub &&
		context.user.email
	) {
		const value = context.user.scopes;
		const scopes = Array.isArray(value)
			? value.filter((scope): scope is string => typeof scope === "string")
			: [];
		if (typeof context.user.scope === "string")
			scopes.push(...context.user.scope.split(/\s+/).filter(Boolean));
		return {
			classification: "human",
			principal: {
				...principal,
				source: "aih-oauth",
				subject: context.user.sub,
				email: context.user.email,
				scopes,
			},
		};
	}
	if (
		context.authType === "service-binding" &&
		trusted &&
		callerType === "mcp-edge-external-agent" &&
		context.externalAgentPrincipalId &&
		context.externalAgentSessionId &&
		context.externalAgentClientRecordId
	)
		return {
			classification: "external-agent",
			principal: {
				...principal,
				source: "service-binding",
				subject: context.externalAgentPrincipalId,
				clientId: context.externalAgentClientRecordId,
				scopes: context.tediScopes ?? [],
			},
		};
	if (
		(context.authType === "tedi" ||
			(context.authType === "service-binding" && trusted)) &&
		context.tediId &&
		!context.externalAgentPrincipalId
	)
		return {
			classification: "tedi",
			principal: {
				...principal,
				source: context.authType === "tedi" ? "tedi-jwt" : "service-binding",
				subject: context.tediId,
				tediId: context.tediId,
				scopes: context.tediScopes ?? [],
			},
		};
	if (
		context.authType === "apikey" &&
		context.apiKey?.id &&
		context.apiKey.organizationId === organizationId
	)
		return {
			classification: "api-key",
			principal: {
				...principal,
				source: "api-key",
				subject: context.apiKey.id,
				scopes: context.apiKey.scopes ?? [],
			},
		};
	if (context.authType === "m2m" && context.serviceAccount?.clientId)
		return {
			classification: "m2m",
			principal: {
				...principal,
				source: "aih-m2m",
				subject:
					context.serviceAccount.canonicalPrincipalId ??
					context.serviceAccount.clientId,
				clientId: context.serviceAccount.clientId,
				scopes:
					context.serviceAccount.scope?.split(/\s+/).filter(Boolean) ?? [],
			},
		};
	if (
		context.authType === "service-binding" &&
		trusted &&
		context.serviceAccount?.clientId &&
		!context.externalAgentPrincipalId &&
		!context.tediId
	)
		return {
			classification: "service",
			principal: {
				...principal,
				source: "service-binding",
				subject:
					context.serviceAccount.canonicalPrincipalId ??
					context.serviceAccount.clientId,
				clientId: context.serviceAccount.clientId,
				scopes: context.tediScopes ?? [],
			},
		};
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Verified durable code caller required",
	);
}

export async function dispatchTediDurableCode(
	context: BaseContext,
	tediId: string,
	operation: DurableCodeOperation,
	args: JsonValue,
): Promise<unknown> {
	const organizationId = requireOrgId(context);
	const capability = requiredDurableCodeCapability(operation);
	const caller = durableCodeCaller(context, organizationId);
	if (
		!hasScope(caller.principal.scopes, capability) ||
		(capability === "mcp:tedis.admin" && caller.classification !== "human")
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Durable code operation permission required",
		);
	if (caller.classification === "human") {
		const member = await getMemberByUserId(
			context.db,
			organizationId,
			caller.principal.subject!,
		);
		if (member?.status !== "active")
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Active organization membership required",
			);
	}
	const tedi = await getTediByIdForOrganization(
		context.db,
		tediId,
		organizationId,
	);
	if (!tedi)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Tedi not found in the selected organization",
		);
	const runtimeUrl = buildRuntimeUrl(tedi);
	if (!runtimeUrl || !context.env.TEDI_SERVICE)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Tedi runtime binding unavailable",
		);
	const createDelegation =
		caller.classification === "human"
			? createDurableCodeDelegation
			: createMachineDurableCodeDelegation;
	const delegation = await createDelegation({
		tediId,
		organizationId,
		operation,
		arguments: args,
		now: Date.now(),
		caller,
	});
	let response: Response;
	const request = bindModernMcpRequest(
		"tools/call",
		{ name: operation, arguments: args },
		{ clientName: "tedix-api-durable-code" },
	);
	try {
		response = await context.env.TEDI_SERVICE.fetch(`${runtimeUrl}/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"X-Service-Binding": "true",
				"X-Tedix-Host": new URL(runtimeUrl).hostname,
				...request.headers,
				[DURABLE_CODE_DELEGATION_HEADER]: JSON.stringify(delegation),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: request.params,
			}),
		});
	} catch {
		throw createError(ErrorCodes.BAD_GATEWAY, "Tedi runtime request failed");
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Tedi runtime returned an invalid response",
		);
	}
	if (
		!response.ok ||
		!isRecord(payload) ||
		payload.id !== 1 ||
		payload.error ||
		!isRecord(payload.result) ||
		payload.result.isError === true
	) {
		const details = [`HTTP ${response.status}`];
		const phase = !response.ok
			? "http_rejected"
			: isRecord(payload) && payload.error
				? "rpc_error"
				: isRecord(payload) && payload.id !== 1
					? "id_mismatch"
					: isRecord(payload) &&
						  isRecord(payload.result) &&
						  payload.result.isError === true
						? "tool_error"
						: "invalid_result";
		details.push(phase);
		if (
			phase === "tool_error" &&
			isRecord(payload) &&
			isRecord(payload.result)
		) {
			const content = payload.result.content;
			if (
				Array.isArray(content) &&
				content.length === 1 &&
				isRecord(content[0]) &&
				content[0].type === "text" &&
				typeof content[0].text === "string" &&
				content[0].text.length <= 1024
			) {
				const text = content[0].text.startsWith("Error: ")
					? content[0].text.slice(7)
					: content[0].text;
				const classification = text.startsWith(
					'Invalid codemode runtime name "',
				)
					? "runtime_name_invalid"
					: text.startsWith(
								"CodemodeRuntime is not exported from this Worker entry.",
						  )
						? "runtime_export_missing"
						: text === "LOADER binding unavailable for durable Code Mode"
							? "loader_unavailable"
							: text === "MCP runtime unavailable" ||
								  text === "MCP runtime unavailable for durable Code Mode"
								? "mcp_unavailable"
								: null;
				if (classification) details.push(classification);
			}
		}
		if (
			isRecord(payload) &&
			isRecord(payload.error) &&
			typeof payload.error.code === "number" &&
			Number.isSafeInteger(payload.error.code)
		)
			details.push(`RPC ${payload.error.code}`);
		if (
			isRecord(payload) &&
			payload.error === "durable_code_delegation_invalid" &&
			typeof payload.reason === "string" &&
			[
				"untrusted_transport",
				"invalid_envelope",
				"invalid_time",
				"binding_mismatch",
				"invalid_request",
				"invalid_operation",
			].includes(payload.reason)
		)
			details.push(payload.reason);
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			`Tedi runtime declined the durable code operation (${details.join(", ")})`,
		);
	}
	if (payload.result.structuredContent !== undefined)
		return payload.result.structuredContent;
	const content = payload.result.content;
	if (
		Array.isArray(content) &&
		content.length === 1 &&
		isRecord(content[0]) &&
		content[0].type === "text" &&
		typeof content[0].text === "string"
	) {
		try {
			return JSON.parse(content[0].text);
		} catch {
			/* invalid projection */
		}
	}
	throw createError(
		ErrorCodes.BAD_GATEWAY,
		"Tedi runtime returned no structured projection",
	);
}

function projectDurableCode<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Tedi runtime returned an invalid durable code projection",
		);
	return parsed.data;
}

export const runTediDurableCode = authedTedisOs.runTediDurableCode
	.use(withAuthorization("tedis:update", "mcp:tedis.write"))
	.handler(async ({ input, context }) =>
		projectDurableCode(
			TediDurableCodeOutputSchema,
			await dispatchTediDurableCode(context, input.tediId, "run_durable_code", {
				code: input.code,
			}),
		),
	);
export const listTediCodeExecutions = authedTedisOs.listTediCodeExecutions
	.use(withAuthorization("tedis:read", "mcp:tedis.read"))
	.handler(async ({ input, context }) =>
		projectDurableCode(
			ListTediCodeExecutionsOutputSchema,
			await dispatchTediDurableCode(
				context,
				input.tediId,
				"list_code_executions",
				{ limit: input.limit },
			),
		),
	);
export const getTediCodeExecution = authedTedisOs.getTediCodeExecution
	.use(withAuthorization("tedis:read", "mcp:tedis.read"))
	.handler(async ({ input, context }) =>
		projectDurableCode(
			GetTediCodeExecutionOutputSchema,
			await dispatchTediDurableCode(
				context,
				input.tediId,
				"get_code_execution",
				{ execution_id: input.executionId },
			),
		),
	);
export const approveTediCodeExecution = authedTedisOs.approveTediCodeExecution
	.use(withAuthorization("tedis:update", "mcp:tedis.admin"))
	.handler(async ({ input, context }) =>
		projectDurableCode(
			TediDurableCodeOutputSchema,
			await dispatchTediDurableCode(
				context,
				input.tediId,
				"approve_code_execution",
				{ execution_id: input.executionId },
			),
		),
	);
export const rejectTediCodeExecution = authedTedisOs.rejectTediCodeExecution
	.use(withAuthorization("tedis:update", "mcp:tedis.admin"))
	.handler(async ({ input, context }) =>
		projectDurableCode(
			RejectTediCodeExecutionOutputSchema,
			await dispatchTediDurableCode(
				context,
				input.tediId,
				"reject_code_execution",
				{ execution_id: input.executionId, seq: input.seq },
			),
		),
	);
export const rollbackTediCodeExecution = authedTedisOs.rollbackTediCodeExecution
	.use(withAuthorization("tedis:update", "mcp:tedis.admin"))
	.handler(async ({ input, context }) =>
		projectDurableCode(
			RollbackTediCodeExecutionOutputSchema,
			await dispatchTediDurableCode(
				context,
				input.tediId,
				"rollback_code_execution",
				{ execution_id: input.executionId },
			),
		),
	);

export const recoverTediCodeExecution = authedTedisOs.recoverTediCodeExecution
	.use(withAuthorization("tedis:update", "mcp:tedis.admin"))
	.handler(async ({ input, context }) =>
		projectDurableCode(
			RecoverTediCodeExecutionOutputSchema,
			await dispatchTediDurableCode(
				context,
				input.tediId,
				"recover_code_execution",
				{ execution_id: input.executionId },
			),
		),
	);

import { type ToolConfig } from "@tedix/api-contract/schemas/tools";
import { isCodeModeAvailable } from "@tedix/mcp-shared/codemode";
import { withModelAuthoredCodeIsolation } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { getByPath } from "./handlers/path-utils";
import type { ToolExecutionContext, RpcToolResult } from "./handler";

export async function executeCodeTransport(
	input: Record<string, unknown>,
	ctx: ToolExecutionContext<ToolConfig>,
	config: ToolConfig,
): Promise<RpcToolResult> {
	if (!config.codeModule) {
		return {
			data: { error: "codeModule is required for code transport" },
			status: 400,
		};
	}

	if (!isCodeModeAvailable(ctx.env)) {
		return {
			data: {
				error: "Code transport requires LOADER binding (Dynamic Workers)",
			},
			status: 501,
		};
	}

	const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
	// Loader binding is a WorkerLoader (internal codemode type, not exported)
	const loader = ctx.env.LOADER as any;
	const timeout = config.timeout ?? 30_000;

	const executor = new DynamicWorkerExecutor({
		loader: withModelAuthoredCodeIsolation(loader, {
			surface: "stored_tool_code",
			reason: "stored_tool_authored_invocation",
		}),
		timeout,
		globalOutbound: null, // Network-isolated sandbox
	});
	const startTime = Date.now();

	// Wrap stored code to receive `args` and return a result
	const wrappedCode = `
const args = ${JSON.stringify(input)};
const __mod = (() => {
	${config.codeModule}
})();
const __fn = typeof __mod === "function" ? __mod
	: __mod && typeof __mod.default === "function" ? __mod.default
	: null;
return __fn ? await __fn(args) : __mod;
`;

	try {
		// Empty providers — code transport tools run standalone JS, not Code Mode with tool namespaces
		const result = await executor.execute(wrappedCode, []);

		// Emit structured log for Tail Worker
		console.log(
			JSON.stringify({
				_cm: "exec",
				appId: ctx.appId,
				appSlug: ctx.app.slug,
				orgId: ctx.app.organizationId ?? "",
				organizationId: ctx.app.organizationId ?? "",
				userId: ctx.callerIdentity?.userId ?? "",
				tediId: ctx.callerIdentity?.tediId ?? "",
				authType: ctx.callerIdentity?.authType ?? "anonymous",
				executionId: ctx.executionId ?? ctx.requestId,
				traceId: ctx.traceId ?? ctx.requestId,
				toolCount: 0, // code transport doesn't use providers
				namespaceCount: 0,
				totalDurationMs: Date.now() - startTime,
				codeLength: config.codeModule.length,
				success: !result.error,
				transport: "code",
				toolId: ctx.toolId,
				...(result.error && { error: String(result.error).slice(0, 200) }),
			}),
		);

		if (result.error) {
			return {
				data: {
					error: `Code execution failed: ${String(result.error).slice(0, 500)}`,
				},
				status: 500,
			};
		}

		let data: unknown = result.result;

		// Extract via responsePath if configured
		if (config.responsePath && data != null && typeof data === "object") {
			data = getByPath(data, config.responsePath) ?? data;
		}

		return { data, status: 200 };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(
			JSON.stringify({
				_cm: "exec",
				appId: ctx.appId,
				appSlug: ctx.app.slug,
				orgId: ctx.app.organizationId ?? "",
				organizationId: ctx.app.organizationId ?? "",
				userId: ctx.callerIdentity?.userId ?? "",
				tediId: ctx.callerIdentity?.tediId ?? "",
				authType: ctx.callerIdentity?.authType ?? "anonymous",
				executionId: ctx.executionId ?? ctx.requestId,
				traceId: ctx.traceId ?? ctx.requestId,
				toolCount: 0,
				namespaceCount: 0,
				totalDurationMs: Date.now() - startTime,
				codeLength: config.codeModule.length,
				success: false,
				transport: "code",
				toolId: ctx.toolId,
				error: message.slice(0, 200),
			}),
		);
		return {
			data: { error: `Code transport failed: ${message}` },
			status: 500,
		};
	}
}

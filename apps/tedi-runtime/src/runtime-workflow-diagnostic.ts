import { createDbClient } from "@tedix/db/client";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	buildRuntimeWorkflowInstanceId,
	buildRuntimeRunId,
	buildTediConversationId,
	parseRuntimeRunSurface,
} from "@tedix/api-contract/utils/runtime-identity";

/** Reserved virtual artifact; never accepts an arbitrary native instance id. */
export function runtimeWorkflowDiagnosticRunId(path: unknown): string | null {
	if (typeof path !== "string" || !path.startsWith("runtime-workflows/"))
		return null;
	const match =
		/^runtime-workflows\/([A-Za-z0-9:._-]{1,512})\/status\.json$/.exec(path);
	if (!match || match[1]!.split(":").length !== 3)
		throw new Error("RUNTIME_WORKFLOW_DIAGNOSTIC_PATH_INVALID");
	return match[1]!;
}

export async function readOwnedRuntimeWorkflow(input: {
	runId: string;
	tediId: string;
	orgId: string;
	agentName: string;
	env: Pick<Cloudflare.Env, "DB" | "CHAT_TURN_WORKFLOW" | "GIT_SHA">;
	storage: Pick<DurableObjectStorage, "get">;
}) {
	if (
		!input.tediId ||
		!input.orgId ||
		!input.runId.startsWith(`${input.tediId}:`)
	)
		throw new Error("RUNTIME_WORKFLOW_OWNER_MISMATCH");
	const db = createDbClient(input.env.DB);
	let owner;
	try {
		owner = await getTediByIdForOrganization(db, input.tediId, input.orgId);
	} catch {
		throw new Error("RUNTIME_WORKFLOW_OWNER_READ_UNAVAILABLE");
	}
	if (!owner) throw new Error("RUNTIME_WORKFLOW_OWNER_MISMATCH");
	const bindingConfigured =
		typeof input.env.CHAT_TURN_WORKFLOW?.get === "function";
	const base = {
		ok: true,
		source: "owned-runtime-workflow",
		version: 1,
		tediId: input.tediId,
		runId: input.runId,
		runtimeSource: String(input.env.GIT_SHA || "unknown"),
		binding: "CHAT_TURN_WORKFLOW",
		bindingConfigured,
	};
	const unavailable = (errorCode: string) => ({
		...base,
		status: "not_available",
		association: "unverified",
		nativeWorkflowId: null,
		errorCode,
	});
	let record: unknown;
	try {
		record = await input.storage.get(
			`runtime-admission-workflow:${input.runId}`,
		);
	} catch {
		return unavailable("RUN_ASSOCIATION_READ_UNAVAILABLE");
	}
	if (!isRecord(record) || !isRecord(record.params))
		return unavailable("RUN_ASSOCIATION_MISSING");
	const params = record.params;
	try {
		if (
			params.runId !== input.runId ||
			params.agentName !== input.agentName ||
			typeof params.clientRequestId !== "string" ||
			!params.clientRequestId ||
			params.clientRequestId.length > 512 ||
			buildRuntimeRunId({
				tediId: input.tediId,
				turnKey: params.clientRequestId,
				surface: parseRuntimeRunSurface(input.runId),
			}) !== input.runId ||
			typeof params.sessionKey !== "string" ||
			!params.sessionKey ||
			params.conversationId !==
				buildTediConversationId({
					tediRef: owner.slug || input.tediId,
					sessionKey: params.sessionKey,
				}) ||
			typeof record.id !== "string" ||
			record.id !== buildRuntimeWorkflowInstanceId(params.clientRequestId)
		)
			return unavailable("RUN_ASSOCIATION_MISMATCH");
	} catch {
		return unavailable("RUN_ASSOCIATION_MISMATCH");
	}
	const associated = {
		...base,
		association: "verified",
		nativeWorkflowId: record.id,
		dispatchStage: ["dispatching", "dispatched", "uncertain"].includes(
			String(record.stage),
		)
			? record.stage
			: null,
	};
	if (!bindingConfigured)
		return {
			...associated,
			status: "not_available",
			errorCode: "NATIVE_BINDING_UNAVAILABLE",
		};
	try {
		const instance = await input.env.CHAT_TURN_WORKFLOW.get(record.id);
		const observation = await instance.status();
		const status = observation.status;
		if (
			![
				"queued",
				"running",
				"waiting",
				"paused",
				"complete",
				"errored",
				"terminated",
			].includes(status)
		)
			return {
				...associated,
				status: "not_available",
				errorCode: "NATIVE_STATUS_UNKNOWN",
			};
		return {
			...associated,
			status:
				status === "complete"
					? "completed"
					: status === "errored"
						? "failed"
						: status === "terminated"
							? "canceled"
							: status,
			nativeStatus: status,
			errorCode: status === "errored" ? "NATIVE_WORKFLOW_FAILED" : null,
		};
	} catch (error) {
		const missing = isRecord(error) && error.status === 404;
		return {
			...associated,
			status: missing ? "missing" : "not_available",
			errorCode: missing
				? "NATIVE_INSTANCE_MISSING"
				: "NATIVE_STATUS_READ_UNAVAILABLE",
		};
	}
}

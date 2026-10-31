import {
	SkillWorkflowStepTediActivitySchema,
	SkillWorkflowTediTaskReferenceSchema,
	SkillWorkflowTediTaskSigningPayloadSchema,
	WORKFLOW_TEDI_TASK_SIGNATURE_CONTEXT,
} from "@tedix/api-contract/schemas/cognitive";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	isTediConversationDeleted,
	listTediRuntimeEventsForRouter,
} from "@tedix/db/queries/cognitive-runtime";
import { runEventsToTaskState } from "@tedix/mcp-shared/tasks";
import {
	deriveHkdfHmacKey,
	hmacSha256,
	timingSafeEqual,
} from "@tedix/worker-kit/crypto";
import type { z } from "zod";
import type { BaseContext } from "../rpc/orpc";
import { requireTediAccess } from "../rpc/tedi-access";

type Activity = z.infer<typeof SkillWorkflowStepTediActivitySchema>;
const EVENT_LIMIT = 200;
const RESULT_LIMIT = 16_000;
const ACTION_KINDS = new Set([
	"tool.started",
	"tool.completed",
	"tool.failed",
	"subagent.started",
	"subagent.completed",
	"subagent.failed",
]);

export function unavailableTediActivity(
	reason: string,
	redacted = false,
): Activity {
	return {
		status: redacted ? "redacted" : "unavailable",
		reason,
		actions: [],
		finalResult: { status: redacted ? "redacted" : "unavailable" },
		truncated: false,
	};
}

function redacted(value: unknown, depth = 0): boolean {
	if (depth > 20) return true;
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value))
		return value.some((item) => redacted(item, depth + 1));
	const record = value as Record<string, unknown>;
	if (
		record.redacted === true ||
		record.sensitiveOutput === true ||
		record.sensitive === "output"
	)
		return true;
	return Object.values(record).some((item) => redacted(item, depth + 1));
}

function boundedId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 512
		? value
		: undefined;
}

export async function readWorkflowStepTediActivity(
	context: BaseContext,
	input: {
		organizationId: string;
		runId: string;
		tediId: string;
		executionEpoch: number;
		path: string;
		attempt: number;
	},
	receipt: unknown,
	parentReceipt: unknown,
): Promise<Activity> {
	if (!isRecord(receipt))
		return unavailableTediActivity("The recorded call receipt is unavailable.");
	if (redacted(receipt) || redacted(parentReceipt))
		return unavailableTediActivity("This step's activity is redacted.", true);
	const parsed = SkillWorkflowTediTaskReferenceSchema.safeParse(
		receipt.tediTaskReference,
	);
	if (!parsed.success)
		return unavailableTediActivity(
			"This call has no verified canonical tedi task link. Historical conversation activity is unavailable.",
		);
	const ref = parsed.data;
	const coordinates =
		/^epochs\/(0|[1-9]\d*)\/steps\/([^/]+)\/([1-9]\d*)\/attempts\/([1-9]\d*)\/calls\/(run|rollback)\/([1-9]\d*)\.json$/.exec(
			input.path,
		);
	let stepName: string | undefined;
	try {
		const segment = coordinates?.[2];
		stepName = segment
			? decodeURIComponent(
					segment.startsWith("x:") ? segment.slice(2) : segment,
				)
			: undefined;
	} catch {
		/* Invalid encoded paths cannot correlate. */
	}
	const step = isRecord(receipt.step) ? receipt.step : {};
	if (
		!coordinates ||
		ref.organizationId !== input.organizationId ||
		ref.workflowRunId !== input.runId ||
		ref.tediId !== input.tediId ||
		ref.executionEpoch !== input.executionEpoch ||
		Number(coordinates[1]) !== input.executionEpoch ||
		Number(coordinates[3]) !== ref.receiptStepCount ||
		Number(coordinates[4]) !== input.attempt ||
		ref.attempt !== input.attempt ||
		receipt.attempt !== input.attempt ||
		ref.phase !== coordinates[5] ||
		receipt.phase !== ref.phase ||
		ref.ordinal !== Number(coordinates[6]) ||
		receipt.ordinal !== ref.ordinal ||
		ref.stepName !== stepName ||
		step.name !== ref.stepName ||
		step.count !== ref.stepCount ||
		step.id !== ref.stepId ||
		receipt.callId !== ref.callId ||
		receipt.executionEpoch !== ref.executionEpoch ||
		receipt.kind !== "workflow_mcp_call" ||
		receipt.namespace !== "tedi" ||
		receipt.method !== "run_tedi_turn" ||
		(ref.taskId.startsWith("tedi:")
			? ref.taskId !== `tedi:${ref.tediId}:${ref.runId}`
			: ref.taskId !== ref.runId)
	) {
		return unavailableTediActivity(
			"The recorded task link does not match this step, attempt and execution epoch.",
		);
	}
	const { signature, ...unsigned } = ref;
	if (!context.env.PLATFORM_SERVICE_TOKEN)
		return unavailableTediActivity(
			"The recorded task link cannot be verified.",
		);
	const digest = await hmacSha256(
		await deriveHkdfHmacKey(
			context.env.PLATFORM_SERVICE_TOKEN,
			WORKFLOW_TEDI_TASK_SIGNATURE_CONTEXT,
		),
		JSON.stringify(SkillWorkflowTediTaskSigningPayloadSchema.parse(unsigned)),
	);
	const expected = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	if (!timingSafeEqual(signature, expected))
		return unavailableTediActivity(
			"The recorded task link cannot be verified.",
		);

	const tedi = await requireTediAccess(context, ref.tediId, {
		scope: "principal",
		tediIdentity: "self-or-platform",
		platformAuthority: "none",
	});
	if (tedi.organizationId !== input.organizationId)
		return unavailableTediActivity("The linked task is unavailable.");
	// Read exactly one canonical run. Dispatch aliases and conversation history
	// are intentionally not expanded into evidence for this selected call.
	const rows = await listTediRuntimeEventsForRouter(context.db, {
		tediId: ref.tediId,
		runId: ref.runId,
		order: "desc",
		limit: EVENT_LIMIT + 1,
	});
	if (!rows.length)
		return unavailableTediActivity(
			"No canonical activity is recorded for the linked run.",
		);
	if (rows.some((row) => row.tediId !== ref.tediId || row.runId !== ref.runId))
		return unavailableTediActivity(
			"The canonical activity does not match the linked run.",
		);
	const conversations = [
		...new Set(
			rows
				.map((row) => row.conversationId)
				.filter((id): id is string => Boolean(id)),
		),
	];
	if (conversations.length !== 1)
		return unavailableTediActivity(
			"The canonical run has no unambiguous recorded conversation.",
		);
	if (
		await isTediConversationDeleted(context.db, {
			organizationId: input.organizationId,
			tediId: ref.tediId,
			conversationId: conversations[0]!,
		})
	)
		return unavailableTediActivity("The linked run is unavailable.");
	const truncated = rows.length > EVENT_LIMIT;
	const events = rows.slice(0, EVENT_LIMIT).reverse();
	const state = runEventsToTaskState(
		ref.runId,
		events.map((event) => ({
			kind: event.kind,
			createdAt: event.createdAt,
			payload: event.payload ?? undefined,
			conversationId: event.conversationId ?? undefined,
			messageId: event.messageId ?? undefined,
			approvalRequestId: event.approvalRequestId ?? undefined,
		})),
	);
	const actions: Activity["actions"] = [];
	for (const event of events) {
		if (!ACTION_KINDS.has(event.kind) || redacted(event.payload)) continue;
		const payload = isRecord(event.payload) ? event.payload : {};
		// Tool arguments/results and delegation instructions are deliberately
		// absent. An event's lifecycle kind is the only claim of execution.
		actions.push({
			id: event.id,
			kind: event.kind as Activity["actions"][number]["kind"],
			createdAt: event.createdAt,
			toolCallId: boundedId(event.toolCallId),
			toolName:
				boundedId(payload.name) ??
				boundedId(payload.toolName) ??
				boundedId(payload.method),
			childRunId: boundedId(payload.childRunId),
			targetTediId: boundedId(payload.targetTediId),
		});
	}
	let finalResult: Activity["finalResult"] = { status: "unavailable" };
	if (state.status === "completed") {
		const outputId = isRecord(state.result)
			? state.result.outputMessageId
			: undefined;
		const message =
			typeof outputId === "string"
				? events.find(
						(event) =>
							event.kind === "message.completed" &&
							event.messageId === outputId &&
							event.conversationId === conversations[0] &&
							isRecord(event.payload) &&
							event.payload.role === "assistant",
					)
				: undefined;
		if (message && redacted(message.payload))
			finalResult = { status: "redacted" };
		else if (
			message &&
			isRecord(message.payload) &&
			typeof message.payload.content === "string"
		) {
			finalResult = {
				status: "available",
				messageId: message.messageId ?? undefined,
				content: message.payload.content.slice(0, RESULT_LIMIT),
				truncated: message.payload.content.length > RESULT_LIMIT,
			};
		}
	}
	return {
		status: "available",
		task: { id: ref.taskId, tediId: ref.tediId, runId: ref.runId },
		runStatus:
			!truncated ||
			events.some((event) =>
				["run.completed", "run.failed", "run.canceled"].includes(event.kind),
			)
				? state.status
				: undefined,
		actions,
		finalResult,
		truncated,
	};
}

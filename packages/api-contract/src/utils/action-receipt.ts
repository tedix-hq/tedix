import { asRecord } from "./is-record";

export interface ActionReceipt {
	operation: string;
	actor: string;
	verified: boolean;
	url: string | null;
	state: string;
	checkedAt: string;
}

export const ACTION_RECEIPT_META_KEY = "tedix/actionReceipt";

export const ACTION_RECEIPT_INSTRUCTION =
	"After every write or action, read the exact target back through an authorized read tool. End your reply with a short receipt: what changed, the full object URL (including a sheet range or Work comment when applicable), its actual read-back state, and the authenticated actor. Use actionReceipts and completionEvidence when supplied. A successful tool return, queued run, or approval is not verified completion. If read-back is unavailable, say verification is unavailable and do not claim success or repeat the write. This also applies to Work comments from skill workflows.";

/** Only explicit resource contracts select a read; never guess a provider tool. */
export function actionReadbackPlan(
	operation: string,
	args: Record<string, unknown>,
	result: unknown,
	endpoint?: string,
) {
	const data = asRecord(result);
	const name = operation.split(/\.|__/).at(-1) ?? operation;
	const output = asRecord(data?.output);
	if (
		endpoint === "support/draft" ||
		(!endpoint && name === "draft_support_answer")
	) {
		const ticket = asRecord(data?.receipt);
		const draft = asRecord(data?.draft);
		if (
			typeof ticket?.ticketId === "string" &&
			ticket.ticketId === args.ticketId &&
			typeof ticket.workItemId === "string" &&
			typeof data?.mirrorWorkItemId === "string" &&
			typeof ticket.version === "number" &&
			draft
		)
			return {
				tool: "get_support_ticket",
				readEndpoint: "support/get",
				args: { ticketId: ticket.ticketId },
				id: ticket.ticketId,
				kind: "supportDraft" as const,
				workItemId: ticket.workItemId,
				mirrorWorkItemId: data.mirrorWorkItemId,
				version: ticket.version,
				draft,
			};
	}
	if (
		endpoint === "support/review" ||
		(!endpoint && name === "record_support_review")
	) {
		if (
			typeof data?.interactionId === "string" &&
			typeof data.workItemId === "string"
		)
			return {
				tool: "get_work_interaction",
				readEndpoint: "workInteractions/get",
				args: { requestId: data.interactionId },
				id: data.interactionId,
				kind: "supportReview" as const,
				workItemId: data.workItemId,
			};
	}
	if (
		/^(create|patch|revise|rename|archive|restore|set)_os_(output|document|slides|sheet_range)$/.test(
			name,
		)
	) {
		const id = output?.id ?? args.outputId;
		if (typeof id === "string")
			return {
				tool: "get_os_output",
				readEndpoint: "osWorkspaces/outputs/get",
				args: { outputId: id },
				id,
				kind: "output" as const,
			};
	}
	if (/^(create|rename|archive|restore|update)_os_workspace$/.test(name)) {
		const id = asRecord(data?.workspace)?.id ?? data?.id ?? args.workspaceId;
		if (typeof id === "string")
			return {
				tool: "get_os_workspace",
				readEndpoint: "osWorkspaces/workspaces/get",
				args: { workspaceId: id },
				id,
				kind: "workspace" as const,
			};
	}
	if (
		(/work_item/.test(name) || endpoint?.startsWith("workItems/")) &&
		!/^(get|list|find|search|preview)_/.test(name)
	) {
		const id =
			data?.workItemId ??
			asRecord(data?.workItem)?.id ??
			args.id ??
			args.workItemId ??
			data?.id;
		if (typeof id === "string")
			return {
				tool: name.startsWith("work_item_")
					? "work_item_get"
					: "get_work_items_by_id",
				readEndpoint: "workItems/getById",
				args: { id },
				id,
				kind: "work" as const,
				commentId:
					/comment/.test(name) && typeof data?.id === "string" ? data.id : null,
			};
	}
	return null;
}

export async function verifyAction(input: {
	operation: string;
	endpoint?: string;
	args: Record<string, unknown>;
	result: unknown;
	actor: string;
	origin: string;
	read: (
		tool: string,
		args: Record<string, unknown>,
		endpoint: string,
	) => Promise<unknown>;
}): Promise<ActionReceipt> {
	const receipt: ActionReceipt = {
		operation: input.operation,
		actor: input.actor,
		verified: false,
		url: null,
		state: "verification unavailable",
		checkedAt: new Date().toISOString(),
	};
	const plan = actionReadbackPlan(
		input.operation,
		input.args,
		input.result,
		input.endpoint,
	);
	if (!plan) return receipt;
	try {
		const read = asRecord(
			await input.read(plan.tool, plan.args, plan.readEndpoint),
		);
		if (read?.ok === false || read?.isError === true) return receipt;
		if (plan.kind === "supportDraft") {
			const ticket = asRecord(read?.receipt);
			const draft = asRecord(read?.draft);
			if (
				ticket?.ticketId !== plan.id ||
				ticket.workItemId !== plan.workItemId ||
				read?.mirrorWorkItemId !== plan.mirrorWorkItemId ||
				typeof ticket.version !== "number" ||
				ticket.version < plan.version ||
				typeof ticket.status !== "string" ||
				!draft ||
				draft.body !== plan.draft.body ||
				draft.nextStep !== plan.draft.nextStep ||
				JSON.stringify(draft.evidence) !== JSON.stringify(plan.draft.evidence)
			)
				return receipt;
			receipt.verified = true;
			receipt.url = new URL(
				`/work/items/${plan.mirrorWorkItemId}`,
				input.origin,
			).href;
			receipt.state = `draft present, version ${ticket.version}, ${ticket.status}; publication unverified`;
			return receipt;
		}
		if (plan.kind === "supportReview") {
			const request = asRecord(read?.request);
			if (
				request?.id !== plan.id ||
				request.workItemId !== plan.workItemId ||
				request.kind !== "coordination" ||
				request.requestedFromType !== "user" ||
				typeof request.prompt !== "string" ||
				!request.prompt.trim() ||
				typeof request.state !== "string"
			)
				return receipt;
			receipt.verified = true;
			receipt.url = new URL(
				`/work/items/${plan.workItemId}`,
				input.origin,
			).href;
			receipt.state = `internal review present, ${request.state}; delivery unverified`;
			return receipt;
		}
		const object =
			asRecord(read?.[plan.kind === "work" ? "workItem" : plan.kind]) ?? read;
		if (object?.id !== plan.id || read?.ok === false || read?.isError === true)
			return receipt;
		const commentId = "commentId" in plan ? plan.commentId : null;
		if (
			commentId &&
			(!Array.isArray(read?.comments) ||
				!read.comments.some((comment) => asRecord(comment)?.id === commentId))
		)
			return receipt;
		const state = object.status ?? object.disposition;
		if (typeof state !== "string") return receipt;
		const path =
			plan.kind === "work"
				? `/work/items/${plan.id}`
				: plan.kind === "output"
					? `/outputs/${plan.id}`
					: `/workspaces/${plan.id}`;
		receipt.url = new URL(path, input.origin).href;
		if (plan.kind === "output" && typeof input.args.startRow === "number")
			receipt.url += `?row=${input.args.startRow + 1}`;
		if (commentId) receipt.url += `#comment-${commentId}`;
		receipt.verified = true;
		receipt.state = state;
		const revision = asRecord(read?.currentRevision);
		if (typeof revision?.revision === "number")
			receipt.state += `, revision ${revision.revision}`;
	} catch {
		// The write already ran. A failed verification must never trigger a retry.
	}
	return receipt;
}

export function renderActionReceipt(receipt: ActionReceipt): string {
	return `${receipt.operation}: ${receipt.verified ? "checked" : "unverified"}; ${receipt.state}${receipt.url ? `; ${receipt.url}` : ""}; actor: ${receipt.actor}.`;
}

import { asRecord } from "./is-record";

export interface ActionReceipt {
	operation: string;
	actor: string;
	verified: boolean;
	url: string | null;
	state: string;
	checkedAt: string;
}

export const ACTION_RECEIPT_INSTRUCTION =
	"After every write or action, read the exact target back through an authorized read tool. End your reply with a short receipt: what changed, the full object URL (including a sheet range or Work comment when applicable), its actual read-back state, and the authenticated actor. Use actionReceipts and completionEvidence when supplied. A successful tool return, queued run, or approval is not verified completion. If read-back is unavailable, say verification is unavailable and do not claim success or repeat the write. This also applies to Work comments from skill workflows.";

/** Only explicit resource contracts select a read; never guess a provider tool. */
export function actionReadbackPlan(
	operation: string,
	args: Record<string, unknown>,
	result: unknown,
) {
	const data = asRecord(result);
	const name = operation.split(/\.|__/).at(-1) ?? operation;
	const output = asRecord(data?.output);
	if (
		/^(create|patch|revise|rename|archive|restore|set)_os_(output|document|slides|sheet_range)$/.test(
			name,
		)
	) {
		const id = output?.id ?? args.outputId;
		if (typeof id === "string")
			return {
				tool: "get_os_output",
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
				args: { workspaceId: id },
				id,
				kind: "workspace" as const,
			};
	}
	if (
		/work_item/.test(name) &&
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
				tool: "get_work_items_by_id",
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
	args: Record<string, unknown>;
	result: unknown;
	actor: string;
	origin: string;
	read: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<ActionReceipt> {
	const receipt: ActionReceipt = {
		operation: input.operation,
		actor: input.actor,
		verified: false,
		url: null,
		state: "verification unavailable",
		checkedAt: new Date().toISOString(),
	};
	const plan = actionReadbackPlan(input.operation, input.args, input.result);
	if (!plan) return receipt;
	try {
		const read = asRecord(await input.read(plan.tool, plan.args));
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

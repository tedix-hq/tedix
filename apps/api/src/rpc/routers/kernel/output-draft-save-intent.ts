import type { WriteWorkspaceContext } from "./write-edit-target";

export interface OutputDraftSaveTarget {
	workspaceId: string;
	outputId: string;
	name: string;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_CHANGE_RE =
	/\b(?:add|append|insert|edit|edited|update|updated|change|changed|replace|rewrite|rewritten|revise|revised|remove|delete|rename|send|email|publish|approve|pay|create|run|schedule|delegate|install|share|export)\b|\bwith\s+(?:the\s+)?(?:content|text|title|value)\b/i;

/** Saving a selected live draft is a browser operation, not a model rewrite. */
export function outputDraftSaveTarget(
	content: string,
	workspace: WriteWorkspaceContext | undefined,
): OutputDraftSaveTarget | null {
	const selected = workspace?.workpiece;
	if (
		!workspace ||
		selected?.kind !== "output" ||
		typeof selected.name !== "string" ||
		!selected.name.trim() ||
		!UUID_RE.test(workspace.workspaceId) ||
		!UUID_RE.test(selected.id)
	)
		return null;
	const request = content.trim();
	if (
		!/^(?:please\s+)?(?:save|snapshot|record|take\s+a\s+snapshot)\b/i.test(
			request,
		) ||
		!/\b(?:version|snapshot|v\d+)\b/i.test(request) ||
		CONTENT_CHANGE_RE.test(request) ||
		/\b(?:invoice|payment|email|message|google|notion|microsoft)\b/i.test(
			request,
		)
	)
		return null;
	const ids = (
		request.match(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
		) ?? []
	).filter((id) => id.toLowerCase() !== workspace.workspaceId.toLowerCase());
	if (ids.some((id) => id.toLowerCase() !== selected.id.toLowerCase()))
		return null;
	if (
		!/^(?:please\s+)?save\s+(?:a\s+|the\s+)?(?:new\s+)?version[.!]?$/i.test(
			request,
		) &&
		!/\b(?:this|current|selected|draft)\b/i.test(request) &&
		!request.toLowerCase().includes(selected.name.toLowerCase()) &&
		!ids.length
	)
		return null;
	return {
		workspaceId: workspace.workspaceId,
		outputId: selected.id,
		name: selected.name,
	};
}

export function renderOutputDraftSaveRequest(
	target: OutputDraftSaveTarget,
): string {
	const name = target.name.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
	const link = `/workspace/${encodeURIComponent(target.workspaceId)}?workpiece=output:${encodeURIComponent(target.outputId)}`;
	return `To save the live draft, [open ${name}](${link}) and use Save version above the editor. If you chose to keep changes over a newer version, use Save as v… instead. Review the save and confirm there; it uses the editor's acknowledged draft and checks for a newer saved version. Nothing was saved by this chat.`;
}

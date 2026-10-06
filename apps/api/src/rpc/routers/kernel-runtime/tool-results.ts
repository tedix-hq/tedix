import {
	literalSearch,
	readKernelToolResult,
	utf8Page,
} from "../../../services/kernel-tool-result-retention";
import { ensureHomeConversationAccess } from "../kernel/run-store";
import { resolveOrganizationId } from "../kernel/runtime-shared";
import { AUTHZ, ErrorCodes, createError } from "../../orpc";
import { authed } from "./policy-normalization";

export const readToolResultRoute = authed.readToolResult
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		await ensureHomeConversationAccess(context, {
			organizationId,
			conversationId: input.conversationId,
			required: "read",
		});
		if (input.mode === "search" && !input.query)
			throw createError(ErrorCodes.BAD_REQUEST, "Search query is required");
		const retained = await readKernelToolResult({
			db: context.db,
			bucket: context.env.TEDI_R2_BUCKET,
			organizationId,
			conversationId: input.conversationId,
			id: input.resultId,
			sha256: input.sha256,
		}).catch(() => {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Retained result read failed",
			);
		});
		if (!retained)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Retained tool result is unavailable or expired",
			);
		const selected =
			input.mode === "search"
				? literalSearch(retained.text, input.query!, input.offset)
				: { ...utf8Page(retained.text, input.offset), matchOffset: null };
		return {
			resultId: input.resultId,
			sha256: input.sha256,
			byteSize: retained.byteSize,
			content: selected.content,
			matchOffset: selected.matchOffset,
			nextOffset: selected.nextOffset,
		};
	});

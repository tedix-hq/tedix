import { AUTHZ } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authed } from "./policy-normalization";
import { storeHomeAttachment } from "./attachment-storage";

/** Uploads use HTTP oRPC, not the size-limited realtime chat socket. */
export const uploadAttachmentRoute = authed.uploadAttachment
	.use(AUTHZ.tedisWrite)
	.handler(({ context, input }) =>
		storeHomeAttachment(
			context.env.TEDI_R2_BUCKET,
			requireOrgId(context),
			input,
		),
	);

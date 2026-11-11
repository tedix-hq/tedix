import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import { installOutputEditor as installEditor } from "../../services/os-output-editor";
import { type BaseContext, withAuth, AUTHZ } from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";

const author = implement(osWorkspacesContract)
	.$context<BaseContext>()
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT))
	.use(AUTHZ.osAuthor);

export const installOutputEditor = author.gadgets.installOutputEditor.handler(
	({ input, context }) => installEditor(input, context),
);
export const installDocument = author.gadgets.installDocument.handler(
	({ input, context }) =>
		installEditor({ ...input, kind: "document" }, context),
);

export {
	WorkspaceAppHostDO,
	WorkspaceAppCapability,
	WorkspaceAppTail,
} from "../../src/workspace-app-host-do";
import { handleWorkspaceAppCall } from "../../src/workspace-app-route";
import type { WorkspaceAppHostDO } from "../../src/workspace-app-host-do";
export default {
	fetch(
		request: Request,
		env: {
			SECRETS_MASTER_KEY: string;
			WORKSPACE_APP_HOST: DurableObjectNamespace<WorkspaceAppHostDO>;
		},
	) {
		return handleWorkspaceAppCall(request, env);
	},
};

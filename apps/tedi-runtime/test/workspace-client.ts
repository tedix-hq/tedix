import {
	getWorkspace,
	type WorkspaceClient,
	type Workspace as WorkspaceVfs,
} from "@cloudflare/computer";

/**
 * Obtain the initialized, observable client for a locally owned VFS the way
 * remote workspace owners do: the local-symbol shortcut in getWorkspace exposes
 * raw fs methods without filesystem observer spans.
 */
export function getTediWorkspaceClient(
	ws: WorkspaceVfs,
): Promise<WorkspaceClient> {
	return getWorkspace({
		async __getWorkspaceStub() {
			await ws.ready();
			return ws.stub();
		},
	});
}

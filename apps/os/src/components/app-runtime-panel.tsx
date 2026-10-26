import type {
	OsGadget,
	OsGadgetManifest,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { osApi, osAppRuntimeCall } from "@/lib/api";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
import { AppRuntimeFrame } from "@/components/app-runtime-frame";
import type { AppRuntimeTranslationChannel } from "@/lib/app-runtime-translation";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	appRuntimeContextFromManifest,
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
} from "@/lib/app-runtime-host";
import {
	appRuntimeCodeQueryOptions,
	outputDetailQueryOptions,
	workspaceOpenQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import type {
	AppRuntimeFiles,
	AppRuntimeRole,
} from "@tedix/api-contract/schemas/os-app-runtime";

/**
 * A runtime app in the workspace panel: loads the current revision's files
 * and the workspace's resource bindings, then runs `client.js` in the sandbox
 * with this signed-in person's role. Reads the app asks for go through the
 * host module, which applies the shared role matrix and the manifest grants.
 *
 * The role comes from `osCollaborators.open()`: the collaborator graph
 * recomputes it on every open, the owner is `owner`, and a person the graph
 * cannot place gets `viewer`, which the matrix maps to nothing.
 */
function roleFromOpen(
	opened: { role: "use" | "build"; isOwner: boolean } | undefined,
	failed: boolean,
): AppRuntimeRole | null {
	if (failed) return "viewer";
	if (!opened) return null;
	return opened.isOwner ? "owner" : opened.role;
}
export function AppRuntimePreview({
	workspaceId,
	gadget,
	revision,
	layout = "fill",
	translation,
}: {
	workspaceId: string;
	gadget: OsGadget;
	revision: OsGadgetRevision;
	layout?: "content" | "fill";
	translation?: AppRuntimeTranslationChannel;
}) {
	const code = useQuery(
		appRuntimeCodeQueryOptions(workspaceId, gadget.id, revision.id),
	);
	const callServer = useMemo(
		() =>
			createAppRuntimeServerCall(
				{ open: osApi.osAppRuntime.open, call: osAppRuntimeCall },
				{
					workspaceId,
					gadgetId: gadget.id,
					revisionId: revision.id,
				},
			),
		[workspaceId, gadget.id, revision.id],
	);
	if (code.isPending)
		return <Skeleton className="h-40 w-full" aria-label="Loading app" />;
	if (!code.data?.code)
		return (
			<Alert variant="warning">
				<AlertTitle>{gadget.name} has no code yet</AlertTitle>
				<AlertDescription>
					Revision {revision.revision} carries no files. Record a revision with
					server.js and client.js to run this app.
				</AlertDescription>
			</Alert>
		);
	return (
		<AppRuntimeSandbox
			key={revision.id}
			workspaceId={workspaceId}
			gadget={gadget}
			manifest={revision.manifest}
			revision={revision.revision}
			files={code.data.code.files}
			callServer={callServer}
			layout={layout}
			translation={translation}
		/>
	);
}

/**
 * Runs one set of app files in the sandbox. The live app passes a server call
 * pinned to its revision; a draft passes a call pinned to its proposal and
 * isolated server storage.
 * Reads still go through the role matrix with the signed-in person's role.
 */
export function AppRuntimeSandbox({
	workspaceId,
	gadget,
	manifest,
	revision,
	files,
	callServer,
	title = gadget.name,
	layout = "fill",
	translation,
}: {
	workspaceId: string;
	gadget: Pick<OsGadget, "id" | "name">;
	manifest: OsGadgetManifest;
	revision: number;
	files: AppRuntimeFiles;
	callServer?: (method: string, args: JsonValue[]) => Promise<JsonValue>;
	title?: string;
	layout?: "content" | "fill";
	translation?: AppRuntimeTranslationChannel;
}) {
	const queryClient = useQueryClient();
	const resources = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const opened = useQuery(workspaceOpenQueryOptions(workspaceId, gadget.id));
	const role = roleFromOpen(opened.data, opened.isError);
	const context = useMemo(
		() =>
			appRuntimeContextFromManifest(manifest, {
				workspaceId,
				gadget: { id: gadget.id, name: gadget.name, revision },
				role: role ?? "viewer",
			}),
		[gadget.id, gadget.name, manifest, revision, role, workspaceId],
	);
	const resourceRows = resources.data?.items;
	const onCall = useCallback(
		(method: unknown, args: unknown) =>
			handleAppRuntimeCall(
				{
					context,
					callServer,
					resources: resourceRows ?? [],
					readOutput: async (outputId) =>
						(await queryClient.fetchQuery(outputDetailQueryOptions(outputId)))
							.currentRevision.content,
				},
				method,
				args,
			),
		[context, callServer, queryClient, resourceRows],
	);
	const html = useMemo(() => buildAppRuntimeDocument(files), [files]);
	if (resources.isPending || role === null)
		return <Skeleton className="h-40 w-full" aria-label="Loading app" />;
	return (
		<AppRuntimeFrame
			html={html}
			title={title}
			onCall={onCall}
			layout={layout}
			translation={translation}
		/>
	);
}

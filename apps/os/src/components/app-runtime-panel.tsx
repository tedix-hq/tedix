import type {
	OsGadget,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { osApi } from "@/lib/api";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
import { AppRuntimeFrame } from "@/components/app-runtime-frame";
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
import type { AppRuntimeRole } from "@tedix/api-contract/schemas/os-app-runtime";

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
}: {
	workspaceId: string;
	gadget: OsGadget;
	revision: OsGadgetRevision;
	layout?: "content" | "fill";
}) {
	const queryClient = useQueryClient();
	const code = useQuery(
		appRuntimeCodeQueryOptions(workspaceId, gadget.id, revision.id),
	);
	const callServer = useMemo(
		() =>
			createAppRuntimeServerCall(osApi.osAppRuntime, {
				workspaceId,
				gadgetId: gadget.id,
				revisionId: revision.id,
			}),
		[workspaceId, gadget.id, revision.id],
	);
	const resources = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const opened = useQuery(workspaceOpenQueryOptions(workspaceId, gadget.id));
	const role = roleFromOpen(opened.data, opened.isError);
	const context = useMemo(
		() =>
			appRuntimeContextFromManifest(revision.manifest, {
				workspaceId,
				gadget: {
					id: gadget.id,
					name: gadget.name,
					revision: revision.revision,
				},
				role: role ?? "viewer",
			}),
		[gadget.id, gadget.name, revision, role, workspaceId],
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
	const html = useMemo(
		() =>
			code.data?.code ? buildAppRuntimeDocument(code.data.code.files) : null,
		[code.data],
	);
	if (code.isPending || resources.isPending || role === null)
		return <Skeleton className="h-40 w-full" aria-label="Loading app" />;
	if (!html)
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
		<AppRuntimeFrame
			key={revision.id}
			html={html}
			title={gadget.name}
			onCall={onCall}
			layout={layout}
		/>
	);
}

import type {
	OsGadget,
	OsGadgetManifest,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo } from "react";
import { osApi, osAppRuntimeCall } from "@/lib/api";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
import { exportAppRuntimeOutput } from "@/lib/app-runtime-export";
import { replaceAppRuntimeOutput } from "@/lib/app-runtime-output";
import { isWorkspaceAccessDenied } from "@/lib/workspace-verification";
import { AppRuntimeFrame } from "@/components/app-runtime-frame";
import {
	OfficeEditorUpgrade,
	officeEditorUpgrade,
} from "@/components/office-editor-upgrade";
import {
	useDocWritingDrafts,
	useAppRuntimeDrafts,
} from "@/components/doc-writing-drafts";
import type { AppRuntimeTranslationChannel } from "@/lib/app-runtime-translation";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	appRuntimeContextFromManifest,
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
	withEditableRichText,
} from "@/lib/app-runtime-host";
import {
	appRuntimeCodeQueryOptions,
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
	osQueryKeys,
	workspaceOpenQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import type {
	AppRuntimeFiles,
	AppRuntimeRole,
} from "@tedix/api-contract/schemas/os-app-runtime";

const DocWritingEditor = lazy(async () => ({
	default: (await import("./doc-writing-editor")).DocWritingEditor,
}));
const FileOutputView = lazy(async () => ({
	default: (await import("./output-content")).FileOutputView,
}));

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

/** How often an open app re-checks its files for someone else's save. */
const OUTPUT_RECHECK_MS = 4_000;
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
	// The sandbox needs these as soon as the code arrives; ask for all of them
	// at once instead of one after the other.
	useQuery(workspaceResourcesQueryOptions(workspaceId));
	useQuery(workspaceOpenQueryOptions(workspaceId, gadget.id));
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
	// The built-in editors read their file through the host, so only apps with
	// their own server methods gain from an early session.
	const callsServer = revision.manifest.operations?.some(
		(operation) =>
			!["readDocument", "readSheet", "readPresentation"].includes(
				operation.name,
			),
	)
		? callServer
		: null;
	useEffect(() => callsServer?.prime(), [callsServer]);
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
			revisionId={revision.id}
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
	revisionId,
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
	revisionId?: string;
	files: AppRuntimeFiles;
	callServer?: (method: string, args: JsonValue[]) => Promise<JsonValue>;
	title?: string;
	layout?: "content" | "fill";
	translation?: AppRuntimeTranslationChannel;
}) {
	const queryClient = useQueryClient();
	const resources = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const drafts = useDocWritingDrafts();
	const appDrafts = useAppRuntimeDrafts();
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
	const boundOutputs = useMemo(
		() =>
			(resourceRows ?? []).filter(
				(resource) =>
					resource.workspaceId === workspaceId &&
					resource.status === "active" &&
					resource.providerId === "tedix" &&
					resource.resourceType === "output" &&
					context.grants.some(
						(grant) =>
							grant.slot === resource.slot &&
							grant.operations.includes("outputs.read"),
					),
			),
		[resourceRows, context.grants, workspaceId],
	);
	const outputReads = useQueries({
		queries: boundOutputs.map((resource) => ({
			...outputDetailQueryOptions(resource.providerResourceId),
			enabled: role !== null && role !== "viewer",
		})),
	});
	const outputRevisions = outputReads.flatMap((read, index) => {
		const resource = boundOutputs[index];
		const current = read.data?.currentRevision;
		return role !== null &&
			role !== "viewer" &&
			resource?.slot &&
			read.isSuccess &&
			read.data.output.workspaceId === workspaceId &&
			current
			? [
					{
						slot: resource.slot,
						outputId: resource.providerResourceId,
						revisionId: current.id,
						revision: current.revision,
					},
				]
			: [];
	});
	// Nothing pushes another person's save to this tab. While the tab is
	// visible, re-check the workspace's file list (revision ids, no file
	// bodies) and refresh a bound file whose revision moved; that refresh
	// sends the app its outputs-changed notice.
	const outputList = useQuery({
		...canvasOutputsQueryOptions(workspaceId),
		enabled: boundOutputs.length > 0 && role !== null && role !== "viewer",
		refetchInterval: OUTPUT_RECHECK_MS,
	});
	const staleOutputIds = (outputList.data?.items ?? [])
		.filter((item) => {
			const index = boundOutputs.findIndex(
				(resource) => resource.providerResourceId === item.id,
			);
			const current = outputReads[index]?.data?.currentRevision;
			return (
				index >= 0 &&
				current &&
				item.currentRevisionId &&
				item.currentRevisionId !== current.id
			);
		})
		.map((item) => item.id)
		.join(",");
	useEffect(() => {
		for (const outputId of staleOutputIds.split(",").filter(Boolean))
			void queryClient.invalidateQueries({
				queryKey: outputDetailQueryOptions(outputId).queryKey,
			});
	}, [staleOutputIds, queryClient]);

	const onCall = useCallback(
		(method: unknown, args: unknown) =>
			handleAppRuntimeCall(
				{
					context,
					callServer,
					exportOutput: exportAppRuntimeOutput,
					replaceOutput: replaceAppRuntimeOutput,
					operations: manifest.operations,
					appRevisionId: revisionId,
					drafts: appDrafts ?? undefined,
					onWrite: () => {
						void queryClient.invalidateQueries({
							queryKey: osQueryKeys.outputs(),
						});
					},
					resources: resourceRows ?? [],
					readOutput: async (outputId) => {
						const detail = await queryClient.fetchQuery({
							...outputDetailQueryOptions(outputId),
							staleTime: 0,
						});
						if (detail.output.workspaceId !== workspaceId)
							throw new Error(
								"This file moved to another workspace. Reopen it before continuing.",
							);
						return detail.currentRevision.content;
					},
					readOutputRevision: async (outputId) => {
						const detail = await queryClient.fetchQuery({
							...outputDetailQueryOptions(outputId),
							staleTime: 0,
						});
						if (detail.output.workspaceId !== workspaceId)
							throw new Error(
								"This file moved to another workspace. Reopen it before continuing.",
							);
						return {
							output: detail.output,
							revision: withEditableRichText(detail.currentRevision),
						};
					},
				},
				method,
				args,
			),
		[
			context,
			callServer,
			queryClient,
			resourceRows,
			manifest.operations,
			revisionId,
			appDrafts,
			workspaceId,
		],
	);
	const html = useMemo(() => buildAppRuntimeDocument(files), [files]);
	const docResourceAvailable = boundOutputs.some(
		(row) => row.slot === context.settings.slot,
	);
	const editorUpgrade = officeEditorUpgrade(manifest);
	const portableDoc =
		typeof context.settings.editor === "string" &&
		/^document-v(?:[3-9]|\d{2,})$/.test(context.settings.editor);
	const officeEditor =
		portableDoc ||
		context.settings.editor === "document-v2" ||
		(typeof context.settings.slot === "string" &&
			manifest.operations?.some(
				(operation) =>
					["readDocument", "readSheet", "readPresentation"].includes(
						operation.name,
					) && operation.outputSlot === context.settings.slot,
			));
	const movedSource = outputReads.some(
		(read) => read.isSuccess && read.data.output.workspaceId !== workspaceId,
	);
	const sourceUnavailable =
		movedSource || outputReads.some((read) => read.isError);
	const sourceDenied =
		movedSource ||
		outputReads.some(
			(read) => read.isError && isWorkspaceAccessDenied(read.error),
		);
	useEffect(() => {
		if (
			(role === "viewer" &&
				(!opened.isError || isWorkspaceAccessDenied(opened.error))) ||
			role === "use" ||
			sourceDenied ||
			(resources.isError && isWorkspaceAccessDenied(resources.error)) ||
			(officeEditor && resources.isSuccess && !docResourceAvailable)
		) {
			for (const key of drafts?.keys() ?? [])
				if (key.startsWith(gadget.id + ":")) drafts?.delete(key);
			for (const key of appDrafts?.keys() ?? [])
				if (key.startsWith(`${workspaceId}:${gadget.id}:`))
					appDrafts?.delete(key);
		}
	}, [
		role,
		resources.isError,
		resources.isSuccess,
		resources.error,
		opened.isError,
		opened.error,
		officeEditor,
		docResourceAvailable,
		drafts,
		appDrafts,
		workspaceId,
		sourceDenied,
		gadget.id,
	]);
	if (resources.isPending || role === null)
		return <Skeleton className="h-40 w-full" aria-label="Loading app" />;
	if (context.settings.editor === "document-v2") {
		const resource = boundOutputs.find(
			(row) => row.slot === context.settings.slot,
		);
		if (resources.isError || !resource || role === "viewer")
			return (
				<Alert variant="warning">
					<AlertTitle>Document unavailable</AlertTitle>
					<AlertDescription>
						The document slot or your workspace access is unavailable.
					</AlertDescription>
				</Alert>
			);
		const read = outputReads[boundOutputs.indexOf(resource)];
		return (
			<>
				{revisionId && (role === "owner" || role === "build") && (
					<OfficeEditorUpgrade
						kind="document"
						workspaceId={workspaceId}
						outputId={resource.providerResourceId}
						gadgetId={gadget.id}
						revisionId={revisionId}
					/>
				)}
				<Suspense fallback={<Skeleton className="h-80" />}>
					<DocWritingEditor
						key={`${gadget.id}:${revision}:${resource.providerResourceId}`}
						workspaceId={workspaceId}
						outputId={resource.providerResourceId}
						appVersion={revision}
						draftKey={`${gadget.id}:${revisionId ?? revision}:${resource.providerResourceId}`}
						role={role}
						onCall={onCall}
						savedRevision={
							outputRevisions.find((row) => row.slot === resource.slot)
								?.revision
						}
						sourceUnavailable={read?.isError ?? false}
					/>
				</Suspense>
			</>
		);
	}
	const legacyResource = boundOutputs.find(
		(row) => row.slot === context.settings.slot,
	);
	if (
		officeEditor &&
		(resources.isError ||
			role === "viewer" ||
			!legacyResource ||
			sourceUnavailable)
	)
		return (
			<Alert variant="warning">
				<AlertTitle>File unavailable</AlertTitle>
				<AlertDescription>
					This app could not open its file. The file may have been removed, or
					your access to it may have changed.
				</AlertDescription>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => {
						void resources.refetch();
						void opened.refetch();
						for (const read of outputReads) void read.refetch();
					}}
				>
					Try again
				</Button>
			</Alert>
		);
	// The Doc gadget keeps an attached file but cannot show it; the host
	// previews it here, read-only.
	const boundContent = legacyResource
		? outputReads[boundOutputs.indexOf(legacyResource)]?.data?.currentRevision
				.content
		: undefined;
	const attachedFile =
		portableDoc && boundContent?.kind === "document"
			? boundContent.file
			: undefined;
	return (
		<>
			{attachedFile && (
				<Suspense fallback={<Skeleton className="h-40 w-full" />}>
					<FileOutputView {...attachedFile} />
				</Suspense>
			)}
			{editorUpgrade &&
				legacyResource &&
				revisionId &&
				(role === "owner" || role === "build") && (
					<OfficeEditorUpgrade
						kind={editorUpgrade.kind}
						workspaceId={workspaceId}
						outputId={legacyResource.providerResourceId}
						gadgetId={gadget.id}
						revisionId={revisionId}
					/>
				)}
			<AppRuntimeFrame
				key={
					officeEditor
						? `${workspaceId}:${gadget.id}:${revisionId ?? revision}:${role}`
						: undefined
				}
				html={html}
				title={title}
				onCall={onCall}
				layout={layout}
				translation={translation}
				outputRevisions={outputRevisions}
			/>
		</>
	);
}

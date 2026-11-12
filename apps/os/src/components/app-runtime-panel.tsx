import type {
	OsGadget,
	OsGadgetManifest,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { osApi, osAppRuntimeCall } from "@/lib/api";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
import { exportAppRuntimeOutput } from "@/lib/app-runtime-export";
import { replaceAppRuntimeOutput } from "@/lib/app-runtime-output";
import { isWorkspaceAccessDenied } from "@/lib/workspace-verification";
import { subscribeOutputRevisionNotices } from "@/lib/output-revision-notices";
import { usePresentationAppearance } from "@/lib/presentation-appearance";
import { AppRuntimeFrame } from "@/components/app-runtime-frame";
import {
	OfficeEditorUpgrade,
	officeEditorUpgrade,
} from "@/components/office-editor-upgrade";
import { useAppRuntimeDrafts } from "@/components/app-runtime-draft-store";
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
	outputImageQueryOptions,
	osQueryKeys,
	workspaceOpenQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import type {
	AppRuntimeFiles,
	AppRuntimeRole,
} from "@tedix/api-contract/schemas/os-app-runtime";

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

/**
 * After a changed-only save, the workspace's file lists are refreshed at most
 * this often. An editor saves several times a second while someone types;
 * the lists only show that the file changed.
 */
const LIST_REFRESH_AFTER_SAVE_MS = 5_000;

/** The newest saved revision of a file this tab has heard of. */
type KnownRevision = { revisionId: string; revision: number };
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
	const appDrafts = useAppRuntimeDrafts();
	const opened = useQuery(workspaceOpenQueryOptions(workspaceId, gadget.id));
	const role = roleFromOpen(opened.data, opened.isError);
	const appearance = usePresentationAppearance();
	const context = useMemo(
		() =>
			appRuntimeContextFromManifest(manifest, {
				workspaceId,
				gadget: { id: gadget.id, name: gadget.name, revision },
				role: role ?? "viewer",
				appearance,
			}),
		[appearance, gadget.id, gadget.name, manifest, revision, role, workspaceId],
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
	// The newest revision of each bound file this tab has heard of: from a
	// change notice, from its own save, or from a re-check after reconnecting.
	// The file's content is not read again for any of them; the app fetches
	// only what changed.
	const [noticed, setNoticed] = useState<Record<string, KnownRevision>>({});
	// When each was heard, so an older copy of the file list is not mistaken
	// for news.
	const noticedAt = useRef<Record<string, number>>({});
	const savedRevisions = useRef<Record<string, KnownRevision>>({});
	const pendingSaves = useRef<Record<string, number>>({});
	const queuedNotices = useRef<Record<string, KnownRevision>>({});
	const notice = useCallback((outputId: string, next: KnownRevision) => {
		// The room can announce a save before its HTTP reply arrives.
		if (pendingSaves.current[outputId]) {
			if ((queuedNotices.current[outputId]?.revision ?? 0) < next.revision)
				queuedNotices.current[outputId] = next;
			return;
		}
		noticedAt.current[outputId] = Date.now();
		if ((savedRevisions.current[outputId]?.revision ?? 0) >= next.revision)
			return;
		setNoticed((current) =>
			(current[outputId]?.revision ?? 0) >= next.revision
				? current
				: { ...current, [outputId]: next },
		);
	}, []);
	const boundIds = boundOutputs
		.map((resource) => resource.providerResourceId)
		.join(",");
	const outputRevisions = outputReads.flatMap((read, index) => {
		const resource = boundOutputs[index];
		const current = read.data?.currentRevision;
		const heard = resource ? noticed[resource.providerResourceId] : undefined;
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
						...(heard && heard.revision > current.revision
							? heard
							: { revisionId: current.id, revision: current.revision }),
					},
				]
			: [];
	});
	const knownRevisions = useRef<Record<string, KnownRevision>>({});
	knownRevisions.current = Object.fromEntries(
		outputRevisions.map((row) => [
			row.outputId,
			(savedRevisions.current[row.outputId]?.revision ?? 0) > row.revision
				? savedRevisions.current[row.outputId]!
				: { revisionId: row.revisionId, revision: row.revision },
		]),
	);
	// Someone else's save is pushed to this tab through the workspace's live
	// room. The list of files (revision ids, no bodies) is read again only when
	// that connection comes back, because notices sent meanwhile are gone.
	const outputList = useQuery({
		...canvasOutputsQueryOptions(workspaceId),
		enabled: boundOutputs.length > 0 && role !== null && role !== "viewer",
	});
	const refetchOutputList = outputList.refetch;
	useEffect(() => {
		if (!boundIds || role === null || role === "viewer") return;
		const bound = new Set(boundIds.split(","));
		return subscribeOutputRevisionNotices(workspaceId, (event) => {
			if (event.type === "resync") void refetchOutputList();
			else if (bound.has(event.outputId))
				notice(event.outputId, {
					revisionId: event.revisionId,
					revision: event.revision,
				});
		});
	}, [boundIds, notice, refetchOutputList, role, workspaceId]);
	// A re-read list that names a revision this tab has not heard of: ask
	// which revision that is. The answer is a few bytes, not the file.
	const listReadAt = outputList.dataUpdatedAt;
	const movedOutputIds = (outputList.data?.items ?? [])
		.filter((item) => {
			const known = knownRevisions.current[item.id];
			return (
				known &&
				item.currentRevisionId &&
				item.currentRevisionId !== known.revisionId &&
				listReadAt > (noticedAt.current[item.id] ?? 0)
			);
		})
		.map((item) => `${item.id}:${item.currentRevisionId}`)
		.join(",");
	useEffect(() => {
		let active = true;
		for (const entry of movedOutputIds.split(",").filter(Boolean)) {
			const [outputId, revisionId] = entry.split(":") as [string, string];
			const known = knownRevisions.current[outputId];
			if (!known || known.revisionId === revisionId) continue;
			void osApi.osWorkspaces.outputs
				.changes({ outputId, sinceRevision: known.revision })
				.then(({ revision }) => {
					if (active)
						notice(outputId, {
							revisionId: revision.id,
							revision: revision.revision,
						});
				})
				.catch(() => undefined);
		}
		return () => {
			active = false;
		};
	}, [movedOutputIds, notice]);
	const listRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	useEffect(() => () => clearTimeout(listRefresh.current), []);

	const onCall = useCallback(
		(method: unknown, args: unknown) =>
			handleAppRuntimeCall(
				{
					context,
					callServer,
					exportOutput: exportAppRuntimeOutput,
					replaceOutput: replaceAppRuntimeOutput,
					patchOutput: async (input) => {
						const id = input.outputId;
						pendingSaves.current[id] = (pendingSaves.current[id] ?? 0) + 1;
						try {
							const saved = await osApi.osWorkspaces.outputs.patch({
								outputId: input.outputId,
								expectedWorkspaceId: input.workspaceId,
								baseRevision: input.baseRevision,
								patch: input.patch,
								// The editor's own saves are grouped into one activity
								// entry per burst and thinned later; a save someone
								// asked for is a version of its own.
								...(input.explicit
									? { note: "Saved from workspace app" }
									: { autosave: true }),
							});
							// This tab's own save is not news to it.
							if (
								(savedRevisions.current[id]?.revision ?? 0) <
								saved.revision.revision
							)
								savedRevisions.current[id] = {
									revisionId: saved.revision.id,
									revision: saved.revision.revision,
								};
							noticedAt.current[id] = Date.now();
							return saved;
						} finally {
							pendingSaves.current[id]!--;
							if (!pendingSaves.current[id]) {
								const queued = queuedNotices.current[id];
								delete queuedNotices.current[id];
								if (queued) notice(id, queued);
							}
						}
					},
					readOutputChanges: async (input) => {
						const changes = await osApi.osWorkspaces.outputs.changes({
							outputId: input.outputId,
							sinceRevision: input.sinceRevision,
						});
						if (changes.output.workspaceId !== input.workspaceId)
							throw new Error(
								"This file moved to another workspace. Reopen it before continuing.",
							);
						notice(input.outputId, {
							revisionId: changes.revision.id,
							revision: changes.revision.revision,
						});
						return changes;
					},
					uploadOutputImage: async (input) =>
						(await osApi.osWorkspaces.outputs.uploadImage(input)).reference,
					readOutputImage: async (input) =>
						(await queryClient.fetchQuery(outputImageQueryOptions(input)))
							.dataUrl,
					operations: manifest.operations,
					appRevisionId: revisionId,
					drafts: appDrafts ?? undefined,
					onWrite: (patchedOutputId) => {
						if (!patchedOutputId)
							return void queryClient.invalidateQueries({
								queryKey: osQueryKeys.outputs(),
							});
						// A changed-only save: the open file is not read again. Its
						// cached copy is marked old for whoever opens it next, and the
						// lists that show files catch up shortly, not on every save.
						const detailKey = JSON.stringify(
							outputDetailQueryOptions(patchedOutputId).queryKey,
						);
						void queryClient.invalidateQueries({
							queryKey: outputDetailQueryOptions(patchedOutputId).queryKey,
							refetchType: "none",
						});
						listRefresh.current ??= setTimeout(() => {
							listRefresh.current = undefined;
							void queryClient.invalidateQueries({
								queryKey: osQueryKeys.outputs(),
								predicate: (query) =>
									JSON.stringify(query.queryKey) !== detailKey,
							});
						}, LIST_REFRESH_AFTER_SAVE_MS);
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
					readOutputRevision: async (outputId, revision) => {
						const detail = await queryClient.fetchQuery({
							...outputDetailQueryOptions(outputId),
							// An earlier revision is read on its own; the file's
							// name and place come from the copy already held.
							...(revision === undefined ? { staleTime: 0 } : {}),
						});
						if (detail.output.workspaceId !== workspaceId)
							throw new Error(
								"This file moved to another workspace. Reopen it before continuing.",
							);
						if (revision === undefined)
							return {
								output: detail.output,
								revision: withEditableRichText(detail.currentRevision),
							};
						const earlier = (
							await osApi.osWorkspaces.outputs.history({ outputId, revision })
						).revisions.find((row) => row.revision === revision);
						if (!earlier?.content)
							throw new Error(
								"The version your unsaved changes were made from is no longer available.",
							);
						return {
							output: detail.output,
							revision: withEditableRichText({
								...earlier,
								content: earlier.content,
							}),
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
			notice,
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
		// The built-in document editor is gone. Someone who can build gets the
		// current Doc editor installed in its place; the file is not touched.
		if (!revisionId || role === "use")
			return (
				<Alert variant="warning">
					<AlertTitle>Document unavailable</AlertTitle>
					<AlertDescription>
						This document needs the current editor. It is installed the next
						time someone who can build in this workspace opens it.
					</AlertDescription>
				</Alert>
			);
		return (
			<>
				<OfficeEditorUpgrade
					kind="document"
					workspaceId={workspaceId}
					outputId={resource.providerResourceId}
					gadgetId={gadget.id}
					revisionId={revisionId}
				/>
				<Skeleton className="h-80" aria-label="Loading document" />
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

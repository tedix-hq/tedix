import { ArrowRight, ShieldCheck } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APP_RUNTIME_ENTRY } from "@tedix/api-contract/schemas/os-app-runtime";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppRuntimeFrame } from "@/components/app-runtime-frame";
import { CanvasPresence } from "@/components/canvas-presence";
import { AppLoading } from "@/components/app-loading";
import {
	buildAppRuntimeDocument,
	handleAppRuntimeCall,
} from "@/lib/app-runtime-host";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { WidgetFrame } from "@/components/widget-frame";
import { ROLE_LABEL } from "@/components/workspace-share-dialog";
import { osApi, osAppRuntimeCall } from "@/lib/api";
import { gadgetWidgetTargetFromManifest } from "@/lib/gadget-widget-target";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";
import { useWorkspacePresence } from "@/lib/workspace-presence";

type Opened = Awaited<ReturnType<typeof osApi.osCollaborators.open>>;

type PageState =
	| { status: "loading" }
	| { status: "ready"; opened: Opened }
	| { status: "denied" }
	| { status: "archived"; workspace: ArchivedWorkspace }
	| { status: "missing" };

type ArchivedWorkspace = { id: string; name: string; updatedAt: string };

const errorCode = (error: unknown): unknown =>
	typeof error === "object" && error !== null && "code" in error
		? (error as { code: unknown }).code
		: null;

/** Read and strip the `#share=` key so it never lingers in the address bar. */
export function takeShareKey(): string | undefined {
	const key = new URLSearchParams(window.location.hash.slice(1)).get("share");
	if (key !== null)
		window.history.replaceState(
			null,
			"",
			window.location.pathname + window.location.search,
		);
	return key ?? undefined;
}

function SharedRuntimeApp({
	workspaceId,
	app,
}: {
	workspaceId: string;
	app: Opened["apps"][number];
}) {
	const scope = useMemo(
		() => ({ workspaceId, gadgetId: app.id }),
		[workspaceId, app.id],
	);
	const client = useQuery(
		osQuery.osAppRuntime.client.queryOptions({
			input: scope,
			staleTime: 0,
			refetchInterval: 240_000,
		}),
	);
	const data = client.data;
	const callServer = useMemo(
		() =>
			data
				? createAppRuntimeServerCall(
						{ open: osApi.osAppRuntime.open, call: osAppRuntimeCall },
						{ ...scope, revisionId: data.revisionId },
					)
				: undefined,
		[scope, data?.revisionId],
	);
	const onCall = useCallback(
		(method: unknown, args: unknown) => {
			if (!data || client.isError)
				return Promise.resolve({
					ok: false as const,
					error: "not_permitted" as const,
				});
			return handleAppRuntimeCall(
				{
					context: {
						workspaceId,
						gadget: { id: app.id, name: app.name, revision: data.revision },
						role: data.role,
						settings: data.settings,
						grants: data.grants,
					},
					resources: [],
					readOutput: async () => {
						throw new Error("Use a granted app slot");
					},
					readSlot: (slot) =>
						osApi.osAppRuntime.readOutput({
							...scope,
							session: data.session,
							slot,
						}),
					callServer,
				},
				method,
				args,
			);
		},
		[data, client.isError, workspaceId, app.id, app.name, scope, callServer],
	);
	const html = useMemo(
		() => (data ? buildAppRuntimeDocument({ "client.js": data.client }) : ""),
		[data?.client],
	);
	if (client.isPending) return <AppLoading />;
	if (client.isError || !data)
		return (
			<LoadError
				title="This app is unavailable"
				error={client.error}
				onRetry={() => {
					void client.refetch();
				}}
				retrying={client.isFetching}
				help="Ask the person who shared it to check your access."
			/>
		);
	return (
		<AppRuntimeFrame
			key={data.revisionId}
			html={html}
			title={app.name}
			onCall={onCall}
			layout="content"
		/>
	);
}

function SharedApp({
	app,
	workspaceId,
}: {
	app: Opened["apps"][number];
	workspaceId: string;
}) {
	const target = gadgetWidgetTargetFromManifest(
		app.entry
			? ({ entry: app.entry, capabilities: [] } as OsGadgetManifest)
			: null,
	);
	return (
		<section className="grid gap-2" aria-label={app.name}>
			<div className="grid gap-0.5">
				<Text as="h2" role="section" className="m-0">
					{app.name}
				</Text>
				{app.description ? (
					<Text as="p" role="body" tone="secondary" className="m-0">
						{app.description}
					</Text>
				) : null}
			</div>
			{app.entry === APP_RUNTIME_ENTRY ? (
				<SharedRuntimeApp workspaceId={workspaceId} app={app} />
			) : target ? (
				<WidgetFrame
					appSlug={target.appSlug}
					resourceUri={target.resourceUri}
					title={app.name}
				/>
			) : (
				<Text role="label" tone="secondary" className="m-0">
					This app has no view to show yet.
				</Text>
			)}
		</section>
	);
}

/**
 * An archived workspace's address. Only someone who may see the workspace
 * gets here; the server decides whether they may restore it, as it does for
 * Restore under Workspaces → Archived.
 */
function ArchivedWorkspaceNotice({
	workspace,
}: {
	workspace: ArchivedWorkspace;
}) {
	const queryClient = useQueryClient();
	const restore = useMutation({
		...osQuery.osWorkspaces.workspaces.restore.mutationOptions(),
		onSuccess: async () => {
			await Promise.allSettled([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() }),
				queryClient.invalidateQueries({
					queryKey: osQueryKeys.collaborators(),
				}),
			]);
			window.location.assign(`/workspace/${encodeURIComponent(workspace.id)}`);
		},
	});
	return (
		<main className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center px-4">
			<div className="grid w-full gap-3">
				<Alert data-workspace-archived>
					<AlertTitle>{workspace.name} is archived</AlertTitle>
					<AlertDescription>
						Archived on {new Date(workspace.updatedAt).toLocaleDateString()}.
						Nothing was deleted. Restore it to open it again with its documents
						and apps.
					</AlertDescription>
				</Alert>
				{restore.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Could not restore the workspace</AlertTitle>
						<AlertDescription>{restore.error.message}</AlertDescription>
					</Alert>
				) : null}
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<Button
						loading={restore.isPending || restore.isSuccess}
						onClick={() => {
							if (restore.isPending || restore.isSuccess) return;
							restore.mutate({ workspaceId: workspace.id });
						}}
					>
						Restore workspace
					</Button>
					<Link href="/workspaces?view=archived">Workspaces → Archived</Link>
				</div>
			</div>
		</main>
	);
}

/**
 * A workspace someone shared with you. Opens it as yourself (redeeming a
 * share key from the URL fragment once), then shows only what your role
 * allows: a `use` collaborator sees the apps and nothing else.
 */
export function SharedWorkspacePage({ workspaceId }: { workspaceId: string }) {
	const [state, setState] = useState<PageState>({ status: "loading" });
	const queryClient = useQueryClient();
	// The key is redeemed once; a reconnect must never silently re-redeem it.
	const opening = useRef<Promise<Opened> | null>(null);
	const participants = useWorkspacePresence({
		workspaceId,
		location: { surface: "canvas", selectionLabel: "Apps" },
		enabled: state.status === "ready",
	});
	const access = useQuery(
		osQuery.osCollaborators.access.queryOptions({
			input: { workspaceId },
			enabled: state.status === "ready",
			staleTime: 0,
			refetchInterval: 3_000,
			retry: false,
		}),
	);
	useEffect(() => {
		if (state.status !== "ready") return;
		if (access.isError) {
			setState({ status: "denied" });
		} else if (access.data && access.data.role !== state.opened.role) {
			setState({
				status: "ready",
				opened: {
					...state.opened,
					role: access.data.role,
				},
			});
		}
	}, [access.data, access.isError, state]);

	useEffect(() => {
		let alive = true;
		const shareKey = takeShareKey();
		opening.current ??= osApi.osCollaborators.open({
			workspaceId,
			...(shareKey ? { shareKey } : {}),
		});
		opening.current.then(
			(opened) => {
				if (!alive) return;
				setState({ status: "ready", opened });
				void queryClient.invalidateQueries({
					queryKey: osQueryKeys.collaborators(),
				});
			},
			(error: unknown) => {
				if (!alive) return;
				if (errorCode(error) !== "NOT_FOUND") {
					setState({ status: "denied" });
					return;
				}
				// Opening answers "not found" for an archived workspace too. The
				// workspace read tells the two apart, and answers "not found"
				// itself for a workspace this person may not see.
				osApi.osWorkspaces.workspaces.get({ workspaceId }).then(
					({ workspace }) => {
						if (!alive) return;
						setState(
							workspace.status === "archived"
								? { status: "archived", workspace }
								: { status: "missing" },
						);
					},
					() => {
						if (alive) setState({ status: "missing" });
					},
				);
			},
		);
		return () => {
			alive = false;
		};
	}, [workspaceId, queryClient]);

	if (state.status === "loading") {
		return (
			<main className="grid min-h-dvh place-items-center p-4" aria-busy>
				<Text role="body" tone="secondary">
					Opening workspace…
				</Text>
			</main>
		);
	}
	if (state.status === "archived")
		return <ArchivedWorkspaceNotice workspace={state.workspace} />;
	if (state.status !== "ready") {
		return (
			<main className="mx-auto grid min-h-dvh w-full max-w-xl place-items-center px-4">
				<Alert variant="destructive" data-access-denied>
					<AlertTitle>
						{state.status === "missing"
							? "This workspace doesn't exist"
							: "You don't have access"}
					</AlertTitle>
					<AlertDescription>
						{state.status === "missing"
							? "It may have been deleted."
							: "Ask the person who shared it to add you again."}
					</AlertDescription>
				</Alert>
			</main>
		);
	}
	const { opened } = state;
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
			<header className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<div className="grid min-w-0 flex-1 gap-0.5">
					<Text as="h1" role="title" className="m-0 truncate">
						{opened.workspace.title}
					</Text>
					<Text as="p" role="label" tone="secondary" className="m-0">
						{opened.workspace.ownerName
							? `Shared by ${opened.workspace.ownerName}`
							: "Shared with you"}{" "}
						· opened with your own Tedix sign-in
					</Text>
				</div>
				<CanvasPresence participants={participants} />
				<Badge variant="secondary">
					<ShieldCheck size={13} /> {ROLE_LABEL[opened.role]}
				</Badge>
				{opened.role === "build" ? (
					<Button
						size="sm"
						onClick={() =>
							window.location.assign(
								`/workspace/${encodeURIComponent(opened.workspace.id)}`,
							)
						}
					>
						Open workspace <ArrowRight size={14} />
					</Button>
				) : null}
			</header>
			{opened.apps.length === 0 ? (
				<Text role="body" tone="secondary" className="m-0">
					No apps in this workspace yet.
				</Text>
			) : (
				opened.apps.map((app) => (
					<SharedApp
						key={`${opened.role}:${app.id}`}
						app={app}
						workspaceId={workspaceId}
					/>
				))
			)}
		</main>
	);
}

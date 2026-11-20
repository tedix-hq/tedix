import { Eye } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
	Alert,
	AlertDescription,
	AlertTitle,
	LoadError,
} from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionHeader,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { ListSkeleton } from "@/components/list-skeleton";
import { LoadingArea } from "@/components/loading-area";
import { OutputContentView } from "@/components/output-content";
import { WorkspaceChat } from "@/components/workspace-chat";
import { workspaceActivityEntries } from "@/components/workspace-activity";
import { WorkspaceInspectionHistory } from "@/components/workspace-inspection-history";
import { osApi } from "@/lib/api";
import { osQuery, workspaceInspectionQuery } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import {
	createWorkspaceChatClient,
	type SocketLike,
	type WorkspaceChatClientOptions,
} from "@/lib/workspace-chat-client";

/** The OS worker opens an inspector's chat socket read-only. */
function createInspectionChatClient(options: WorkspaceChatClientOptions) {
	return createWorkspaceChatClient({
		...options,
		createSocket: (url) => {
			const inspected = new URL(url);
			inspected.searchParams.set("inspect", "1");
			return new WebSocket(inspected.toString()) as unknown as SocketLike;
		},
	});
}

/** Settings → Inspect workspaces: every workspace, and a recorded way in. */
export function AdminWorkspacesPage() {
	const navigate = useNavigate();
	const workspaces = useQuery(
		osQuery.osWorkspaces.inspections.workspaces.queryOptions({ input: {} }),
	);
	const [chosen, setChosen] = useState<{ id: string; name: string } | null>(
		null,
	);
	const [reason, setReason] = useState("");
	const start = useMutation({
		mutationFn: (workspaceId: string) =>
			osApi.osWorkspaces.inspections.start({
				workspaceId,
				...(reason.trim() ? { reason: reason.trim() } : {}),
			}),
		onSuccess: (started) =>
			void navigate({
				to: "/admin/workspaces/$workspaceId",
				params: { workspaceId: started.workspaceId },
			}),
	});
	return (
		<Page width="md">
			<PageHeader>
				<PageHeading>
					<PageTitle>Inspect workspaces</PageTitle>
					<PageDescription>
						Open any workspace of your organization read-only, including private
						ones. You can see its files, apps, chats and activity, but not
						change anything. Each visit is recorded in the audit log and shown
						to the workspace's members.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<PageSection>
				<SectionHeader>
					<SectionTitle>Workspaces</SectionTitle>
				</SectionHeader>
				{workspaces.isPending ? (
					<ListSkeleton />
				) : workspaces.isError ? (
					<LoadError
						title="Workspaces could not be loaded"
						error={workspaces.error}
						onRetry={() => void workspaces.refetch()}
						retrying={workspaces.isFetching}
					/>
				) : workspaces.data.items.length === 0 ? (
					<Text role="label" tone="secondary">
						This organization has no workspaces yet.
					</Text>
				) : (
					<Collection aria-label="Workspaces">
						{workspaces.data.items.map((workspace) => (
							<li
								key={workspace.id}
								className="flex min-w-0 items-center gap-3 px-4 py-3"
							>
								<div className="min-w-0 flex-1">
									<Text weight="medium" className="truncate">
										{sanitizeUntrustedText(workspace.name)}
									</Text>
									<Text role="label" tone="secondary">
										{workspace.visibility === "private"
											? `Private${workspace.ownerName ? ` · ${sanitizeUntrustedText(workspace.ownerName)}` : ""}`
											: "Open to the organization"}
									</Text>
								</div>
								<Button
									variant="outline"
									size="sm"
									icon={<Eye />}
									onClick={() => {
										setReason("");
										start.reset();
										setChosen({ id: workspace.id, name: workspace.name });
									}}
								>
									Inspect
								</Button>
							</li>
						))}
					</Collection>
				)}
			</PageSection>
			<ConfirmDialog
				open={chosen !== null}
				onOpenChange={(open) => {
					if (!open) setChosen(null);
				}}
				title={`Inspect ${chosen ? sanitizeUntrustedText(chosen.name) : "workspace"}?`}
				description="You will see this workspace read-only for one hour. Your visit is recorded in the audit log, and its members see that an organization admin inspected it."
				confirmLabel="Start inspection"
				pendingLabel="Starting…"
				isPending={start.isPending}
				error={start.error}
				onConfirm={() => {
					if (chosen) start.mutate(chosen.id);
				}}
			>
				<label className="grid gap-2 text-sm">
					Reason (optional, kept in the audit log)
					<Textarea
						aria-label="Reason"
						value={reason}
						maxLength={500}
						onChange={(event) => setReason(event.target.value)}
					/>
				</label>
			</ConfirmDialog>
		</Page>
	);
}

type InspectionTab = "files" | "apps" | "chat" | "activity";

/** One workspace, read-only, while the admin's recorded inspection lasts. */
export function WorkspaceInspectionPage({
	workspaceId,
}: {
	workspaceId: string;
}) {
	const inspection = workspaceInspectionQuery(workspaceId);
	const [tab, setTab] = useState<InspectionTab>("files");
	const workspace = useQuery(
		inspection.osWorkspaces.workspaces.get.queryOptions({
			input: { workspaceId },
			retry: false,
		}),
	);
	return (
		<Page width="lg">
			<Alert variant="info" data-workspace-inspection-banner>
				<AlertTitle>Inspecting read-only. Your visit is recorded.</AlertTitle>
				<AlertDescription>
					You cannot change anything or send messages here. The inspection ends
					one hour after you started it.{" "}
					<Link href="/admin/workspaces">Back to workspaces</Link>
				</AlertDescription>
			</Alert>
			{workspace.isPending ? (
				<LoadingArea label="Opening workspace" />
			) : workspace.isError ? (
				<Alert variant="destructive">
					<AlertTitle>This workspace cannot be inspected now</AlertTitle>
					<AlertDescription>
						Your inspection may have ended, or the workspace was removed. Start
						it again from{" "}
						<Link href="/admin/workspaces">Inspect workspaces</Link>.
					</AlertDescription>
				</Alert>
			) : (
				<>
					<PageHeader>
						<PageHeading>
							<PageTitle>
								{sanitizeUntrustedText(workspace.data.workspace.name)}
							</PageTitle>
						</PageHeading>
					</PageHeader>
					<div className="flex flex-wrap gap-2" role="group" aria-label="Show">
						{(
							[
								["files", "Files"],
								["apps", "Apps"],
								["chat", "Chat"],
								["activity", "Activity"],
							] as const
						).map(([value, label]) => (
							<Button
								key={value}
								aria-pressed={tab === value}
								variant={tab === value ? "default" : "outline"}
								size="sm"
								onClick={() => setTab(value)}
							>
								{label}
							</Button>
						))}
					</div>
					{tab === "files" ? (
						<InspectedFiles workspaceId={workspaceId} />
					) : tab === "apps" ? (
						<InspectedApps workspaceId={workspaceId} />
					) : tab === "chat" ? (
						<InspectedChat workspaceId={workspaceId} />
					) : (
						<InspectedActivity workspaceId={workspaceId} />
					)}
				</>
			)}
		</Page>
	);
}

function InspectedFiles({ workspaceId }: { workspaceId: string }) {
	const inspection = workspaceInspectionQuery(workspaceId);
	const [openId, setOpenId] = useState<string | null>(null);
	const files = useQuery(
		inspection.osWorkspaces.outputs.list.queryOptions({
			input: { workspaceId, limit: 100 },
		}),
	);
	if (files.isPending) return <ListSkeleton />;
	if (files.isError)
		return (
			<LoadError
				title="Files could not be loaded"
				error={files.error}
				onRetry={() => void files.refetch()}
				retrying={files.isFetching}
			/>
		);
	if (files.data.items.length === 0)
		return (
			<Text role="label" tone="secondary">
				This workspace has no files.
			</Text>
		);
	return (
		<div className="grid gap-4">
			<Collection aria-label="Files">
				{files.data.items.map((file) => (
					<li key={file.id}>
						<button
							type="button"
							className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left"
							aria-pressed={openId === file.id}
							onClick={() => setOpenId(openId === file.id ? null : file.id)}
						>
							<Text weight="medium" className="min-w-0 flex-1 truncate">
								{sanitizeUntrustedText(file.title)}
							</Text>
							<Text role="caption" tone="secondary">
								{file.kind} · {relativeTime(file.updatedAt)}
							</Text>
						</button>
					</li>
				))}
			</Collection>
			{openId ? (
				<InspectedFile workspaceId={workspaceId} outputId={openId} />
			) : null}
		</div>
	);
}

function InspectedFile({
	workspaceId,
	outputId,
}: {
	workspaceId: string;
	outputId: string;
}) {
	const inspection = workspaceInspectionQuery(workspaceId);
	const file = useQuery(
		inspection.osWorkspaces.outputs.get.queryOptions({
			input: { outputId },
			retry: false,
		}),
	);
	if (file.isPending) return <LoadingArea label="Loading file" />;
	if (file.isError)
		return (
			<Text role="label" tone="secondary">
				This file cannot be shown. Files made from someone's connected accounts
				stay private to the people who may use those accounts.
			</Text>
		);
	return (
		<section
			aria-label={file.data.output.title}
			className="rounded-lg border border-kumo-line p-4"
		>
			<OutputContentView
				content={file.data.currentRevision.content}
				renderFile={() => (
					<Text role="label" tone="secondary">
						The uploaded file itself is not shown while inspecting.
					</Text>
				)}
			/>
		</section>
	);
}

function InspectedApps({ workspaceId }: { workspaceId: string }) {
	const inspection = workspaceInspectionQuery(workspaceId);
	const apps = useQuery(
		inspection.osWorkspaces.gadgets.list.queryOptions({
			input: { workspaceId, limit: 100 },
		}),
	);
	if (apps.isPending) return <ListSkeleton />;
	if (apps.isError)
		return (
			<LoadError
				title="Apps could not be loaded"
				error={apps.error}
				onRetry={() => void apps.refetch()}
				retrying={apps.isFetching}
			/>
		);
	if (apps.data.items.length === 0)
		return (
			<Text role="label" tone="secondary">
				This workspace has no apps.
			</Text>
		);
	return (
		<div className="grid gap-2">
			<Text role="label" tone="secondary">
				Apps are listed, not run: running one would act as the workspace's
				members.
			</Text>
			<Collection aria-label="Apps">
				{apps.data.items.map((app) => (
					<li key={app.id} className="grid gap-0.5 px-4 py-3">
						<Text weight="medium">{sanitizeUntrustedText(app.name)}</Text>
						{app.description ? (
							<Text role="label" tone="secondary">
								{sanitizeUntrustedText(app.description)}
							</Text>
						) : null}
					</li>
				))}
			</Collection>
		</div>
	);
}

function InspectedChat({ workspaceId }: { workspaceId: string }) {
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [listOpen, setListOpen] = useState(true);
	return (
		<div className="h-[70vh] min-h-96">
			<WorkspaceChat
				workspaceId={workspaceId}
				conversationId={conversationId}
				listOpen={listOpen}
				onOpenList={() => setListOpen(true)}
				onSelectConversation={(id) => {
					setConversationId(id);
					setListOpen(id === null);
				}}
				viewOnly
				emptyText="Pick a conversation to read it."
				createClient={createInspectionChatClient}
			/>
		</div>
	);
}

function InspectedActivity({ workspaceId }: { workspaceId: string }) {
	const inspection = workspaceInspectionQuery(workspaceId);
	const activity = useQuery(
		inspection.osWorkspaces.workspaces.activity.queryOptions({
			input: { workspaceId, kinds: ["output", "run"], limit: 50 },
		}),
	);
	if (activity.isPending) return <ListSkeleton />;
	if (activity.isError)
		return (
			<LoadError
				title="Activity could not be loaded"
				error={activity.error}
				onRetry={() => void activity.refetch()}
				retrying={activity.isFetching}
			/>
		);
	const entries = workspaceActivityEntries(activity.data.items, workspaceId);
	return (
		<div className="grid gap-4">
			<WorkspaceInspectionHistory
				workspaceId={workspaceId}
				query={inspection}
			/>
			{entries.length === 0 ? (
				<Text role="label" tone="secondary">
					Nothing recent has been recorded here.
				</Text>
			) : (
				<ol className="m-0 grid list-none gap-1 p-0">
					{entries.map((entry) => (
						<li key={entry.id} className="border-b border-kumo-hairline py-2">
							<Text as="p" role="label" className="m-0 wrap-anywhere">
								{sanitizeUntrustedText(entry.lead)}
								{entry.file
									? ` ${sanitizeUntrustedText(entry.file.title)}`
									: ""}
								{entry.tail}
							</Text>
							<Text as="span" role="caption" tone="secondary">
								<time dateTime={entry.at} title={absoluteTime(entry.at)}>
									{relativeTime(entry.at)}
								</time>
							</Text>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

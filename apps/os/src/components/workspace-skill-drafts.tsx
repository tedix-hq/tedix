import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { Input } from "@/components/kumo/input";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { SkillWorkflowDraftDialog } from "@/components/skill-workflow-drafts";
import { osApi } from "@/lib/api";
import { errorDetails, errorMessage } from "@/lib/orpc-error";
import { useCanManageTedis } from "@/lib/tedi-permissions";
import {
	membersListQueryOptions,
	osQuery,
	skillDetailQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

export function WorkspaceSkillDrafts({
	workspaceId,
	resource,
}: {
	workspaceId: string;
	resource: OsWorkspaceResource;
}) {
	const queryClient = useQueryClient();
	const context = useOsOperationalContext();
	const target = { workspaceId, resourceId: resource.id };
	const access = useQuery({
		...osQuery.skills.getWorkspaceDraftGrant.queryOptions({ input: target }),
		retry: false,
	});
	const history = useQuery({
		...osQuery.skills.listWorkspaceDraftProposals.queryOptions({
			input: target,
		}),
		retry: false,
	});
	const canManage =
		context.data?.authority.permissions.includes("team:manage") === true;
	const members = useQuery({
		...membersListQueryOptions({
			organizationId: context.data?.organization.id ?? "",
			limit: 100,
			offset: 0,
		}),
		enabled: canManage,
	});
	const [memberId, setMemberId] = useState("");
	const selectedMember = members.data?.data.find(
		(member) => member.id === memberId,
	);
	const selectedAccess = useQuery({
		...osQuery.skills.getWorkspaceDraftGrant.queryOptions({
			input: { ...target, memberId },
		}),
		enabled: canManage && !!memberId,
		retry: false,
	});
	const [source, setSource] = useState<SkillEntry | null>(null);
	const [viewing, setViewing] = useState<string | null>(null);
	const load = useMutation({
		mutationFn: async () => {
			const result = await queryClient.fetchQuery({
				...skillDetailQueryOptions(resource.providerResourceId),
				staleTime: 0,
			});
			if (!result.entry)
				throw new Error(
					"The linked skill could not be loaded. Refresh this workspace and try again.",
				);
			return result;
		},
		onSuccess: (result) => {
			if (result.entry) setSource(result.entry);
		},
	});
	const grant = useMutation({
		mutationFn: (enabled: boolean) =>
			osApi.skills.setWorkspaceDraftGrant({
				...target,
				memberId,
				enabled,
				expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: osQuery.skills.getWorkspaceDraftGrant.key(),
			}),
	});
	const allowed = access.data?.effective === true;
	return (
		<div className="mt-2 grid gap-2" data-workspace-skill-drafts>
			<Text as="p" role="label" tone="secondary" className="m-0">
				{allowed
					? "You can propose draft changes. An owner reviews them before use."
					: access.isError
						? "Draft access could not be checked."
						: "An owner can allow draft changes to this skill in this workspace."}
			</Text>
			<Button
				size="sm"
				variant="outline"
				disabled={!allowed || load.isPending}
				onClick={() => load.mutate()}
			>
				{load.isPending ? "Loading skill…" : "Propose changes"}
			</Button>
			{load.isError && (
				<Text role="label" tone="error">
					{errorMessage(load.error)}
				</Text>
			)}
			{canManage && (
				<div className="grid gap-2">
					<Select
						value={memberId}
						onValueChange={(value) => {
							if (value) {
								setMemberId(value);
								grant.reset();
							}
						}}
					>
						<SelectTrigger aria-label={`Draft access for ${resource.name}`}>
							<SelectValue placeholder="Choose a member for draft access" />
						</SelectTrigger>
						<SelectContent>
							{(members.data?.data ?? [])
								.filter((member) => member.status === "active")
								.map((member) => (
									<SelectItem key={member.id} value={member.id}>
										{member.name
											? `${member.name} · ${member.email}`
											: member.email}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
					{memberId && (
						<div aria-label="Selected member draft access">
							<Text as="p" role="label">
								{selectedMember?.email} · {resource.name}
							</Text>
							<Text as="p" role="label" tone="secondary">
								Workspace: {workspaceId} · Resource: {resource.id}
								{selectedAccess.isPending
									? " · Checking access…"
									: selectedAccess.isError
										? " · Access could not be checked."
										: selectedAccess.data?.effective
											? " · Draft access allowed."
											: " · No current draft access."}
							</Text>
							{selectedAccess.data?.grant && (
								<Text as="p" role="label" tone="secondary">
									Skill: {selectedAccess.data.grant.skillId} · Expires:{" "}
									<time dateTime={selectedAccess.data.grant.expiresAt}>
										{selectedAccess.data.grant.expiresAt}
									</time>
								</Text>
							)}
							{selectedAccess.isError && (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => void selectedAccess.refetch()}
								>
									Retry member access
								</Button>
							)}
						</div>
					)}
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={!memberId || grant.isPending}
							onClick={() => grant.mutate(true)}
						>
							Allow drafts for 7 days
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={!memberId || grant.isPending}
							onClick={() => grant.mutate(false)}
						>
							Revoke draft access
						</Button>
					</div>
					{grant.isError && (
						<Text role="label" tone="error">
							{grant.error.message}
						</Text>
					)}
					{grant.isSuccess &&
						grant.data.grant.memberId === memberId &&
						grant.data.grant.workspaceId === workspaceId &&
						grant.data.grant.resourceId === resource.id && (
							<Text role="label" tone="secondary">
								{grant.data.grant.enabled
									? "Draft access saved for this skill and workspace."
									: "Draft access revoked."}
							</Text>
						)}
				</div>
			)}
			{source && (
				<WorkspaceSkillDraftEditor
					workspaceId={workspaceId}
					resourceId={resource.id}
					source={source}
					close={() => setSource(null)}
				/>
			)}
			{history.isError && (
				<div>
					<Text role="label" tone="error">
						Saved drafts could not be loaded. Check again before creating
						another proposal.
					</Text>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => void history.refetch()}
					>
						Retry saved drafts
					</Button>
				</div>
			)}
			{history.data?.proposals.map((proposal) => (
				<Button
					key={proposal.id}
					size="sm"
					variant="ghost"
					onClick={() => setViewing(proposal.id)}
				>
					View {proposal.status === "withdrawn" ? "withdrawn" : "pending"} draft
					from v{proposal.sourceRevision} · {proposal.reason}
				</Button>
			))}
			{viewing && (
				<WorkspaceSkillDraftReview
					workspaceId={workspaceId}
					resourceId={resource.id}
					proposalId={viewing}
					close={() => setViewing(null)}
				/>
			)}
		</div>
	);
}

function WorkspaceSkillDraftEditor({
	workspaceId,
	resourceId,
	source,
	close,
}: {
	workspaceId: string;
	resourceId: string;
	source: SkillEntry;
	close: () => void;
}) {
	const [content, setContent] = useState(source.content);
	const [workflow, setWorkflow] = useState(
		source.files?.["scripts/workflow.ts"] ?? "",
	);
	const [reason, setReason] = useState("");
	const [requestId] = useState(() => crypto.randomUUID());
	const queryClient = useQueryClient();
	const propose = useMutation({
		mutationFn: () =>
			osApi.skills.proposeWorkspaceRevision({
				workspaceId,
				resourceId,
				requestId,
				expectedSourceRevision: source.revision,
				content,
				...(source.files?.["scripts/workflow.ts"] !== undefined
					? { files: { ...source.files, "scripts/workflow.ts": workflow } }
					: {}),
				reason,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: osQuery.skills.listWorkspaceDraftProposals.key(),
			}),
	});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent size="xl">
				<DialogHeader>
					<DialogTitle>Propose changes to {source.title}</DialogTitle>
					<DialogDescription>
						Based on version {source.revision}. Save a separate draft for owner
						review before use.
					</DialogDescription>
				</DialogHeader>
				{propose.isSuccess ? (
					<div className="grid gap-2">
						<Text>Your draft was saved. It needs owner review before use.</Text>
						<WorkspaceSkillDraftReviewBody
							workspaceId={workspaceId}
							resourceId={resourceId}
							proposalId={propose.data.proposal.id}
						/>
					</div>
				) : (
					<div className="grid max-h-[60vh] gap-3 overflow-y-auto">
						<label className="grid gap-1 text-sm">
							Instructions
							<Textarea
								aria-label="Draft skill instructions"
								rows={10}
								value={content}
								maxLength={200_000}
								onChange={(event) => setContent(event.target.value)}
							/>
						</label>
						{source.files?.["scripts/workflow.ts"] !== undefined && (
							<label className="grid gap-1 text-sm">
								Automation source
								<Textarea
									aria-label="Draft automation source"
									rows={10}
									value={workflow}
									maxLength={500_000}
									onChange={(event) => setWorkflow(event.target.value)}
								/>
							</label>
						)}
						<label className="grid gap-1 text-sm">
							Why this change
							<Textarea
								aria-label="Draft change reason"
								rows={2}
								value={reason}
								maxLength={2000}
								onChange={(event) => setReason(event.target.value)}
							/>
						</label>
						<details>
							<summary>Review changes from version {source.revision}</summary>
							<DraftDiff base={source.content} next={content} />
							{source.files?.["scripts/workflow.ts"] !== undefined && (
								<DraftDiff
									base={source.files["scripts/workflow.ts"]}
									next={workflow}
								/>
							)}
						</details>
						{propose.isError && (
							<div role="alert" className="grid gap-1">
								<Text role="label" tone="error" className="m-0">
									The draft could not be saved:{" "}
									{errorMessage(propose.error, "Tedix gave no reason.")}
								</Text>
								{errorDetails(propose.error).map((line) => (
									<Text key={line} role="label" tone="error" className="m-0">
										{line}
									</Text>
								))}
							</div>
						)}
					</div>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={close}>
						Close
					</Button>
					{!propose.isSuccess && (
						<Button
							disabled={
								propose.isPending || !content.trim() || reason.trim().length < 8
							}
							onClick={() => propose.mutate()}
						>
							{propose.isPending ? "Saving draft…" : "Save draft for review"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function workspaceSkillDraftDiff(base: string, next: string): string {
	if (base === next) return "No changes.";
	const before = base.split("\n"),
		after = next.split("\n");
	let prefix = 0,
		suffix = 0;
	while (
		prefix < before.length &&
		prefix < after.length &&
		before[prefix] === after[prefix]
	)
		prefix++;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	)
		suffix++;
	const lines = [
		...before.slice(Math.max(0, prefix - 2), prefix).map((line) => `  ${line}`),
		...before.slice(prefix, before.length - suffix).map((line) => `- ${line}`),
		...after.slice(prefix, after.length - suffix).map((line) => `+ ${line}`),
		...after
			.slice(after.length - suffix, after.length - suffix + 2)
			.map((line) => `  ${line}`),
	];
	return (
		lines.slice(0, 500).join("\n") +
		(lines.length > 500
			? "\n… Preview limited to 500 lines. Open the saved draft to read its full instructions and automation."
			: "")
	);
}

function DraftDiff({ base, next }: { base: string; next: string }) {
	return (
		<pre
			className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs"
			aria-label="Draft changes"
		>
			{workspaceSkillDraftDiff(base, next)}
		</pre>
	);
}

function WorkspaceSkillDraftReview({
	close,
	...target
}: {
	workspaceId: string;
	resourceId: string;
	proposalId: string;
	close: () => void;
}) {
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent size="xl">
				<DialogHeader>
					<DialogTitle>Saved draft proposal</DialogTitle>
					<DialogDescription>
						Review material only. It cannot run or change the live skill.
					</DialogDescription>
				</DialogHeader>
				<WorkspaceSkillDraftReviewBody {...target} />
				<DialogFooter>
					<Button onClick={close}>Close</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function WorkspaceSkillDraftReviewBody(target: {
	workspaceId: string;
	resourceId: string;
	proposalId: string;
}) {
	const queryClient = useQueryClient();
	const detail = useQuery({
		...osQuery.skills.getWorkspaceDraftProposal.queryOptions({ input: target }),
		retry: false,
	});
	const withdraw = useMutation({
		mutationFn: () => osApi.skills.withdrawWorkspaceDraftProposal(target),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: osQuery.skills.getWorkspaceDraftProposal.key(),
				}),
				queryClient.invalidateQueries({
					queryKey: osQuery.skills.listWorkspaceDraftProposals.key(),
				}),
			]),
	});
	const proposal = detail.data?.proposal;
	if (!proposal)
		return (
			<Text role="label" tone={detail.isError ? "error" : "secondary"}>
				{detail.isError ? detail.error.message : "Reading saved draft…"}
			</Text>
		);
	return (
		<div className="grid max-h-[60vh] gap-3 overflow-y-auto">
			<Text>
				Base version {proposal.sourceRevision} ·{" "}
				{proposal.status === "withdrawn"
					? "Withdrawn; history retained"
					: "Pending owner review"}
			</Text>
			<Text>{proposal.reason}</Text>
			<Text role="label">Receipt: {proposal.id}</Text>
			<DraftDiff base={proposal.baseContent} next={proposal.content} />
			<details>
				<summary>Full proposed instructions</summary>
				<pre className="whitespace-pre-wrap break-words text-xs">
					{proposal.content}
				</pre>
			</details>
			{proposal.files?.["scripts/workflow.ts"] !== undefined && (
				<>
					<Text role="label">Automation changes</Text>
					<DraftDiff
						base={proposal.baseFiles?.["scripts/workflow.ts"] ?? ""}
						next={proposal.files["scripts/workflow.ts"]}
					/>
					<details>
						<summary>Full proposed automation</summary>
						<pre className="whitespace-pre-wrap break-words text-xs">
							{proposal.files["scripts/workflow.ts"]}
						</pre>
					</details>
				</>
			)}
			{detail.data?.canWithdraw && (
				<Button
					size="sm"
					variant="outline"
					disabled={withdraw.isPending}
					onClick={() => withdraw.mutate()}
				>
					Withdraw my draft
				</Button>
			)}
			{withdraw.isError && (
				<Text role="label" tone="error">
					{errorMessage(withdraw.error)}
				</Text>
			)}
			{proposal.status === "pending" &&
			proposal.files?.["scripts/workflow.ts"] !== undefined ? (
				<WorkspaceDraftTestPath
					skillId={proposal.skillId}
					content={proposal.content}
					workflow={proposal.files["scripts/workflow.ts"]}
					reason={proposal.reason}
					proposalId={proposal.id}
				/>
			) : null}
		</div>
	);
}

/**
 * Owners and admins take a saved workspace draft down the same path as any
 * automation change: a testable draft on the skill's Versions page. Members
 * without that permission see nothing here; the owner review stays theirs.
 */
function WorkspaceDraftTestPath({
	skillId,
	content,
	workflow,
	reason,
	proposalId,
}: {
	skillId: string;
	content: string;
	workflow: string;
	reason: string;
	proposalId: string;
}) {
	const canManage = useCanManageTedis();
	const queryClient = useQueryClient();
	const [baseline, setBaseline] = useState<SkillEntry | null>(null);
	const load = useMutation({
		mutationFn: async () => {
			const result = await queryClient.fetchQuery({
				...skillDetailQueryOptions(skillId),
				staleTime: 0,
			});
			if (!result.entry)
				throw new Error("The linked skill could not be loaded.");
			return result.entry;
		},
		onSuccess: setBaseline,
	});
	if (!canManage) return null;
	return (
		<div className="grid gap-1">
			<Button
				size="sm"
				variant="outline"
				disabled={load.isPending}
				onClick={() => load.mutate()}
			>
				{load.isPending ? "Loading skill…" : "Test and switch on this draft"}
			</Button>
			<Text role="label" tone="secondary" className="m-0">
				Creates a testable draft from this proposal on the skill's Versions
				page. Nothing changes until that draft passes its test and is switched
				on.
			</Text>
			{load.isError && (
				<Text role="label" tone="error">
					{errorMessage(load.error)}
				</Text>
			)}
			{baseline && (
				<SkillWorkflowDraftDialog
					baseline={baseline}
					seed={{
						content,
						workflow,
						reason: `${reason} (workspace draft ${proposalId})`,
						origin: "from a workspace draft",
					}}
					close={() => setBaseline(null)}
					afterSave={
						<Link
							to="/skills/$skillId/versions"
							params={{ skillId }}
							className="w-fit underline"
						>
							Open Versions to test and switch it on
						</Link>
					}
				/>
			)}
		</div>
	);
}

export function WorkspaceSkillDraftPanel({
	workspaceId,
	resources,
}: {
	workspaceId: string;
	resources: OsWorkspaceResource[];
}) {
	const context = useOsOperationalContext();
	const queryClient = useQueryClient();
	const canManage =
		context.data?.authority.permissions.includes("team:manage") === true;
	const [search, setSearch] = useState("");
	const [skillId, setSkillId] = useState("");
	const skills = useQuery({
		...osQuery.skills.listByOrg.queryOptions({
			input: {
				summary: true,
				limit: 100,
				offset: 0,
				query: search || undefined,
			},
		}),
		enabled: canManage,
	});
	const available = (skills.data?.entries ?? []).filter(
		(skill) =>
			skill.lifecycleState !== "archived" &&
			!resources.some((resource) => resource.providerResourceId === skill.id),
	);
	const attach = useMutation({
		mutationFn: () => {
			const selected = available.find((skill) => skill.id === skillId);
			if (!selected) throw new Error("Choose an existing skill.");
			return osApi.osWorkspaces.resources.create({
				workspaceId,
				selection: {
					providerId: "tedix",
					connectionScope: "tenant",
					resourceType: "skill",
					providerResourceId: selected.id,
					name: selected.title,
					metadata: {},
					requiredScopes: [],
				},
			});
		},
		onSuccess: () => {
			setSkillId("");
			return queryClient.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
			});
		},
	});
	if (!canManage && !resources.length) return null;
	return (
		<section className="grid gap-3" aria-label="Skill draft proposals">
			<SectionEyebrow title="Skill draft proposals" />
			{resources.map((resource) => (
				<div key={resource.id} className="rounded border p-3">
					<Text weight="semibold">{resource.name}</Text>
					<WorkspaceSkillDrafts workspaceId={workspaceId} resource={resource} />
				</div>
			))}
			{canManage && (
				<details>
					<summary>Link an existing skill</summary>
					<div className="mt-2 grid gap-2">
						<Input
							aria-label="Find existing skill"
							placeholder="Find a skill by name or slug"
							value={search}
							onChange={(event) => {
								setSearch(event.target.value);
								setSkillId("");
							}}
						/>
						<Select
							value={skillId}
							onValueChange={(value) => value && setSkillId(value)}
						>
							<SelectTrigger aria-label="Existing workspace skill">
								<SelectValue placeholder="Choose an existing skill" />
							</SelectTrigger>
							<SelectContent>
								{available.map((skill) => (
									<SelectItem key={skill.id} value={skill.id}>
										{skill.title} · {skill.slug} · v{skill.revision}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							size="sm"
							variant="outline"
							disabled={!skillId || attach.isPending}
							onClick={() => attach.mutate()}
						>
							Link selected skill
						</Button>
						{attach.isError && (
							<Text role="label" tone="error">
								{attach.error.message}
							</Text>
						)}
					</div>
				</details>
			)}
		</section>
	);
}

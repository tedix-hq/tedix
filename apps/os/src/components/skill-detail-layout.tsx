import { DetailUnavailable } from "@/components/detail-unavailable";
import { ListSkeleton } from "@/components/list-skeleton";
import { Text } from "@/components/kumo/text";
import { FolderOpen, Play } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Link,
	Outlet,
	useNavigate,
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import { useState } from "react";
import * as z from "zod";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { FormField } from "@/components/kumo/forms/form-field";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { jsonTextSchema } from "@/components/kumo/forms/json-text-schema";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Page,
	PageActions,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageMeta,
	PageTitle,
} from "@/components/kumo/page";
import { sentenceCase } from "@/lib/format";
import { SelectItem } from "@/components/kumo/select";
import { KumoTabs } from "@/components/kumo/tabs";
import { useSkillsWebMcpTools } from "@/components/skills-webmcp-tools";
import { osApi } from "@/lib/api";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import {
	osQueryKeys,
	skillDetailQueryOptions,
	skillRunsQueryOptions,
	skillRunStatusQueryOptions,
	skillSpecificSchedulesQueryOptions,
	tediRosterQueryOptions,
	workflowDefinitionHealthQueryOptions,
	WORKFLOW_DEFINITIONS_LIMIT,
} from "@/lib/os-query-options";
import { skillDraftReason } from "@/lib/skill-draft-reason";
import {
	TEDIS_MANAGE_DENIED_REASON,
	useCanManageTedis,
} from "@/lib/tedi-permissions";

function parseRunParams(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Run parameters must be a JSON object.");
	}
	return parsed as Record<string, unknown>;
}

const skillRunSchema = z.object({
	tediId: z.string().min(1, "Select a tedi."),
	paramsText: jsonTextSchema(parseRunParams),
});

const SKILL_TABS = [
	"overview",
	"runs",
	"versions",
	"settings",
	"source",
] as const;

export function SkillDetailLayout() {
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	useSkillsWebMcpTools(skillId);
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const skill = detail.data?.entry;
	const roster = useQuery(tediRosterQueryOptions(100));
	const [dialogOpen, setDialogOpen] = useState(false);
	const [testRun, setTestRun] = useState(false);
	const [folderDialogOpen, setFolderDialogOpen] = useState(false);
	const [folderDraft, setFolderDraft] = useState("");
	const canRun = useCanManageTedis();
	const context = useOsOperationalContext();
	const role = context.data?.authority.role;
	const canTurnBackOn =
		skill?.lifecycleState === "draft" && (role === "owner" || role === "admin");
	const activeTab =
		SKILL_TABS.find((tab) => pathname.endsWith(`/${tab}`)) ?? "overview";
	const executable = Boolean(skill?.files?.["scripts/workflow.ts"]);
	// A draft says why it is a draft; the reads are the ones its tabs use.
	const isDraft = skill?.lifecycleState === "draft";
	const draftRuns = useQuery({
		...skillRunsQueryOptions(skillId),
		enabled: isDraft,
	});
	const draftSchedules = useQuery({
		...skillSpecificSchedulesQueryOptions(skillId),
		enabled: isDraft,
	});
	const draftBeforeError = skill
		? skillDraftReason({
				skill,
				runs: draftRuns.data?.runs,
				schedules: draftSchedules.data?.schedules,
				canTurnOn: Boolean(canTurnBackOn),
			})
		: null;
	const failedRunId = draftBeforeError?.lastFailedRunId ?? null;
	const failedRun = useQuery({
		...skillRunStatusQueryOptions(failedRunId ?? ""),
		enabled: Boolean(failedRunId),
	});
	const draft =
		skill && draftBeforeError
			? skillDraftReason({
					skill,
					runs: draftRuns.data?.runs,
					schedules: draftSchedules.data?.schedules,
					lastError: failedRun.data?.error,
					canTurnOn: Boolean(canTurnBackOn),
				})
			: null;
	const canTest = executable && canRun && canTurnBackOn;
	// Turning on leads only once the newest run of this version completed.
	const turnOnLeads =
		!canTest || (draft != null && draft.kind !== "unknown" && !draft.testFirst);
	const openTest = () => {
		setTestRun(true);
		setDialogOpen(true);
	};

	const runNow = useMutation({
		mutationFn: (input: { tediId: string; params: Record<string, unknown> }) =>
			osApi.skills.runWorkflow({
				skillId,
				...(testRun
					? { certification: true, expectedSkillRevision: skill?.revision }
					: {}),
				tediId: input.tediId,
				params: input.params,
				idempotencyKey: crypto.randomUUID(),
				confirmDestructive: true,
				reason: "Operator run-now from the Tedix OS skill detail surface",
			}),
		onSuccess: (result) => {
			setDialogOpen(false);
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skillRuns() });
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skills() });
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skillSchedules() });
			queryClient.invalidateQueries({
				queryKey: workflowDefinitionHealthQueryOptions(
					WORKFLOW_DEFINITIONS_LIMIT,
				).queryKey,
			});
			void navigate({
				to: "/work/runs/$runId",
				params: { runId: result.runId },
			});
		},
	});
	const runForm = useZodForm({
		schema: skillRunSchema,
		defaultValues: { tediId: "", paramsText: "{}" },
		onSubmit: ({ value }) =>
			runNow.mutate({ tediId: value.tediId, params: value.paramsText }),
	});
	const moveSkill = useMutation({
		mutationFn: (folderPath: string | null) =>
			osApi.skills.move({ id: skillId, folderPath }),
		onSuccess: () => {
			setFolderDialogOpen(false);
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skills() });
		},
	});

	const turnBackOn = useMutation({
		mutationFn: () =>
			osApi.skills.improve({
				id: skillId,
				lifecycleState: "active",
				force: true,
				revisionReasoning:
					"Owner or admin turned the skill back on from its Tedix OS page.",
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skills() });
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skillSchedules() });
			queryClient.invalidateQueries({
				queryKey: workflowDefinitionHealthQueryOptions(
					WORKFLOW_DEFINITIONS_LIMIT,
				).queryKey,
			});
		},
	});

	const needsTest =
		(turnBackOn.error as { data?: { rule?: string } } | null)?.data?.rule ===
		"pace_layer_requires_eval";

	if (!skill)
		return (
			<Page width="lg">
				<PageBack render={<Link to="/skills" />}>All skills</PageBack>
				{detail.isPending ? (
					<ListSkeleton rows={6} />
				) : (
					<DetailUnavailable
						resource="Skill"
						error={detail.error}
						onRetry={() => detail.refetch()}
						retrying={detail.isFetching}
					/>
				)}
			</Page>
		);
	return (
		<Page width="lg">
			<PageBack render={<Link to="/skills" />}>All skills</PageBack>
			<div className="grid min-w-0 gap-4">
				<PageHeader>
					<PageHeading>
						<PageTitle>{skill.title}</PageTitle>
						<PageDescription>
							{skill.summary ?? skill.description ?? "Reusable procedure"}
						</PageDescription>
						<PageMeta>
							<li>Revision {skill.revision}</li>
							{skill.lifecycleState ? (
								<li>{sentenceCase(skill.lifecycleState)}</li>
							) : null}
						</PageMeta>
					</PageHeading>
					{executable || canRun || canTurnBackOn ? (
						<PageActions>
							{canTest ? (
								<Button
									variant={turnOnLeads ? "outline" : "default"}
									onClick={openTest}
								>
									Run a test
								</Button>
							) : null}
							{canTurnBackOn ? (
								<Button
									variant={turnOnLeads ? "default" : "outline"}
									disabled={turnBackOn.isPending}
									onClick={() => turnBackOn.mutate()}
								>
									{turnBackOn.isPending ? "Turning back on…" : "Turn back on"}
								</Button>
							) : null}
							{canRun ? (
								<Button
									variant="outline"
									onClick={() => {
										setFolderDraft(skill.folderPath ?? "");
										setFolderDialogOpen(true);
									}}
								>
									<FolderOpen size={15} /> Move
								</Button>
							) : null}
							{executable ? (
								<Button
									disabled={!canRun}
									title={canRun ? undefined : TEDIS_MANAGE_DENIED_REASON}
									onClick={() => {
										setTestRun(false);
										setDialogOpen(true);
									}}
								>
									<Play size={15} /> Run now
								</Button>
							) : null}
						</PageActions>
					) : null}
				</PageHeader>
				{draft ? (
					<Alert
						variant={draft.kind === "failed_runs" ? "warning" : "info"}
						aria-label="Why this skill is a draft"
					>
						<AlertTitle>{draft.title}</AlertTitle>
						<AlertDescription className="grid gap-2 text-pretty">
							{draft.why.map((line) => (
								<div key={line} className="[overflow-wrap:anywhere]">
									{line}
								</div>
							))}
							{draft.lastFailedRunId ? (
								<div>
									<Link
										to="/work/runs/$runId"
										params={{ runId: draft.lastFailedRunId }}
									>
										Open the failed run
									</Link>
								</div>
							) : null}
							<div>
								<span className="font-medium">What to do next</span>
								<ol className="m-0 mt-1 grid list-decimal gap-1 pl-5">
									{draft.next.map((step) => (
										<li key={step}>{step}</li>
									))}
								</ol>
							</div>
						</AlertDescription>
					</Alert>
				) : null}
				{turnBackOn.error ? (
					<div role="alert">
						<Text role="label" tone="error">
							{needsTest
								? "This version hasn't passed a test run yet; run a test first, then turn it back on."
								: `Couldn't turn this skill back on: ${
										(turnBackOn.error as Error).message ||
										"try again or ask an owner for help."
									}`}
						</Text>
						{needsTest && executable && canRun && canTurnBackOn ? (
							<Button variant="outline" onClick={openTest}>
								Run a test first
							</Button>
						) : null}
					</div>
				) : null}
				<KumoTabs
					aria-label="Skill detail sections"
					variant="underline"
					value={activeTab}
					tabs={SKILL_TABS.map((tab) => ({
						value: tab,
						label: sentenceCase(tab),
						nativeButton: false,
						render: (
							<Link
								to={
									tab === "overview"
										? "/skills/$skillId"
										: `/skills/$skillId/${tab}`
								}
								params={{ skillId }}
							/>
						),
					}))}
				/>
			</div>
			<Outlet />

			<Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Move {skill.title}</DialogTitle>
						<DialogDescription>
							Folders organize skills without changing their identity. Leave
							empty to move this skill to the root.
						</DialogDescription>
					</DialogHeader>
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							moveSkill.mutate(folderDraft.trim() || null);
						}}
					>
						<div className="grid gap-1.5">
							<Label htmlFor="skill-folder-path">Folder path</Label>
							<Input
								id="skill-folder-path"
								value={folderDraft}
								onChange={(event) => setFolderDraft(event.target.value)}
								placeholder="operations/reports"
								pattern="[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*"
								maxLength={255}
							/>
						</div>
						{moveSkill.error ? (
							<div role="alert">
								<Text role="label" tone="error">
									{(moveSkill.error as Error).message}
								</Text>
							</div>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setFolderDialogOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={moveSkill.isPending}>
								{moveSkill.isPending ? "Moving…" : "Move skill"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{testRun ? `Test run of ${skill.title}` : `Run ${skill.title}`}
						</DialogTitle>
						<DialogDescription>
							{testRun
								? `Runs revision ${skill.revision} once as a test, with the selected tedi’s permissions. It does what a normal run does. The test counts only when the run finishes and reports that it passed; some skills pass only with particular parameters, which their instructions name. After a passed test you can turn the skill back on.`
								: "Runs this skill with the selected tedi’s permissions."}
						</DialogDescription>
					</DialogHeader>
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							void runForm.handleSubmit();
						}}
					>
						<FormField form={runForm} name="tediId" label="Run as">
							{(field, meta) => (
								<FormSelect field={field} {...meta} placeholder="Select a tedi">
									{(roster.data?.data ?? []).map((tedi) => (
										<SelectItem key={tedi.id} value={tedi.id}>
											{tedi.name}
										</SelectItem>
									))}
								</FormSelect>
							)}
						</FormField>
						<FormField
							form={runForm}
							name="paramsText"
							label="Parameters (JSON object)"
						>
							{(field, meta) => (
								<FormTextarea field={field} {...meta} rows={7} />
							)}
						</FormField>
						{runNow.error ? (
							<div role="alert">
								<Text role="label" tone="error">
									{testRun
										? "Couldn't start the test; check the selected tedi and try again."
										: runNow.error.message}
								</Text>
							</div>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setDialogOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={runNow.isPending}>
								{runNow.isPending
									? "Dispatching…"
									: testRun
										? "Run test"
										: "Run now"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</Page>
	);
}

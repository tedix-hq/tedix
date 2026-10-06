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
import { Badge } from "@/components/kumo/badge";
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
import { jsonTextSchema } from "@/components/kumo/forms/json-text-schema";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Page,
	PageActions,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { SelectItem } from "@/components/kumo/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/kumo/tabs";
import { useSkillsWebMcpTools } from "@/components/skills-webmcp-tools";
import { osApi } from "@/lib/api";
import {
	osQueryKeys,
	skillDetailQueryOptions,
	tediRosterQueryOptions,
	workflowDefinitionHealthQueryOptions,
	WORKFLOW_DEFINITIONS_LIMIT,
} from "@/lib/os-query-options";
import {
	TEDIS_MANAGE_DENIED_REASON,
	useCanManageTedis,
} from "@/lib/tedi-permissions";

export function parseRunParams(value: string): Record<string, unknown> {
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
	const [folderDialogOpen, setFolderDialogOpen] = useState(false);
	const [folderDraft, setFolderDraft] = useState("");
	const canRun = useCanManageTedis();
	const activeTab = pathname.endsWith("/runs")
		? "runs"
		: pathname.endsWith("/versions")
			? "versions"
			: pathname.endsWith("/schedule")
				? "schedule"
				: "overview";
	const executable = Boolean(skill?.files?.["scripts/workflow.ts"]);

	const runNow = useMutation({
		mutationFn: (input: { tediId: string; params: Record<string, unknown> }) =>
			osApi.skills.runWorkflow({
				skillId,
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

	if (!skill) return null;
	return (
		<Page width="lg">
			<PageBack render={<Link to="/skills" />}>All skills</PageBack>
			<PageHeader>
				<PageHeading>
					<PageTitle>{skill.title}</PageTitle>
					<PageDescription>
						{skill.summary ??
							skill.description ??
							"Reusable governed procedure"}
					</PageDescription>
					<div className="mt-2 flex flex-wrap gap-2">
						<Badge variant="outline">revision {skill.revision}</Badge>
						{skill.lifecycleState ? (
							<Badge variant="secondary">{skill.lifecycleState}</Badge>
						) : null}
					</div>
				</PageHeading>
				{executable || canRun ? (
					<PageActions>
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
								onClick={() => setDialogOpen(true)}
							>
								<Play size={15} /> Run now
							</Button>
						) : null}
					</PageActions>
				) : null}
			</PageHeader>
			<Tabs value={activeTab}>
				<TabsList aria-label="Skill detail sections" variant="line">
					{(["overview", "runs", "versions", "schedule"] as const).map(
						(tab) => (
							<TabsTrigger
								key={tab}
								nativeButton={false}
								value={tab}
								render={
									<Link
										to={
											tab === "overview"
												? "/skills/$skillId"
												: `/skills/$skillId/${tab}`
										}
										params={{ skillId }}
									/>
								}
							>
								{tab === "overview"
									? "Overview"
									: tab[0]?.toUpperCase() + tab.slice(1)}
							</TabsTrigger>
						),
					)}
				</TabsList>
			</Tabs>
			<Outlet />

			<Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Move {skill.title}</DialogTitle>
						<DialogDescription>
							Catalog folders organize skills without changing the immutable
							slug or skill URI. Leave empty to move this skill to the root.
						</DialogDescription>
					</DialogHeader>
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							moveSkill.mutate(folderDraft.trim() || null);
						}}
					>
						<label className="grid gap-1.5 type-tedix-label">
							Folder path
							<Input
								value={folderDraft}
								onChange={(event) => setFolderDraft(event.target.value)}
								placeholder="operations/reports"
								pattern="[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*"
								maxLength={255}
							/>
						</label>
						{moveSkill.error ? (
							<p role="alert" className="m-0 text-kumo-danger text-xs">
								{(moveSkill.error as Error).message}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
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
						<DialogTitle>Run {skill.title}</DialogTitle>
						<DialogDescription>
							Dispatches the pinned workflow through the same governed
							skill-runtime admission as Triggers.
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
							<p role="alert" className="m-0 text-kumo-danger text-xs">
								{(runNow.error as Error).message}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setDialogOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={runNow.isPending}>
								{runNow.isPending ? "Dispatching…" : "Run now"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</Page>
	);
}

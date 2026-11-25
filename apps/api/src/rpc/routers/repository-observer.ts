import { baseErrorConstructors } from "@tedix/api-contract/errors";
import { implement } from "@orpc/server";
import { repositoryObserverContract } from "@tedix/api-contract/contracts/repository-observer";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import * as observations from "@tedix/db/queries/repository-observer";
import { withAuth, withAuthorization, AUTHZ, type BaseContext } from "../orpc";
import { withOrg } from "../org-scope";
import { auditActor } from "../audit-helpers";
import {
	observerConfig,
	ownedObservation,
	observeRepositoryEvent,
	dispatchObserverRepair,
	escalateObserver,
} from "../../services/repository-observer";
const authed = implement(repositoryObserverContract)
	.$context<BaseContext>()
	.use(withAuth);
const write = authed.use(withAuthorization("tedis:update", "mcp:work.write"));
export const repositoryObserverContractRouter = {
	countCommitAliases: authed.countCommitAliases
		.use(AUTHZ.platformAdmin)
		.handler(async ({ context, input }) => {
			const hour = new Date().getUTCHours();
			const { start, end } = input.quietHoursUtc;
			const quiet =
				start < end ? hour >= start && hour < end : hour >= start || hour < end;
			if (
				!quiet ||
				(input.cursor && input.cursor.repository !== input.repository)
			)
				throw baseErrorConstructors.BAD_REQUEST({
					message:
						"Use the configured quiet UTC hours and the cursor's original repository",
				});
			const { countCommitAliasPage } =
				await import("../../jobs/commit-alias-counts");
			return countCommitAliasPage(context.db, input);
		}),
	rewriteCommitAliases: authed.rewriteCommitAliases
		.use(AUTHZ.platformAdmin)
		.handler(async ({ context, input }) => {
			const hour = new Date().getUTCHours();
			const { start, end } = input.quietHoursUtc;
			const quiet =
				start < end ? hour >= start && hour < end : hour >= start || hour < end;
			if (
				!quiet ||
				(input.cursor &&
					(input.cursor.repository !== input.repository ||
						input.cursor.dryRun !== input.dryRun))
			)
				throw baseErrorConstructors.BAD_REQUEST({
					message:
						"Use quiet UTC hours and the cursor's original repository and dryRun mode",
				});
			const { rewriteCommitAliasPage } =
				await import("../../jobs/commit-alias-rewrites");
			return rewriteCommitAliasPage(context.db, input, auditActor(context));
		}),
	configure: authed.configure
		.use(withAuthorization("settings:manage", "mcp:work.admin"))
		.use(withOrg)
		.handler(async ({ context, input }) => {
			const org = context.organizationId;
			if (context.authType !== "user")
				throw baseErrorConstructors.FORBIDDEN({
					message:
						"A human administrator configures observer standing authority",
				});
			const project = await getProjectByIdForOrganization(
				context.db,
				org,
				input.projectId,
			);
			const tedi = await getTediByIdForOrganization(
				context.db,
				input.config.ownerTediId,
				org,
			);
			if (!project?.objectiveId || !tedi || tedi.status !== "active")
				throw baseErrorConstructors.BAD_REQUEST({
					message: "Active owner and purpose-linked project required",
				});
			if (
				!(await observations.configureRepositoryObserver(
					context.db,
					org,
					project.id,
					input.config,
					new Date().toISOString(),
				))
			)
				throw baseErrorConstructors.NOT_FOUND({ message: "Not Found" });
			return { projectId: project.id };
		}),
	observe: write.observe
		.use(withOrg)
		.handler(({ context, input }) =>
			observeRepositoryEvent(context, context.organizationId, input),
		),
	pending: authed.pending
		.use(withAuthorization("tedis:read", "mcp:work.read"))
		.use(withOrg)
		.handler(async ({ context, input }) => {
			const org = context.organizationId;
			await observerConfig(context, org, input.projectId);
			return (
				await observations.pendingRepositoryObservations(
					context.db,
					org,
					input.projectId,
				)
			).map((row) => ({
				observationId: row.id,
				workItemId: String(row.metadata?.targetWorkItemId ?? row.id),
				deadline: row.deadline,
				summary: row.description ?? "",
			}));
		}),
	report: write.report.use(withOrg).handler(async ({ context, input }) => {
		const org = context.organizationId;
		const { row, config } = await ownedObservation(
			context,
			org,
			input.observationId,
		);
		const matched =
			(row.metadata?.lessons as {
				id: string;
				revision: string | null;
				text: string;
			}[]) ?? [];
		if (
			input.lessons.length !== matched.length ||
			new Set(input.lessons.map((l) => l.lessonId)).size !== matched.length ||
			input.lessons.some((l) => !matched.some((m) => m.id === l.lessonId))
		)
			throw baseErrorConstructors.BAD_REQUEST({
				message: "Report each snapshotted lesson exactly once",
			});
		const workItemId = String(row.metadata?.targetWorkItemId ?? row.id);
		const body = [
			`Commit watch: ${row.title}`,
			input.diagnosis,
			...input.lessons.map((l) => {
				const lesson = matched.find((m) => m.id === l.lessonId)!;
				return `${l.verdict.replaceAll("_", " ")}: ${lesson.text} [${l.lessonId}; revision ${lesson.revision ?? "unknown"}; ${l.verdict}]\nEvidence: ${l.evidence}\nConcrete fix: ${l.fix || "No fix proposed"}`;
			}),
		].join("\n\n");
		await observations.reportRepositoryObservation(context.db, {
			orgId: org,
			id: row.id,
			workItemId,
			authorId: config.ownerTediId,
			body,
			report: input,
			now: new Date().toISOString(),
		});
		const current = await observations.getRepositoryObservation(
			context.db,
			org,
			row.id,
		);
		const report = (current?.metadata?.latestReport ??
			current?.metadata?.report) as typeof input | undefined;
		if (
			report?.stillRed &&
			(current?.metadata?.repairLessonId ||
				!report.lessons.some(
					(l) =>
						config.repairs.some((r) => r.lessonId === l.lessonId) &&
						["applied", "not_applied"].includes(l.verdict),
				))
		)
			await escalateObserver(context, org, row, config, report.diagnosis);
		return { observationId: row.id, workItemId, status: "reported" };
	}),
	repair: write.repair
		.use(withOrg)
		.handler(({ context, input }) =>
			dispatchObserverRepair(context, context.organizationId, input),
		),
};

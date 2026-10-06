import { implement } from "@orpc/server";
import { calendarCoordinatorContract } from "@tedix/api-contract/contracts/calendar-coordinator";
import { CalendarConfigurationSchema } from "@tedix/api-contract/schemas/calendar-coordinator";
import { createDbQueryClient } from "@tedix/db/query-client";
import * as ledger from "@tedix/db/queries/calendar-coordinator";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";
import { requireOrgId } from "../org-scope";
import { requireWorkspace } from "./os-workspaces-shared";
const authed = implement(calendarCoordinatorContract)
	.$context<BaseContext>()
	.use(withAuth);
const read = authed.use(AUTHZ.osRead);
const author = authed.use(AUTHZ.osAuthor);
const run = authed.use(AUTHZ.osRun);
export const calendarCoordinatorContractRouter = {
	supportedAccounts: read.supportedAccounts.handler(
		async ({ context, input }) => {
			const { supportedCalendarAccounts } =
				await import("../../services/calendar-coordinator/credentials");
			return supportedCalendarAccounts(
				context,
				requireOrgId(context),
				input.scope,
			);
		},
	),
	listCalendars: read.listCalendars.handler(async ({ context, input }) => {
		const { resolveCalendarAdapter } =
			await import("../../services/calendar-coordinator/credentials");
		const selected = await resolveCalendarAdapter(
			context,
			requireOrgId(context),
			input,
		);
		return {
			account: selected.account,
			calendars: await selected.adapter.listCalendars(),
		};
	}),
	list: read.list.handler(async ({ context, input }) => {
		await requireWorkspace(context, input.workspaceId);
		return (
			await ledger.listCalendarCoordinators(
				createDbQueryClient(context.env.DB),
				requireOrgId(context),
				input.workspaceId,
			)
		).map((r) =>
			CalendarConfigurationSchema.parse(JSON.parse(r.configuration)),
		);
	}),
	configure: author.configure.handler(async ({ context, input }) => {
		const { calendarOwnerUser } =
			await import("../../services/calendar-coordinator/credentials");
		const { loadCalendarConfig, resolveCalendarRoutes } =
			await import("../../services/calendar-coordinator/state");
		const organizationId = requireOrgId(context);
		const ownerUserId = calendarOwnerUser(context);
		await requireWorkspace(context, input.workspaceId);
		new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
		const { approvedRollingDays } =
			await import("../../services/calendar-coordinator/types");
		const configuration = CalendarConfigurationSchema.parse({
			...input,
			id: input.id ?? crypto.randomUUID(),
			organizationId,
			ownerUserId,
			rollingDays:
				input.rollingDays ?? approvedRollingDays(input.window, input.timeZone),
			revision: input.expectedRevision + 1,
			mode: "preview",
			actions: [],
		});
		const adapters = await resolveCalendarRoutes(context, configuration);
		for (const route of configuration.calendars) {
			const calendars = await adapters.get(route.key)!.listCalendars();
			if (!calendars.find((c) => c.id === route.calendarId)?.canRead)
				throw new Error("Selected calendar cannot be read");
		}
		const db = createDbQueryClient(context.env.DB);
		if (input.id) {
			const prior = await loadCalendarConfig(context, organizationId, input.id);
			if (
				prior.configuration.ownerUserId !== ownerUserId ||
				prior.configuration.workspaceId !== input.workspaceId
			)
				throw new Error(
					"Calendar configuration owner or workspace cannot change",
				);
			const scope = { organizationId, configurationId: input.id };
			const pending = await ledger.listCalendarCoordinatorMutations(db, scope);
			if (pending.some((m) => m.state === "intent" || m.state === "uncertain"))
				throw new Error(
					"Recover uncertain provider writes before editing the configuration",
				);
			const routeIdentity = (
				calendars: Array<{
					key: string;
					providerId: string;
					connectionScope: string;
					connectionInstanceId: string;
					calendarId: string;
					workspaceResourceId: string;
				}>,
			) =>
				JSON.stringify(
					calendars.map((r) => [
						r.key,
						r.providerId,
						r.connectionScope,
						r.connectionInstanceId,
						r.calendarId,
						r.workspaceResourceId,
					]),
				);
			if (
				routeIdentity(prior.configuration.calendars) !==
					routeIdentity(configuration.calendars) &&
				(await ledger.listCalendarCoordinatorMirrors(db, scope)).length
			)
				throw new Error(
					"Compensate owned blockers before rebinding calendar accounts or removing routes",
				);
			if (
				!(await ledger.updateCalendarCoordinator(
					db,
					{ organizationId, configurationId: input.id },
					input.expectedRevision,
					{ mode: "preview", configuration: JSON.stringify(configuration) },
				))
			)
				throw new Error(
					"Calendar configuration revision changed or reconcile is running",
				);
			const { disableCalendarMonitoring } =
				await import("../../services/calendar-coordinator/state");
			await disableCalendarMonitoring(context, prior.configuration);
		} else
			await ledger.createCalendarCoordinator(db, {
				id: configuration.id,
				organizationId,
				workspaceId: input.workspaceId,
				ownerUserId,
				revision: 1,
				mode: "preview",
				configuration: JSON.stringify(configuration),
				ownershipSeed: crypto.randomUUID(),
				updatedAt: new Date().toISOString(),
			});
		return configuration;
	}),
	activate: author.activate.handler(async ({ context, input }) => {
		const { calendarOwnerUser } =
			await import("../../services/calendar-coordinator/credentials");
		const {
			loadCalendarConfig,
			resolveCalendarRoutes,
			installCalendarMonitoring,
			disableCalendarMonitoring,
			queueCalendarInitialReconcile,
		} = await import("../../services/calendar-coordinator/state");
		const { configuration, db } = await loadCalendarConfig(
			context,
			requireOrgId(context),
			input.id,
		);
		if (
			configuration.ownerUserId !== calendarOwnerUser(context) ||
			configuration.revision !== input.expectedRevision
		)
			throw new Error("Owner and exact configuration revision required");
		const adapters = await resolveCalendarRoutes(context, configuration, true);
		for (const route of configuration.calendars) {
			const a = adapters.get(route.key)!;
			const info = (await a.listCalendars()).find(
				(c) => c.id === route.calendarId,
			);
			if (!info?.canWrite)
				throw new Error(
					"Every selected calendar requires verified write permission",
				);
			if (input.actions.some((k) => k !== "create") && !a.conditionalWrites)
				throw new Error(
					"Microsoft conditional update/delete support has not been verified",
				);
		}
		const subscriptionIds = await installCalendarMonitoring(
			context,
			configuration,
		);
		const next = {
			...configuration,
			subscriptionIds,
			mode: "active" as const,
			revision: configuration.revision + 1,
			actions: [...new Set(input.actions)],
		};
		if (
			!(await ledger.updateCalendarCoordinator(
				db,
				{
					organizationId: configuration.organizationId,
					configurationId: input.id,
				},
				input.expectedRevision,
				{ mode: "active", configuration: JSON.stringify(next) },
			))
		) {
			await disableCalendarMonitoring(context, next);
			throw new Error("Calendar configuration changed or reconcile is running");
		}
		await disableCalendarMonitoring(context, configuration);
		await queueCalendarInitialReconcile(context, next);
		return next;
	}),
	deactivate: author.deactivate.handler(async ({ context, input }) => {
		const { calendarOwnerUser } =
			await import("../../services/calendar-coordinator/credentials");
		const { loadCalendarConfig, disableCalendarMonitoring } =
			await import("../../services/calendar-coordinator/state");
		const { configuration, db } = await loadCalendarConfig(
			context,
			requireOrgId(context),
			input.id,
		);
		if (configuration.ownerUserId !== calendarOwnerUser(context))
			throw new Error("Configuration owner required");
		const next = {
			...configuration,
			mode: "preview" as const,
			revision: input.expectedRevision + 1,
			actions: [],
		};
		if (
			!(await ledger.disableCalendarCoordinator(
				db,
				{
					organizationId: configuration.organizationId,
					configurationId: input.id,
				},
				input.expectedRevision,
				JSON.stringify(next),
			))
		)
			throw new Error("Calendar configuration revision changed");
		await disableCalendarMonitoring(context, next);
		return next;
	}),
	preview: read.preview.handler(async ({ context, input }) => {
		const { loadCalendarConfig, previewCalendarConfig } =
			await import("../../services/calendar-coordinator/state");
		const { configuration, row } = await loadCalendarConfig(
			context,
			requireOrgId(context),
			input.id,
		);
		if (configuration.revision !== input.expectedRevision)
			throw new Error("Calendar configuration revision changed");
		return previewCalendarConfig(context, configuration, row.ownershipSeed);
	}),
	apply: run.apply.handler(async ({ context, input }) => {
		const {
			loadCalendarConfig,
			resolveCalendarRoutes,
			createCalendarApplyStore,
		} = await import("../../services/calendar-coordinator/state");
		const { applyPlan } =
			await import("../../services/calendar-coordinator/apply");
		const { configuration, db } = await loadCalendarConfig(
			context,
			requireOrgId(context),
			input.id,
		);
		if (configuration.revision !== input.expectedRevision)
			throw new Error("Calendar configuration revision changed");
		const row = await ledger.getCalendarCoordinatorPlan(
			db,
			{
				organizationId: configuration.organizationId,
				configurationId: input.id,
			},
			input.planId,
		);
		if (!row) throw new Error("Calendar preview not found");
		const plan = JSON.parse(
			row.plan,
		) as import("../../services/calendar-coordinator/types").Plan;
		const adapters = await resolveCalendarRoutes(context, configuration, true);
		const lease = await createCalendarApplyStore(context, configuration, plan);
		try {
			const receipt = await applyPlan(
				configuration,
				plan,
				adapters,
				lease.store,
			);
			await lease.release(receipt);
			return receipt;
		} catch (error) {
			await lease.release({
				planId: plan.id,
				outcome: "conflict",
				mutations: [],
			});
			throw error;
		}
	}),
	previewCompensation: run.previewCompensation.handler(
		async ({ context, input }) => {
			const { calendarOwnerUser } =
				await import("../../services/calendar-coordinator/credentials");
			const { loadCalendarConfig, resolveCalendarRoutes } =
				await import("../../services/calendar-coordinator/state");
			const { previewCompensation } =
				await import("../../services/calendar-coordinator/apply");
			const { configuration, db } = await loadCalendarConfig(
				context,
				requireOrgId(context),
				input.id,
			);
			if (
				configuration.ownerUserId !== calendarOwnerUser(context) ||
				configuration.revision !== input.expectedRevision
			)
				throw new Error("Owner and exact configuration revision required");
			const scope = {
				organizationId: configuration.organizationId,
				configurationId: configuration.id,
			};
			const original = await ledger.getCalendarCoordinatorPlan(
				db,
				scope,
				input.planId,
			);
			if (!original) throw new Error("Original calendar plan not found");
			const mutations = (
				await ledger.listCalendarCoordinatorMutations(db, scope)
			).map((r) => JSON.parse(r.mutation));
			const plan = await previewCompensation(
				configuration,
				JSON.parse(original.plan),
				mutations,
				input.actionIds,
				await resolveCalendarRoutes(context, configuration, true),
			);
			await ledger.saveCalendarCoordinatorPlan(db, {
				id: plan.id,
				organizationId: configuration.organizationId,
				configurationId: configuration.id,
				configurationRevision: configuration.revision,
				plan: JSON.stringify(plan),
				createdAt: plan.createdAt,
			});
			return plan;
		},
	),
	compensate: run.compensate.handler(async ({ context, input }) => {
		const { calendarOwnerUser } =
			await import("../../services/calendar-coordinator/credentials");
		const {
			loadCalendarConfig,
			resolveCalendarRoutes,
			createCalendarApplyStore,
			disableCalendarMonitoring,
		} = await import("../../services/calendar-coordinator/state");
		const { applyCompensation } =
			await import("../../services/calendar-coordinator/apply");
		const { configuration, db } = await loadCalendarConfig(
			context,
			requireOrgId(context),
			input.id,
		);
		if (
			configuration.ownerUserId !== calendarOwnerUser(context) ||
			configuration.revision !== input.expectedRevision
		)
			throw new Error("Owner and exact configuration revision required");
		const row = await ledger.getCalendarCoordinatorPlan(
			db,
			{
				organizationId: configuration.organizationId,
				configurationId: input.id,
			},
			input.planId,
		);
		if (!row) throw new Error("Compensation preview not found");
		const plan = JSON.parse(row.plan);
		const adapters = await resolveCalendarRoutes(context, configuration, true);
		if (plan.purpose !== "compensate")
			throw new Error("Compensation requires its reviewed immutable preview");
		await disableCalendarMonitoring(context, configuration);
		const lease = await createCalendarApplyStore(context, configuration, plan);
		try {
			const receipt = await applyCompensation(
				configuration,
				plan,
				adapters,
				lease.store,
			);
			await lease.release(receipt);
			await ledger.disableCalendarCoordinator(
				db,
				{
					organizationId: configuration.organizationId,
					configurationId: configuration.id,
				},
				configuration.revision,
				JSON.stringify({
					...configuration,
					mode: "preview",
					actions: [],
					revision: configuration.revision + 1,
				}),
			);
			return receipt;
		} catch (error) {
			await lease.release({
				planId: plan.id,
				outcome: "conflict",
				mutations: [],
			});
			throw error;
		}
	}),
	recover: run.recover.handler(async ({ context, input }) => {
		const {
			loadCalendarConfig,
			resolveCalendarRoutes,
			createCalendarApplyStore,
		} = await import("../../services/calendar-coordinator/state");
		const { recoverPlan } =
			await import("../../services/calendar-coordinator/apply");
		const { configuration, db } = await loadCalendarConfig(
			context,
			requireOrgId(context),
			input.id,
		);
		if (configuration.revision !== input.expectedRevision)
			throw new Error("Calendar configuration revision changed");
		const row = await ledger.getCalendarCoordinatorPlan(
			db,
			{
				organizationId: configuration.organizationId,
				configurationId: input.id,
			},
			input.planId,
		);
		if (!row) throw new Error("Recovery plan not found");
		const plan = JSON.parse(row.plan);
		const lease = await createCalendarApplyStore(context, configuration, plan);
		try {
			const receipt = await recoverPlan(
				configuration,
				plan,
				await resolveCalendarRoutes(context, configuration, true),
				lease.store,
			);
			await lease.release(receipt);
			return receipt;
		} catch (error) {
			await lease.release({
				planId: plan.id,
				outcome: "conflict",
				mutations: [],
			});
			throw error;
		}
	}),
	reconcileSubscription: run.reconcileSubscription.handler(
		async ({ context, input }) => {
			const { reconcileCalendarSubscription } =
				await import("../../services/calendar-coordinator/state");
			return reconcileCalendarSubscription(
				context,
				requireOrgId(context),
				input.subscriptionId,
				input.expectedSkillRevision,
			);
		},
	),
	status: read.status.handler(async ({ context, input }) => {
		const { loadCalendarConfig, calendarMonitoringStatus } =
			await import("../../services/calendar-coordinator/state");
		const { configuration, row } = await loadCalendarConfig(
			context,
			requireOrgId(context),
			input.id,
		);
		return {
			configuration,
			lastReceipt: row.lastReceipt ? JSON.parse(row.lastReceipt) : null,
			lastSuccessfulReconcileAt: row.lastSuccessfulReconcileAt,
			...(await calendarMonitoringStatus(context, configuration)),
			message:
				configuration.mode === "active"
					? "Enabled. Check notification registrations and the last reconcile receipt for actual operation."
					: "Preview only. No calendar writes are enabled.",
		};
	}),
};

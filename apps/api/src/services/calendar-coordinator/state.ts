import { createDbQueryClient } from "@tedix/db/query-client";
import * as ledger from "@tedix/db/queries/calendar-coordinator";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { requireTediRequestIdentity } from "../../rpc/org-scope";
import type { BaseContext } from "../../rpc/orpc";
import { requireWorkspace } from "../../rpc/routers/os-workspaces-shared";
import { calendarOwnerUser, resolveCalendarAdapter } from "./credentials";
import { collectSnapshots, type ApplyStore } from "./apply";
import { buildPlan } from "./plan";
import type {
	CalendarAdapter,
	Configuration,
	Mirror,
	Mutation,
	Plan,
} from "./types";
export async function assertCalendarTarget(
	context: BaseContext,
	config: Configuration,
) {
	const [tedi, skill] = await Promise.all([
		getTediByIdForOrganization(
			context.db,
			config.tediId,
			config.organizationId,
		),
		getSkillEntry(context.db, config.skillId, config.organizationId),
	]);
	if (
		!tedi ||
		tedi.status !== "active" ||
		tedi.runtimeState === "archived" ||
		!skill ||
		skill.tediId !== config.tediId ||
		skill.revision !== config.skillRevision ||
		!["active", "proven", "crystallized"].includes(
			skill.lifecycleState ?? "",
		) ||
		!skill.files?.["scripts/workflow.ts"]
	)
		throw new Error(
			"Active organization worker and exact executable skill revision are required",
		);
}
export async function loadCalendarConfig(
	context: BaseContext,
	organizationId: string,
	id: string,
) {
	const db = createDbQueryClient(context.env.DB);
	const row = await ledger.getCalendarCoordinator(db, {
		organizationId,
		configurationId: id,
	});
	if (!row) throw new Error("Calendar configuration not found");
	const configuration = JSON.parse(row.configuration) as Configuration;
	if (
		configuration.organizationId !== organizationId ||
		configuration.id !== row.id ||
		configuration.revision !== row.revision ||
		configuration.mode !== row.mode
	)
		throw new Error("Calendar configuration integrity check failed");
	await requireWorkspace(context, configuration.workspaceId);
	return { row, configuration, db };
}
export async function resolveCalendarRoutes(
	context: BaseContext,
	config: Configuration,
	execution = false,
): Promise<Map<string, CalendarAdapter>> {
	await requireWorkspace(context, config.workspaceId);
	await assertCalendarTarget(context, config);
	const adapters = new Map<string, CalendarAdapter>();
	for (const route of config.calendars) {
		const resource = await getOsWorkspaceResource(
			createDbQueryClient(context.env.DB),
			{
				organizationId: config.organizationId,
				workspaceId: config.workspaceId,
				resourceId: route.workspaceResourceId,
			},
		);
		if (
			!resource ||
			resource.status !== "active" ||
			resource.providerId !== route.providerId ||
			resource.connectionScope !== route.connectionScope ||
			resource.providerResourceId !== route.calendarId ||
			resource.resourceType !== "calendar"
		)
			throw new Error(
				"Selected workspace calendar resource is unavailable or changed",
			);
		// Canonical fields are a dependency of named resource integration. Never use metadata as authority.
		const binding = resource as typeof resource & {
			connectionInstanceId?: string | null;
			personalOwnerUserId?: string | null;
		};
		if (
			binding.connectionInstanceId !== route.connectionInstanceId ||
			(route.connectionScope === "user" &&
				binding.personalOwnerUserId !==
					(execution ? config.ownerUserId : calendarOwnerUser(context)))
		)
			throw new Error(
				"Workspace resource lacks the exact canonical account/owner binding",
			);
		adapters.set(
			route.key,
			(
				await resolveCalendarAdapter(
					context,
					config.organizationId,
					route,
					execution,
				)
			).adapter,
		);
	}
	return adapters;
}
export async function previewCalendarConfig(
	context: BaseContext,
	config: Configuration,
	ownershipSeed: string,
) {
	const db = createDbQueryClient(context.env.DB);
	const scope = {
		organizationId: config.organizationId,
		configurationId: config.id,
	};
	const pending = await ledger.listCalendarCoordinatorMutations(db, scope);
	if (pending.some((r) => r.state === "intent" || r.state === "uncertain"))
		throw new Error(
			"An earlier provider write is uncertain; reconcile its existing plan before preparing another",
		);
	const rows = await ledger.listCalendarCoordinatorMirrors(db, scope);
	if (rows.length > 10_000)
		throw new Error(
			"Calendar ledger exceeds bounded snapshot; no cleanup permitted",
		);
	const mirrors = rows.map((r) => JSON.parse(r.mirror) as Mirror);
	const adapters = await resolveCalendarRoutes(
		context,
		config,
		context.authType !== "user",
	);
	const plan = await buildPlan(
		config,
		await collectSnapshots(config, adapters, mirrors),
		mirrors,
		ownershipSeed,
	);
	await ledger.saveCalendarCoordinatorPlan(db, {
		id: plan.id,
		organizationId: config.organizationId,
		configurationId: config.id,
		configurationRevision: config.revision,
		plan: JSON.stringify(plan),
		createdAt: plan.createdAt,
	});
	return plan;
}
export async function createCalendarApplyStore(
	context: BaseContext,
	config: Configuration,
	plan: Plan,
) {
	if (context.authType === "user") {
		if (calendarOwnerUser(context) !== config.ownerUserId)
			throw new Error(
				"Only the activation owner may apply an interactive plan",
			);
	} else {
		if (context.authType !== "tedi" && context.authType !== "service-binding")
			throw new Error(
				"Calendar background execution requires the selected worker identity",
			);
		requireTediRequestIdentity(context, config.tediId);
	}
	const db = createDbQueryClient(context.env.DB);
	const scope = {
		organizationId: config.organizationId,
		configurationId: config.id,
	};
	const leaseId = crypto.randomUUID();
	const leased = await ledger.acquireCalendarCoordinatorLease(
		db,
		scope,
		config.revision,
		leaseId,
		Date.now(),
	);
	if (!leased)
		throw new Error(
			"Calendar configuration changed or another reconcile holds its lease",
		);
	const fence = leased.fence;
	const store: ApplyStore = {
		async guard() {
			await assertCalendarTarget(context, config);
			if (
				!(await ledger.renewCalendarCoordinatorLease(
					db,
					scope,
					config.revision,
					leaseId,
					fence,
					Date.now(),
				))
			)
				throw new Error("Calendar execution lease or activation was revoked");
			// Resources and credentials are reauthorized at each provider write boundary.
			await resolveCalendarRoutes(context, config, true);
		},
		async previous() {
			const rows = await ledger.listCalendarCoordinatorMutations(db, scope);
			if (rows.length > 10_000)
				throw new Error("Calendar mutation ledger exceeds bounded read");
			return rows.map((r) => JSON.parse(r.mutation) as Mutation);
		},
		async record(mutation) {
			const now = new Date().toISOString();
			if (
				!(
					await ledger.putCalendarCoordinatorMutation(
						db,
						scope,
						leaseId,
						fence,
						{
							id: mutation.actionId,
							organizationId: config.organizationId,
							configurationId: config.id,
							planId: plan.id,
							actionId: mutation.actionId,
							state: mutation.state,
							mutation: JSON.stringify(mutation),
							updatedAt: now,
						},
					)
				).length
			)
				throw new Error("Calendar ledger fence rejected write");
		},
		async mirror(action, event) {
			const id = `${config.id}:${action.sourceKey}:${action.destinationKey}`;
			if (!event) {
				await ledger.removeCalendarCoordinatorMirror(
					db,
					scope,
					id,
					leaseId,
					fence,
				);
				return;
			}
			const mirror: Mirror = {
				id,
				sourceKey: action.sourceKey,
				sourceRouteKey: action.sourceRouteKey,
				sourceEventId: action.sourceEventId,
				destinationKey: action.destinationKey,
				eventId: event.id,
				revision: event.revision,
				ownership: action.ownership,
				interval: event.interval,
			};
			if (
				!(
					await ledger.putCalendarCoordinatorMirror(db, scope, leaseId, fence, {
						id,
						organizationId: config.organizationId,
						configurationId: config.id,
						sourceKey: action.sourceKey,
						destinationKey: action.destinationKey,
						mirror: JSON.stringify(mirror),
					})
				).length
			)
				throw new Error("Calendar mirror fence rejected write");
		},
	};
	return {
		store,
		release: async (receipt: unknown) => {
			await ledger.releaseCalendarCoordinatorLease(
				db,
				scope,
				leaseId,
				fence,
				JSON.stringify(receipt),
				plan.purpose === "reconcile" &&
					(receipt as { outcome?: string }).outcome === "confirmed",
			);
		},
	};
}
export async function installCalendarMonitoring(
	context: BaseContext,
	config: Configuration,
): Promise<string[]> {
	const { registerSubscription, disableSubscription } =
		await import("../provider-events/subscriptions");
	const installed: string[] = [];
	try {
		for (const route of config.calendars) {
			const row = await registerSubscription(context, config.organizationId, {
				adapter:
					route.adapter === "google" ? "google_calendar" : "microsoft_calendar",
				providerId: route.providerId,
				connectionInstanceId: route.connectionInstanceId,
				calendarId: route.calendarId,
				tediId: config.tediId,
				skillId: config.skillId,
				skillRevision: config.skillRevision,
				deliveryMode: route.deliveryMode ?? "push",
			});
			installed.push(row.id);
			if (
				row.status !== "active" ||
				(row.deliveryMode === "push" &&
					(!row.expiresAt || Date.parse(row.expiresAt) <= Date.now()))
			)
				throw new Error(
					"Calendar notification registration failed; activation remains disabled",
				);
		}
		return installed;
	} catch (error) {
		for (const id of installed)
			await disableSubscription(context, config.organizationId, id);
		throw error;
	}
}
export async function disableCalendarMonitoring(
	context: BaseContext,
	config: Configuration,
) {
	const { disableSubscription } =
		await import("../provider-events/subscriptions");
	for (const id of config.subscriptionIds ?? [])
		await disableSubscription(context, config.organizationId, id);
}
export async function queueCalendarInitialReconcile(
	context: BaseContext,
	config: Configuration,
) {
	const { loadSubscription, queueReconciliation } =
		await import("../provider-events/subscriptions");
	for (const id of config.subscriptionIds ?? [])
		await queueReconciliation(
			context,
			await loadSubscription(context, config.organizationId, id),
			`coordinator-activation:${config.id}:${config.revision}`,
		);
}
export async function calendarMonitoringStatus(
	context: BaseContext,
	config: Configuration,
) {
	const { loadSubscription, statusProjection } =
		await import("../provider-events/subscriptions");
	const subscriptions = await Promise.all(
		(config.subscriptionIds ?? []).map(async (id) =>
			statusProjection(
				await loadSubscription(context, config.organizationId, id),
			),
		),
	);
	const monitoring = !subscriptions.length
		? "not_installed"
		: config.mode !== "active"
			? "disabled"
			: subscriptions.every(
						(s) =>
							s.status === "active" &&
							(s.deliveryMode === "poll" ||
								(!!s.expiresAt && Date.parse(s.expiresAt) > Date.now())),
				  )
				? "active"
				: "needs_attention";
	return {
		subscriptions,
		monitoring: monitoring as
			| "not_installed"
			| "disabled"
			| "active"
			| "needs_attention",
	};
}
export async function reconcileCalendarSubscription(
	context: BaseContext,
	organizationId: string,
	subscriptionId: string,
	expectedSkillRevision: number,
) {
	if (context.authType !== "tedi" && context.authType !== "service-binding")
		throw new Error(
			"Notification reconciliation requires the selected worker identity",
		);
	const db = createDbQueryClient(context.env.DB);
	const row = await ledger.getCalendarCoordinatorForSubscription(
		db,
		organizationId,
		subscriptionId,
	);
	if (!row)
		throw new Error(
			"Subscription is not bound to an active calendar coordinator",
		);
	const config = JSON.parse(row.configuration) as Configuration;
	requireTediRequestIdentity(context, config.tediId);
	if (config.skillRevision !== expectedSkillRevision)
		throw new Error(
			"Notification skill revision differs from the activation pin",
		);
	const { loadSubscription } = await import("../provider-events/subscriptions");
	const subscription = await loadSubscription(
		context,
		organizationId,
		subscriptionId,
	);
	const route = config.calendars.find(
		(r) =>
			r.providerId === subscription.providerId &&
			r.connectionInstanceId === subscription.connectionInstanceId &&
			r.calendarId === subscription.calendarId,
	);
	if (
		!route ||
		subscription.status !== "active" ||
		subscription.tediId !== config.tediId ||
		subscription.skillId !== config.skillId ||
		subscription.skillRevision !== expectedSkillRevision ||
		(subscription.deliveryMode === "push" &&
			(!subscription.expiresAt ||
				Date.parse(subscription.expiresAt) <= Date.now()))
	)
		throw new Error("Calendar notification authority or registration expired");
	const adapters = await resolveCalendarRoutes(context, config, true);
	const pending = await ledger.listCalendarCoordinatorMutations(db, {
		organizationId,
		configurationId: config.id,
	});
	for (const planId of new Set(
		pending
			.filter((m) => m.state === "intent" || m.state === "uncertain")
			.map((m) => m.planId),
	)) {
		const saved = await ledger.getCalendarCoordinatorPlan(
			db,
			{ organizationId, configurationId: config.id },
			planId,
		);
		if (!saved)
			throw new Error("Uncertain provider operation lacks its immutable plan");
		const recoveryPlan = JSON.parse(saved.plan) as Plan;
		const recoveryLease = await createCalendarApplyStore(
			context,
			config,
			recoveryPlan,
		);
		const { recoverPlan } = await import("./apply");
		try {
			const receipt = await recoverPlan(
				config,
				recoveryPlan,
				adapters,
				recoveryLease.store,
			);
			await recoveryLease.release(receipt);
			if (
				receipt.mutations.some(
					(m) => m.state === "uncertain" || m.state === "intent",
				)
			)
				return receipt;
		} catch (error) {
			await recoveryLease.release({
				planId: recoveryPlan.id,
				outcome: "conflict",
				mutations: [],
			});
			throw error;
		}
	}
	const plan = await previewCalendarConfig(context, config, row.ownershipSeed);
	const lease = await createCalendarApplyStore(context, config, plan);
	const { applyPlan } = await import("./apply");
	try {
		const receipt = await applyPlan(config, plan, adapters, lease.store);
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
}

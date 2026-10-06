import { snapshotFingerprint } from "./plan";
import {
	digest,
	owned,
	sameInterval,
	type Action,
	type CalendarAdapter,
	type CalendarEvent,
	type CalendarRoute,
	type Configuration,
	type Mirror,
	type Mutation,
	type Plan,
	type Receipt,
	type Snapshot,
} from "./types";
export interface ApplyStore {
	guard(): Promise<void>;
	previous(): Promise<Mutation[]>;
	record(mutation: Mutation): Promise<void>;
	mirror(action: Action, event: CalendarEvent | null): Promise<void>;
}
/** Every action has a durable intent before the provider call, then independent readback. */
export async function applyPlan(
	config: Configuration,
	plan: Plan,
	adapters: Map<string, CalendarAdapter>,
	store: ApplyStore,
): Promise<Receipt> {
	if (
		plan.purpose !== "reconcile" ||
		config.mode !== "active" ||
		config.revision !== plan.configurationRevision ||
		plan.configurationId !== config.id
	)
		throw new Error("Calendar activation or preview revision changed");
	if (!plan.complete || plan.conflicts.length)
		throw new Error("Preview has incomplete reads or unresolved conflicts");
	if (Date.now() - Date.parse(plan.createdAt) > 15 * 60_000)
		throw new Error("Calendar preview expired; create a new preview");
	const routes = new Map(config.calendars.map((r) => [r.key, r]));
	const previous = new Map(
		(await store.previous()).map((m) => [m.actionId, m]),
	);
	await store.guard();
	for (const route of config.calendars) {
		const snapshot = await adapters
			.get(route.key)!
			.snapshot(route, plan.window);
		if (
			!snapshot.complete ||
			(await snapshotFingerprint(snapshot, plan.window)) !==
				plan.snapshotFingerprints[route.key]
		)
			throw new Error("Calendar source or destination changed since preview");
	}
	const mutations: Mutation[] = [];
	for (const action of plan.actions) {
		const route = routes.get(action.destinationKey);
		const sourceRoute = routes.get(action.sourceRouteKey);
		const adapter = adapters.get(action.destinationKey);
		if (
			!route ||
			!sourceRoute ||
			!adapter ||
			!config.actions.includes(action.kind)
		)
			throw new Error("Action is outside the activated calendar policy");
		if (action.kind !== "create" && !adapter.conditionalWrites)
			throw new Error("Conditional destination writes are not verified");
		const prior = previous.get(action.id);
		if (prior?.state === "confirmed") {
			mutations.push(prior);
			continue;
		}
		let mutation: Mutation = {
			actionId: action.id,
			state: "intent",
			eventId: action.destinationEventId,
			revision: null,
			error: null,
		};
		const confirm = async (event: CalendarEvent | null) => {
			if (
				action.kind !== "delete" &&
				(!event ||
					!owned(event, action.ownership) ||
					!action.after ||
					!sameInterval(event.interval, action.after))
			)
				throw new Error(
					"Provider blocker readback differs from the private owned intent",
				);
			if (action.kind === "delete" && event)
				throw new Error("Provider deletion was not confirmed");
			mutation = {
				...mutation,
				state: "confirmed",
				compensationEligible:
					action.kind !== "delete" && adapter.conditionalWrites,
				eventId: event?.id ?? action.destinationEventId,
				revision: event?.revision ?? null,
				error: null,
			};
			await store.guard();
			await store.mirror(action, event);
			await store.record(mutation);
		};
		const recover = async () => {
			if (action.kind === "create") {
				const found = await adapter.findOwned(
					route,
					action.ownership,
					plan.window,
				);
				if (found.length !== 1)
					throw new Error(
						"Uncertain create requires unique owned provider readback; no blind retry",
					);
				await confirm(found[0]!);
			} else {
				const current = await adapter.get(route, action.destinationEventId);
				await confirm(current);
			}
		};
		if (prior?.state === "uncertain" || prior?.state === "intent") {
			mutation = prior;
			try {
				await recover();
			} catch {
				mutation = {
					...prior,
					state: "uncertain",
					error:
						"Previous provider call remains uncertain; readback required before retry",
				};
				await store.record(mutation);
			}
			mutations.push(mutation);
			continue;
		}
		try {
			await store.guard();
			const source = await adapters
				.get(sourceRoute.key)!
				.get(sourceRoute, action.sourceEventId);
			if (
				(action.sourceRevision === null
					? source !== null
					: !source || source.revision !== action.sourceRevision) ||
				(action.kind !== "delete" &&
					(!source ||
						!source.busy ||
						source.cancelled ||
						!action.after ||
						!sameInterval(source.interval, action.after)))
			)
				throw new Error("Source occurrence changed before apply");
			if (action.kind === "delete" && source?.busy && !source.cancelled) {
				if (
					action.deleteReason !== "moved_outside_window" ||
					!action.expectedSourceInterval ||
					!sameInterval(source.interval, action.expectedSourceInterval) ||
					(Date.parse(source.interval.start) < Date.parse(plan.window.end) &&
						Date.parse(source.interval.end) > Date.parse(plan.window.start))
				)
					throw new Error(
						"Original source still blocks time inside the reviewed window",
					);
			}
			const current = await adapter.get(route, action.destinationEventId);
			if (action.kind === "create" && current) {
				if (
					current.ownership === action.ownership &&
					action.after &&
					sameInterval(current.interval, action.after)
				) {
					await confirm(current);
					mutations.push(mutation);
					continue;
				}
				throw new Error("Destination event ID is occupied");
			}
			if (
				action.kind !== "create" &&
				(!current ||
					!owned(current, action.ownership) ||
					current.revision !== action.expectedDestinationRevision ||
					!action.before ||
					!sameInterval(current.interval, action.before))
			)
				throw new Error(
					"Destination ownership or revision changed before apply",
				);
			await store.record(mutation);
			await store.guard();
			// Provider preconditions fence destination revisions. Cross-provider writes cannot be atomic.
			mutation = {
				...mutation,
				state: "uncertain",
				error: "Provider write awaits independent readback",
			};
			if (action.kind === "create") {
				const response = await adapter.create(route, action);
				mutation.eventId = response.id;
			} else if (action.kind === "update") await adapter.update(route, action);
			else await adapter.remove(route, action);
			await confirm(await adapter.get(route, mutation.eventId));
		} catch (error) {
			mutation = {
				...mutation,
				state: mutation.state === "intent" ? "conflict" : "uncertain",
				error: error instanceof Error ? error.message : "Calendar apply failed",
			};
			if (mutation.state === "uncertain") {
				try {
					await recover();
				} catch {
					/* Preserve durable uncertainty; do not resend a create. */
				}
			}
			await store.record(mutation);
		}
		mutations.push(mutation);
	}
	return {
		planId: plan.id,
		outcome: mutations.every((m) => m.state === "confirmed")
			? "confirmed"
			: mutations.some((m) => m.state === "confirmed")
				? "partial"
				: "conflict",
		mutations,
	};
}
/** Compensation is deliberately conditional and touches only an unchanged, confirmed owned blocker. */
export async function compensateBlocker(
	route: CalendarRoute,
	action: Action,
	confirmed: Mutation,
	adapter: CalendarAdapter,
	guard: () => Promise<void>,
): Promise<CalendarEvent | null> {
	if (
		confirmed.state !== "confirmed" ||
		!confirmed.revision ||
		action.kind === "delete" ||
		!adapter.conditionalWrites
	)
		throw new Error("This mutation cannot be safely compensated");
	const current = await adapter.get(route, confirmed.eventId);
	if (
		!current ||
		!owned(current, action.ownership) ||
		current.revision !== confirmed.revision ||
		!action.after ||
		!sameInterval(current.interval, action.after)
	)
		throw new Error("Owned blocker changed after confirmation");
	await guard();
	const reverse = {
		...action,
		destinationEventId: confirmed.eventId,
		expectedDestinationRevision: confirmed.revision,
	};
	if (action.kind === "create") {
		await adapter.remove(route, reverse);
		if (await adapter.get(route, confirmed.eventId))
			throw new Error("Compensation delete readback failed");
		return null;
	}
	if (!action.before) throw new Error("Compensation lacks prior interval");
	await adapter.update(route, { ...reverse, after: action.before });
	const result = await adapter.get(route, confirmed.eventId);
	if (
		!result ||
		!owned(result, action.ownership) ||
		!sameInterval(result.interval, action.before)
	)
		throw new Error("Compensation update readback failed");
	return result;
}
export async function collectSnapshots(
	config: Configuration,
	adapters: Map<string, CalendarAdapter>,
	mirrors: Mirror[],
): Promise<Snapshot[]> {
	const snapshots: Snapshot[] = [];
	for (const route of config.calendars)
		snapshots.push(
			await adapters.get(route.key)!.snapshot(route, config.window),
		);
	const covered = mirrors.filter(
		(m) =>
			(Date.parse(m.interval.start) < Date.parse(config.window.end) &&
				Date.parse(m.interval.end) > Date.parse(config.window.start)) ||
			snapshots.some(
				(s) =>
					s.route.key === m.sourceRouteKey &&
					s.events.some((e) => e.id === m.sourceEventId),
			),
	);
	for (const snapshot of snapshots) {
		const route = snapshot.route;
		const adapter = adapters.get(route.key)!;
		for (const mirror of covered.filter(
			(m) => m.sourceRouteKey === route.key,
		)) {
			if (snapshot.events.some((e) => e.id === mirror.sourceEventId)) continue;
			const exact = await adapter.get(route, mirror.sourceEventId);
			if (exact) snapshot.events.push(exact);
			else
				snapshot.events.push({
					id: mirror.sourceEventId,
					sourceIdentity: mirror.sourceEventId,
					revision: "absent",
					interval: mirror.interval,
					busy: false,
					cancelled: true,
					ownership: null,
					privateBlocker: false,
				});
		}
		for (const mirror of covered.filter(
			(m) => m.destinationKey === route.key,
		)) {
			if (snapshot.events.some((e) => e.id === mirror.eventId)) continue;
			const exact = await adapter.get(route, mirror.eventId);
			if (exact) snapshot.events.push(exact);
		}
	}
	return snapshots;
}
export async function previewCompensation(
	config: Configuration,
	original: Plan,
	mutations: Mutation[],
	actionIds: string[],
	adapters: Map<string, CalendarAdapter>,
): Promise<Plan> {
	if (
		original.purpose !== "reconcile" ||
		original.configurationId !== config.id ||
		!actionIds.length ||
		actionIds.length > 20
	)
		throw new Error("Compensation requires a bounded original reconcile plan");
	const actions: Action[] = [];
	for (const id of new Set(actionIds)) {
		const action = original.actions.find((a) => a.id === id);
		const mutation = mutations.find((m) => m.actionId === id);
		if (
			!action ||
			!mutation ||
			mutation.state !== "confirmed" ||
			!mutation.revision ||
			action.kind === "delete"
		)
			throw new Error("Compensation requires a confirmed create or update");
		const route = config.calendars.find((r) => r.key === action.destinationKey);
		const adapter = adapters.get(action.destinationKey);
		if (!route || !adapter?.conditionalWrites)
			throw new Error("Compensation requires verified conditional writes");
		const current = await adapter.get(route, mutation.eventId);
		if (
			!current ||
			!owned(current, action.ownership) ||
			current.revision !== mutation.revision ||
			!action.after ||
			!sameInterval(current.interval, action.after)
		)
			throw new Error(
				"Blocker changed after confirmation; compensation denied",
			);
		actions.push({
			...action,
			id: await digest(
				`${config.id}:${config.revision}:undo:${id}:${mutation.revision}`,
			),
			kind: action.kind === "create" ? "delete" : "update",
			destinationEventId: mutation.eventId,
			expectedDestinationRevision: mutation.revision,
			before: current.interval,
			after: action.kind === "create" ? null : action.before,
			compensatesActionId: id,
		});
	}
	return {
		id: crypto.randomUUID(),
		configurationId: config.id,
		configurationRevision: config.revision,
		purpose: "compensate",
		originalPlanId: original.id,
		window: original.window,
		complete: true,
		createdAt: new Date().toISOString(),
		actions,
		conflicts: [],
		snapshotFingerprints: {},
	};
}
export async function applyCompensation(
	config: Configuration,
	plan: Plan,
	adapters: Map<string, CalendarAdapter>,
	store: ApplyStore,
): Promise<Receipt> {
	if (
		plan.purpose !== "compensate" ||
		!plan.originalPlanId ||
		config.mode !== "active" ||
		config.id !== plan.configurationId ||
		config.revision !== plan.configurationRevision ||
		plan.actions.length > 20 ||
		Date.now() - Date.parse(plan.createdAt) > 15 * 60_000
	)
		throw new Error("Compensation preview expired or activation changed");
	const previous = await store.previous();
	const mutations: Mutation[] = [];
	for (const action of plan.actions) {
		const prior = previous.find((m) => m.actionId === action.id);
		if (prior?.state === "confirmed") {
			mutations.push(prior);
			continue;
		}
		const route = config.calendars.find((r) => r.key === action.destinationKey);
		const adapter = adapters.get(action.destinationKey);
		if (
			!route ||
			!adapter?.conditionalWrites ||
			!config.actions.includes(action.kind) ||
			!action.compensatesActionId
		)
			throw new Error("Compensation is outside the activated policy");
		let mutation: Mutation = {
			actionId: action.id,
			state: "intent",
			eventId: action.destinationEventId,
			revision: null,
			error: null,
		};
		const confirm = async () => {
			const current = await adapter.get(route, action.destinationEventId);
			if (
				action.kind === "delete"
					? current !== null
					: !current ||
						!owned(current, action.ownership) ||
						!action.after ||
						!sameInterval(current.interval, action.after)
			)
				throw new Error("Compensation provider readback failed");
			await store.guard();
			await store.mirror(action, current);
			mutation = {
				...mutation,
				state: "confirmed",
				revision: current?.revision ?? null,
				error: null,
			};
			await store.record(mutation);
		};
		try {
			if (prior?.state === "intent" || prior?.state === "uncertain") {
				mutation = { ...prior, state: "uncertain" };
				await confirm();
			} else {
				const current = await adapter.get(route, action.destinationEventId);
				if (
					!current ||
					!owned(current, action.ownership) ||
					current.revision !== action.expectedDestinationRevision ||
					!action.before ||
					!sameInterval(current.interval, action.before)
				)
					throw new Error("Compensation destination changed since preview");
				await store.guard();
				await store.record(mutation);
				await store.guard();
				mutation = { ...mutation, state: "uncertain" };
				if (action.kind === "delete") await adapter.remove(route, action);
				else await adapter.update(route, action);
				await confirm();
			}
		} catch (error) {
			mutation = {
				...mutation,
				state: mutation.state === "intent" ? "conflict" : "uncertain",
				error: error instanceof Error ? error.message : "Compensation failed",
			};
			await store.record(mutation);
		}
		mutations.push(mutation);
	}
	return {
		planId: plan.id,
		outcome: mutations.every((m) => m.state === "confirmed")
			? "confirmed"
			: mutations.some((m) => m.state === "confirmed")
				? "partial"
				: "conflict",
		mutations,
	};
}
/** Recovery performs reads only at the provider: a lost response can never cause a duplicate write. */
export async function recoverPlan(
	config: Configuration,
	plan: Plan,
	adapters: Map<string, CalendarAdapter>,
	store: ApplyStore,
): Promise<Receipt> {
	if (plan.configurationId !== config.id)
		throw new Error("Recovery plan belongs to another configuration");
	const prior = await store.previous();
	const mutations: Mutation[] = [];
	for (const action of plan.actions) {
		const previous = prior.find((m) => m.actionId === action.id);
		if (!previous) continue;
		if (previous.state !== "intent" && previous.state !== "uncertain") {
			mutations.push(previous);
			continue;
		}
		let mutation = { ...previous, state: "uncertain" as Mutation["state"] };
		const route = config.calendars.find((r) => r.key === action.destinationKey);
		const adapter = adapters.get(action.destinationKey);
		if (!route || !adapter)
			throw new Error("Recovery destination is no longer selected");
		try {
			const matches =
				action.kind === "create"
					? await adapter.findOwned(route, action.ownership, plan.window)
					: [await adapter.get(route, previous.eventId)];
			const current = matches[0] ?? null;
			if (
				action.kind === "delete"
					? current !== null
					: matches.length !== 1 ||
						!current ||
						!owned(current, action.ownership) ||
						!action.after ||
						!sameInterval(current.interval, action.after)
			)
				throw new Error(
					"Provider result remains ambiguous; no write was retried",
				);
			await store.guard();
			await store.mirror(action, current);
			mutation = {
				...mutation,
				state: "confirmed",
				compensationEligible:
					plan.purpose === "reconcile" &&
					action.kind !== "delete" &&
					adapter.conditionalWrites,
				eventId: current?.id ?? previous.eventId,
				revision: current?.revision ?? null,
				error: null,
			};
		} catch (error) {
			mutation.error =
				error instanceof Error ? error.message : "Provider recovery failed";
		}
		await store.record(mutation);
		mutations.push(mutation);
	}
	return {
		planId: plan.id,
		outcome:
			mutations.length && mutations.every((m) => m.state === "confirmed")
				? "confirmed"
				: mutations.some((m) => m.state === "confirmed")
					? "partial"
					: "conflict",
		mutations,
	};
}

import {
	digest,
	sameInterval,
	validInterval,
	type Action,
	type Configuration,
	type Mirror,
	type Plan,
	type Snapshot,
	type Interval,
} from "./types";
export async function snapshotFingerprint(
	snapshot: Snapshot,
	window?: Interval,
): Promise<string> {
	return digest(
		JSON.stringify(
			snapshot.events
				.filter(
					(e) =>
						e.revision !== "absent" &&
						!e.ownership &&
						(!window ||
							(Date.parse(e.interval.start) < Date.parse(window.end) &&
								Date.parse(e.interval.end) > Date.parse(window.start))),
				)
				.map((e) => [
					e.id,
					e.revision,
					e.busy,
					e.cancelled,
					e.ownership,
					e.interval,
				])
				.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		),
	);
}
/** Deterministic complete-snapshot reconciliation. Missing out-of-window occurrences are never deletions. */
export async function buildPlan(
	config: Configuration,
	snapshots: Snapshot[],
	mirrors: Mirror[],
	ownershipSeed: string,
): Promise<Plan> {
	const conflicts: string[] = [];
	const byRoute = new Map(snapshots.map((s) => [s.route.key, s]));
	const complete = config.calendars.every(
		(r) => byRoute.get(r.key)?.complete === true,
	);
	const fingerprints: Record<string, string> = {};
	for (const s of snapshots) {
		fingerprints[s.route.key] = await snapshotFingerprint(s, config.window);
		conflicts.push(...s.errors.map((e) => `${s.route.key}: ${e}`));
	}
	const actions: Action[] = [];
	const known = new Map(
		mirrors.map((m) => [`${m.sourceKey}:${m.destinationKey}`, m]),
	);
	const alive = new Set<string>();
	const ledgerOwned = new Set(
		mirrors.map((m) => `${m.destinationKey}:${m.eventId}:${m.ownership}`),
	);
	const action = async (
		kind: Action["kind"],
		sourceKey: string,
		sourceRouteKey: string,
		sourceEventId: string,
		sourceRevision: string | null,
		destinationKey: string,
		mirror: Mirror | undefined,
		after: Action["after"],
		deleteReason?: Action["deleteReason"],
		expectedSourceInterval?: Action["expectedSourceInterval"],
	) => {
		const ownership =
			mirror?.ownership ??
			(await digest(
				`${ownershipSeed}:${sourceKey}:${destinationKey}:${config.revision}:${sourceRevision}`,
			));
		const id = await digest(
			JSON.stringify([
				config.id,
				config.revision,
				kind,
				sourceKey,
				destinationKey,
				mirror?.revision,
				sourceRevision,
				ownership,
				after,
			]),
		);
		actions.push({
			id,
			kind,
			sourceKey,
			sourceRouteKey,
			sourceEventId,
			sourceRevision,
			destinationKey,
			destinationEventId: mirror?.eventId ?? `t${ownership.slice(0, 48)}`,
			expectedDestinationRevision: mirror?.revision ?? null,
			ownership,
			deleteReason,
			expectedSourceInterval,
			before: mirror?.interval ?? null,
			after,
		});
	};
	if (complete)
		for (const snapshot of snapshots)
			for (const event of snapshot.events) {
				// A marker on an unrecorded event is not proof of ownership. Preserve it and never echo it.
				if (event.ownership) {
					if (event.cancelled || !event.busy) continue;
					if (
						!ledgerOwned.has(
							`${snapshot.route.key}:${event.id}:${event.ownership}`,
						)
					)
						conflicts.push(
							`${snapshot.route.key}: unverified blocker ${event.id}`,
						);
					continue;
				}
				if (!event.busy || event.cancelled) continue;
				if (!validInterval(event.interval)) {
					conflicts.push(`${snapshot.route.key}: invalid interval`);
					continue;
				}
				const sourceKey = await digest(
					JSON.stringify([
						snapshot.route.providerId,
						snapshot.route.connectionInstanceId,
						snapshot.route.calendarId,
						event.sourceIdentity,
					]),
				);

				if (
					Date.parse(event.interval.start) >= Date.parse(config.window.end) ||
					Date.parse(event.interval.end) <= Date.parse(config.window.start)
				)
					continue;
				alive.add(sourceKey);
				for (const destination of config.calendars) {
					if (destination.key === snapshot.route.key) continue;
					const mirror = known.get(`${sourceKey}:${destination.key}`);
					const destinationSnapshot = byRoute.get(destination.key)!;
					if (!destinationSnapshot.calendar.canWrite) {
						conflicts.push(`${destination.key}: calendar is read only`);
						continue;
					}
					if (mirror) {
						const current = destinationSnapshot.events.find(
							(e) => e.id === mirror.eventId,
						);
						if (
							!current ||
							current.ownership !== mirror.ownership ||
							current.revision !== mirror.revision
						) {
							conflicts.push(
								`${destination.key}: blocker changed or missing; review required`,
							);
							continue;
						}
						if (!sameInterval(mirror.interval, event.interval))
							await action(
								"update",
								sourceKey,
								snapshot.route.key,
								event.id,
								event.revision,
								destination.key,
								mirror,
								event.interval,
							);
					} else
						await action(
							"create",
							sourceKey,
							snapshot.route.key,
							event.id,
							event.revision,
							destination.key,
							undefined,
							event.interval,
						);
				}
			}
	if (complete)
		for (const mirror of mirrors) {
			if (alive.has(mirror.sourceKey)) continue;
			// Delete only when its entire original occurrence is inside the covered interval.
			if (
				Date.parse(mirror.interval.start) < Date.parse(config.window.start) ||
				Date.parse(mirror.interval.end) > Date.parse(config.window.end)
			)
				continue;
			const source = byRoute.get(mirror.sourceRouteKey);
			const destination = byRoute.get(mirror.destinationKey);
			if (!source?.complete || !destination?.complete) continue;
			const current = destination.events.find((e) => e.id === mirror.eventId);
			if (
				!current ||
				current.ownership !== mirror.ownership ||
				current.revision !== mirror.revision
			) {
				conflicts.push(
					`${mirror.destinationKey}: cleanup ownership or revision conflict`,
				);
				continue;
			}
			const original = source.events.find((e) => e.id === mirror.sourceEventId);
			// Absence in a time-bounded view can mean a move outside the window. Explicit cancelled/free only.
			const movedOutside =
				original?.busy &&
				!original.cancelled &&
				(Date.parse(original.interval.end) <= Date.parse(config.window.start) ||
					Date.parse(original.interval.start) >= Date.parse(config.window.end));
			if (!original || (original.busy && !original.cancelled && !movedOutside))
				continue;
			await action(
				"delete",
				mirror.sourceKey,
				mirror.sourceRouteKey,
				mirror.sourceEventId,
				original.revision === "absent" ? null : original.revision,
				mirror.destinationKey,
				mirror,
				null,
				movedOutside ? "moved_outside_window" : "cancelled_or_free",
				original.interval,
			);
		}
	for (const a of actions)
		if (
			a.kind !== "create" &&
			!byRoute.get(a.destinationKey)?.calendar.conditionalWrites
		)
			conflicts.push(
				`${a.destinationKey}: conditional ${a.kind} is not verified`,
			);
	actions.sort((a, b) => a.id.localeCompare(b.id));
	return {
		id: crypto.randomUUID(),
		configurationId: config.id,
		configurationRevision: config.revision,
		purpose: "reconcile",
		window: config.window,
		complete,
		createdAt: new Date().toISOString(),
		actions,
		conflicts: [...new Set(conflicts)],
		snapshotFingerprints: fingerprints,
	};
}

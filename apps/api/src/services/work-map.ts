import type {
	WorkMap,
	WorkMapActor,
	WorkMapEpic,
	WorkMapItem,
	WorkMapLane,
	WorkMapNotMoving,
	WorkMapSignal,
} from "@tedix/api-contract/schemas/work-map";
import type { WorkMapSnapshot } from "@tedix/db/queries/work-items/map";

/** The supervisor's own heartbeat row (CLI 0.19.9+), reported every 20 s. */
export const SUPERVISOR_LANE = "supervisor";
/** Two missed 20 s beats plus margin: a stop shows within one minute. */
export const HEARTBEAT_DOWN_AFTER_SECONDS = 45;
/** Older CLIs report every two minutes and have no supervisor row. */
export const LEGACY_LATE_AFTER_SECONDS = 150;
export const LEGACY_DOWN_AFTER_SECONDS = 300;

const NOT_MOVING: ReadonlySet<WorkMapSignal["kind"]> = new Set([
	"held",
	"waiting_on_person",
	"waiting_for_approval",
	"blocked",
	"stalled",
]);

type Row = WorkMapSnapshot["items"][number];
type Heartbeat = WorkMapSnapshot["heartbeats"][number];

const ageSeconds = (at: string, now: number) =>
	Math.max(0, Math.floor((now - Date.parse(at)) / 1000));

function iso(value: string | null | undefined): string | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function principal(
	type: string | null | undefined,
	id: string | null | undefined,
): WorkMapActor | null {
	if (!type || !id) return null;
	if (
		type === "user" ||
		type === "tedi" ||
		type === "team" ||
		type === "system" ||
		type === "external_agent"
	)
		return { type, id };
	return null;
}

/** Lanes: the supervisor first, then its runners; silence is never shown as quiet. */
export function buildWorkMapLanes(
	heartbeats: readonly Heartbeat[],
	now: number,
): WorkMapLane[] {
	const byReporter = new Map<string, Heartbeat[]>();
	for (const row of heartbeats)
		byReporter.set(row.reporterId, [
			...(byReporter.get(row.reporterId) ?? []),
			row,
		]);
	const lanes: WorkMapLane[] = [];
	for (const [reporterId, rows] of byReporter) {
		const own = rows.find((row) => row.lane === SUPERVISOR_LANE);
		const fast = Boolean(own);
		const downAfter = fast
			? HEARTBEAT_DOWN_AFTER_SECONDS
			: LEGACY_DOWN_AFTER_SECONDS;
		const lateAfter = fast
			? HEARTBEAT_DOWN_AFTER_SECONDS
			: LEGACY_LATE_AFTER_SECONDS;
		// Without its own row, the supervisor is alive while any report is fresh.
		const newest = (own ? [own] : rows).reduce<Heartbeat | null>(
			(best, row) =>
				!best || Date.parse(row.reportedAt) > Date.parse(best.reportedAt)
					? row
					: best,
			null,
		)!;
		const supervisorAge = ageSeconds(newest.reportedAt, now);
		const supervisorDown = supervisorAge > downAfter;
		const supervisorLate = !supervisorDown && supervisorAge > lateAfter;
		lanes.push({
			id: `${reporterId}:${SUPERVISOR_LANE}`,
			reporterId,
			kind: "supervisor",
			executor: SUPERVISOR_LANE,
			lane: SUPERVISOR_LANE,
			state: supervisorDown ? "down" : supervisorLate ? "late" : "up",
			reason: supervisorDown
				? "No heartbeat: the supervisor stopped or its sign-in failed. Sign-in state is unknown until it reports again; check the machine and run tedix auth status."
				: supervisorLate
					? "One heartbeat missed; it is marked down if the next one does not arrive."
					: fast
						? "Heartbeat is fresh."
						: "Fresh, inferred from runner reports: this CLI has no supervisor heartbeat yet, so a stop shows after 5 minutes. Update the CLI for one-minute detection.",
			reportedAt: iso(newest.reportedAt),
			ageSeconds: supervisorAge,
			downAfterSeconds: downAfter,
			slotsInUse: 0,
			slotsTotal: 0,
			heartbeat: fast,
		});
		for (const row of rows) {
			if (row.lane === SUPERVISOR_LANE) continue;
			const age = ageSeconds(row.reportedAt, now);
			const duty = row.lane.startsWith("task-");
			const problem =
				row.topReason && row.topReasonCount
					? ` Last problem: ${row.topReason} (${row.topReasonCount}× in 30 min).`
					: row.duty?.lastProblem
						? ` Last problem: ${row.duty.lastProblem}`
						: "";
			// A runner reported by the supervisor's own sweep: it cannot be fresher
			// than the supervisor, and its last report is old news once that stops.
			const state: WorkMapLane["state"] = supervisorDown
				? "unknown"
				: age > LEGACY_DOWN_AFTER_SECONDS
					? "down"
					: !row.running && !duty
						? "stopped"
						: duty && row.duty?.state === "failed"
							? "stopped"
							: "up";
			lanes.push({
				id: `${reporterId}:${row.executor}:${row.lane}`,
				reporterId,
				kind: duty ? "duty" : "runner",
				executor: row.executor,
				lane: row.lane,
				state,
				reason:
					(state === "unknown"
						? "The supervisor is down, so this runner's state is unknown."
						: state === "down"
							? "No report for this runner."
							: state === "stopped"
								? duty
									? "The last run failed."
									: "The runner process is not running; the supervisor restarts it on its next pass."
								: row.slotsTotal
									? `${row.slotsInUse} of ${row.slotsTotal} slots busy.`
									: "Reported.") + problem,
				reportedAt: iso(row.reportedAt),
				ageSeconds: age,
				downAfterSeconds: LEGACY_DOWN_AFTER_SECONDS,
				slotsInUse: row.slotsInUse,
				slotsTotal: row.slotsTotal,
				heartbeat: fast,
			});
		}
	}
	const rank = { down: 0, unknown: 1, stopped: 2, late: 3, up: 4 } as const;
	return lanes.sort(
		(a, b) =>
			rank[a.state] - rank[b.state] ||
			(a.kind === "supervisor" ? -1 : 0) - (b.kind === "supervisor" ? -1 : 0) ||
			a.id.localeCompare(b.id),
	);
}

const HELD_COMMENT = /held|holds? /i;

export function buildWorkMap(
	snapshot: WorkMapSnapshot,
	p: { organizationId: string; now: number; stalledAfterHours: number },
): WorkMap {
	const { now } = p;
	const live = new Map(snapshot.items.map((row) => [row.id, row]));
	const projects = new Map(snapshot.projects.map((row) => [row.id, row]));
	const titles = new Map<string, string>([
		...snapshot.epics.map((row) => [row.id, row.title] as const),
		...snapshot.items.map((row) => [row.id, row.title] as const),
	]);
	const lanes = buildWorkMapLanes(snapshot.heartbeats, now);
	const downExecutors = new Set(
		lanes
			.filter(
				(lane) =>
					lane.kind === "runner" &&
					(lane.state === "down" || lane.state === "unknown"),
			)
			.map((lane) => lane.executor),
	);
	const upExecutors = new Set(
		lanes
			.filter((lane) => lane.kind === "runner" && lane.state === "up")
			.map((lane) => lane.executor),
	);

	const ownerOf = (row: Row): WorkMapActor =>
		principal(row.ownerType, row.ownerId) ??
		principal(row.stewardType, row.stewardId) ??
		principal(
			"user",
			row.projectId ? projects.get(row.projectId)?.ownerUserId : null,
		) ?? { type: "unassigned" };

	const waiting = new Map<string, WorkMapSnapshot["interactions"]>();
	for (const row of snapshot.interactions)
		waiting.set(row.workItemId, [...(waiting.get(row.workItemId) ?? []), row]);
	const blockedBy = new Map<string, string[]>();
	const duplicates = new Map<string, string[]>();
	for (const edge of snapshot.relations) {
		if (!live.has(edge.fromId) || !live.has(edge.toId)) continue;
		if (edge.type === "blocks")
			blockedBy.set(edge.toId, [
				...(blockedBy.get(edge.toId) ?? []),
				edge.fromId,
			]);
		else {
			duplicates.set(edge.fromId, [
				...(duplicates.get(edge.fromId) ?? []),
				edge.toId,
			]);
			duplicates.set(edge.toId, [
				...(duplicates.get(edge.toId) ?? []),
				edge.fromId,
			]);
		}
	}
	const claimants = new Map<string, Set<string>>();
	for (const claim of snapshot.claims) {
		if (!live.has(claim.workItemId)) continue;
		claimants.set(
			claim.resourceKey,
			(claimants.get(claim.resourceKey) ?? new Set()).add(claim.workItemId),
		);
	}

	const stalledMs = p.stalledAfterHours * 3_600_000;
	const items: WorkMapItem[] = snapshot.items.map((row) => {
		const signals: WorkMapSignal[] = [];
		const owner = ownerOf(row);
		const lastAt =
			iso(row.lastEventAt) ?? iso(row.acceptedAt) ?? iso(row.createdAt);
		const quiet = lastAt ? now - Date.parse(lastAt) >= stalledMs : false;

		for (const ask of waiting.get(row.id) ?? [])
			signals.push({
				kind: "waiting_on_person",
				reason: `Waiting for an answer to “${ask.subject.slice(0, 200)}”.`,
				since: iso(ask.createdAt),
				actor: principal(ask.targetType, ask.targetId) ?? owner,
				interactionId: ask.id,
			});
		const heldNote =
			row.laneState === "held" || row.laneState === "blocked"
				? ((row.lastComment && HELD_COMMENT.test(row.lastComment)
						? row.lastComment
						: null) ??
					(row.laneState === "blocked"
						? "Automatic execution stopped after its retry also failed; inspect the latest Attempt, fix the cause and start a new Attempt."
						: "Held by its owner; the dispatcher will not start it."))
				: row.lastComment &&
					  /^Dispatcher (admission|execution) held|Automatic execution held/.test(
							row.lastComment,
					  )
					? row.lastComment
					: null;
		if (heldNote)
			signals.push({
				kind: "held",
				reason: heldNote,
				since: lastAt,
				actor: owner,
			});
		for (const blocker of blockedBy.get(row.id) ?? []) {
			const other = live.get(blocker)!;
			signals.push({
				kind: "blocked",
				reason: `Blocked by “${other.title.slice(0, 200)}”, which is still open.`,
				since: lastAt,
				actor: ownerOf(other),
				relatedWorkItemId: blocker,
			});
		}
		if (row.disposition === "proposed" && quiet)
			signals.push({
				kind: "waiting_for_approval",
				reason:
					"Proposed and not yet approved: approve it to start, or cancel it.",
				since: iso(row.createdAt),
				actor: owner,
			});
		if (row.disposition === "accepted" && quiet && !signals.length) {
			const executor = row.executor;
			const reason =
				row.attemptState &&
				["running", "waiting", "queued", "retrying"].includes(row.attemptState)
					? `An Attempt is ${row.attemptState} but nothing has been recorded since.`
					: executor && downExecutors.has(executor)
						? `Its ${executor} runner is down, so nothing can pick it up.`
						: executor &&
							  !upExecutors.has(executor) &&
							  executor !== "human" &&
							  executor !== "tedi"
							? `No ${executor} runner is reporting, so nothing picks it up.`
							: row.lastComment
								? `No progress since the last note: “${row.lastComment.slice(0, 240)}”`
								: row.lastEventType
									? `No progress since its last event (${row.lastEventType.replaceAll("_", " ")}).`
									: "Accepted but never started.";
			signals.push({ kind: "stalled", reason, since: lastAt, actor: owner });
		}
		for (const other of duplicates.get(row.id) ?? [])
			signals.push({
				kind: "conflict",
				reason: `Marked as a duplicate of “${(titles.get(other) ?? "another item").slice(0, 200)}”: keep one.`,
				since: null,
				actor: owner,
				relatedWorkItemId: other,
			});
		for (const [key, holders] of claimants) {
			if (!holders.has(row.id) || holders.size < 2) continue;
			const other = [...holders].find((id) => id !== row.id)!;
			signals.push({
				kind: "overlap",
				reason: `Both this and “${(titles.get(other) ?? "another item").slice(0, 200)}” hold ${key}.`,
				since: null,
				actor: owner,
				relatedWorkItemId: other,
			});
		}
		if (!row.projectId && !row.objectiveId && !row.workClass && !row.parentId)
			signals.push({
				kind: "orphan",
				reason: "No purpose: not in a project, objective or epic.",
				since: null,
				actor: owner,
			});
		return {
			id: row.id,
			title: row.title,
			disposition: row.disposition,
			priority: row.priority,
			parentId: row.parentId,
			projectId: row.projectId,
			objectiveId: row.objectiveId,
			executor: row.executor,
			attemptState: row.attemptState,
			lastEventAt: iso(row.lastEventAt),
			signals,
		};
	});

	const counts = new Map<string, Record<string, number>>();
	for (const row of snapshot.childCounts)
		counts.set(row.parentId, {
			...(counts.get(row.parentId) ?? {}),
			[row.disposition]: row.count,
		});
	const epics: WorkMapEpic[] = snapshot.epics.map((row) => {
		const byDisposition = counts.get(row.id) ?? {};
		const completed = byDisposition.completed ?? 0;
		const cancelled = byDisposition.cancelled ?? 0;
		const total = Object.values(byDisposition).reduce((sum, n) => sum + n, 0);
		return {
			id: row.id,
			title: row.title,
			disposition: row.disposition,
			parentId: row.parentId,
			projectId: row.projectId,
			objectiveId: row.objectiveId,
			progress: {
				total,
				completed,
				cancelled,
				open: total - completed - cancelled,
				percentDone:
					total - cancelled > 0 ? completed / (total - cancelled) : 0,
			},
		};
	});

	const notMoving: WorkMapNotMoving[] = items
		.flatMap((item) => {
			const signal = item.signals.find((s) => NOT_MOVING.has(s.kind));
			return signal
				? [
						{
							workItemId: item.id,
							title: item.title,
							kind: signal.kind,
							blocker: signal.reason,
							since: signal.since,
							actor: signal.actor,
							...(signal.interactionId
								? { interactionId: signal.interactionId }
								: {}),
						},
					]
				: [];
		})
		.sort(
			(a, b) =>
				(a.since ? Date.parse(a.since) : now) -
				(b.since ? Date.parse(b.since) : now),
		);

	return {
		organizationId: p.organizationId,
		readAt: new Date(now).toISOString(),
		stalledAfterHours: p.stalledAfterHours,
		truncated: snapshot.truncated,
		objectives: snapshot.objectives,
		projects: snapshot.projects.map(({ id, name, objectiveId }) => ({
			id,
			name,
			objectiveId,
		})),
		epics,
		items,
		lanes,
		notMoving,
	};
}

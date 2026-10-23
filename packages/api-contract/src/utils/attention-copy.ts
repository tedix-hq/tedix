/** Shared English copy for Attention, session boards and brief renderers. */
export const ATTENTION_COPY = {
	running: "Running",
	waiting: "Waiting on you",
	blocked: "Blocked",
	blockedOrInactive: "Blocked or inactive",
	blockedReason: "Blocked: {{reason}}",
	done: "Done",
	inactive: "Inactive",
	inactiveLastSeen: "Inactive · last seen {{minutes}} min ago",
	heartbeatUnknown: "Heartbeat not reported",
	ended: "Ended",
	unknown: "Status unknown",
	backlog: "Backlog",
	local_codex: "Local session (Codex)",
	local_devin: "Local session (Devin)",
	local_claude: "Local session (Claude)",
	local: "Local session",
	cloud_tedi: "Tedi",
	tediNamed: "Tedi ({{name}})",
	factory: "Factory",
	factoryNamed: "Factory ({{name}})",
	coordinator: "Scheduled job",
	unknownSource: "Source unknown",
	away: "While you were away",
	trackedRequest: "Request in progress; execution unconfirmed",
	skillRun: "Skill run",
	now: "Now",
	doneToday: "Done today",
	goals: "Goals",
	lane: "Lane",
	whatItDoes: "What it does",
	started: "Started",
	owner: "Source",
	goal: "Goal",
	goalStatus: "Where it stands",
	trend: "Trend",
	noRunning: "No running work recorded.",
	noClosures: "No evidence-backed closures today.",
	nothingWaiting: "Nothing waiting on you.",
	sessionActivity: "Session activity",
	boardUpdated: "Updated {{at}}. Request dates mean tracked since.",
	contributions: "Today's contributions",
	work: "Work",
	gaps: "Needs attention",
	unfiled: "Automatic filing",
	unfiledCount: "Filing automatically · {{count}}",
	ready: "Ready for someone",
	heartbeatStale: "Heartbeat stale",
	heartbeatReceived: "Heartbeat received",
	recentLanes: "Last 2 hours · {{count}} lanes",
	sparkline: "Activity sparkline",
	noRecentActivity: "No reported activity in the last two hours.",
	twoHoursAgo: "2 hours ago",
	oneHourAgo: "1 hour ago",
	timelineHelp: "Bars show recorded heartbeats.",
	contributionHelp:
		"Share of reported time in this overview · overlapping work counts separately",
	activityBySource: "Activity by source",
	noReplyNeeded: "Nothing needs your reply.",
	nothingHere: "Nothing here right now.",
	noFocusMatches: "No work matches your current focus.",
	gapUnknown: "{{name}} · no activity recorded",
	gapDay: "No recorded activity for {{name}} in 1 day",
	gapDays: "No recorded activity for {{name}} in {{days}} days",
	allGoalsRecent: "No recorded gaps in this overview.",
	fileToProject: "File to project",
	fileRequest: "File to project: {{text}}",
	allFiled: "All captured requests are filed.",
	awaySummary:
		"{{done}} finished · {{waiting}} waiting on you · {{updated}} updated since your last visit.",
	focusToday: "Focus today",
	focusPlaceholder: "Focus today — what matters?",
	setFocus: "Set focus",
	arrange: "Arrange view",
	savedView: "Your view · saved across devices",
	focusProject: "Focus project",
	allProjects: "All projects",
	onlyProject: "Only {{name}}",
	show: "Show",
	hide: "Hide",
	comfortable: "Comfortable spacing",
	compact: "Compact spacing",
	reset: "Reset view",
	bounded: "Showing a bounded overview",
	boundedHelp:
		"Some older activity is outside this view. Counts and contributions describe the records shown.",
	connectionStarting: "Attention connection is starting",
	together: "Local sessions and cloud workers, together.",
	updatesPaused: "Live updates paused",
	connecting: "Connecting…",
	live: "Live · every 2 seconds",
	reconnecting: "Last received state stays visible. Reconnecting to Tedix…",
	saveFailed: "Changes could not be saved",
	loading: "Loading attention…",
	timeUnknown: "Time unknown",
	seconds: "{{seconds}}s",
	minutesSeconds: "{{minutes}}m {{seconds}}s",
	hoursMinutes: "{{hours}}h {{minutes}}m",
	tediRun: "Tedi run",
	reportedComplete: "Reported complete",
	childUnconfirmed:
		"Part of an active session; progress has not been confirmed",
	laneUnconfirmed: "Reported work; heartbeat unconfirmed",
	unassigned: "Unassigned",
	readyToPickUp: "Ready for someone to pick up",
	stalled: "Stalled",
	schedulePromises: "Scheduled follow-ups: {{kept}} kept · {{missed}} missed",
	resumeRequested: "{{cause}} · resume requested {{duration}} ago",
	noStalls: "No stalls need your attention. Tedix handles recovery first.",
	recoveryPending: "Waiting for recovery updates.",
	waitingDecision: "Waiting on your decision",
	heartbeatOverdue: "Heartbeat overdue; activity is unconfirmed",
	leaseElapsed: "Work lease elapsed; activity is unconfirmed",
	filingProposal: "Filed to {{project}}?",
	filingWhyNow:
		"This request was filed automatically with a low confidence match.",
	filingRecommendation:
		"Keep the destination if it fits; otherwise return it for a better match.",
	filingBlastRadius: "One request and its proposed Work",
	filingWaitingCost: "Future requests may repeat the same filing mistake.",
	filingFallbackReason: "Automatic project match",
	filingKeep: "Yes, keep it",
	filingKeepConsequence: "Keep this request in {{project}}.",
	filingCorrect: "No, refile it",
	filingCorrectConsequence:
		"Return this request to Unfiled and teach the filer that this destination was wrong.",
	filingCorrectionCost: "The filer will find a better destination.",
	filingReviewReason:
		"Only the ledger owner can correct this private request's destination.",
	filingReviewPrompt: "{{request}}\n\nFiled automatically: {{reason}}",
	noCost: "None",
	supportDraftProposal: "Publish the Support answer: {{title}}?",
	supportDraftWhyNow:
		"Support has prepared a cited answer; the reporter is still waiting.",
	supportDraftRecommendation:
		"Review the exact reply and publish it if it answers the report.",
	supportDraftBlastRadius: "One public reply on the reporter's support ticket",
	supportDraftWaitingCost:
		"The reporter cannot see the prepared answer until it is published.",
	supportDraftApprove: "Publish this reply",
	supportDraftConsequence:
		"Publish this exact reviewed reply to the support ticket.",
	supportDraftReject: "Keep it private",
	supportDraftRejectConsequence:
		"Leave the draft private for a revised answer.",
	supportDraftRejectCost: "The reporter continues waiting.",
	supportDraftReason:
		"Only the designated human admin can publish this support reply.",
} as const;

export function attentionCopy(
	key: keyof typeof ATTENTION_COPY,
	values: Record<string, string | number> = {},
): string {
	return ATTENTION_COPY[key].replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
		String(values[token] ?? `{{${token}}}`),
	);
}

export const LOCAL_SESSION_INACTIVE_AFTER_MS = 5 * 60_000;

function heartbeatAgeMs(heartbeatAt: string | null, now: Date): number {
	const at =
		heartbeatAt?.replace(
			/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)$/,
			"$1Z",
		) ?? "";
	return now.getTime() - Date.parse(at);
}

export function localSessionInactive(
	heartbeatAt: string | null,
	now: Date,
	inactiveAfterMs = LOCAL_SESSION_INACTIVE_AFTER_MS,
): boolean {
	const age = heartbeatAgeMs(heartbeatAt, now);
	return Number.isFinite(age) && age >= inactiveAfterMs;
}

export function inactiveSessionLabel(
	heartbeatAt: string | null,
	now: Date,
): string {
	const age = heartbeatAgeMs(heartbeatAt, now);
	return Number.isFinite(age)
		? attentionCopy("inactiveLastSeen", {
				minutes: Math.max(0, Math.floor(age / 60_000)),
			})
		: ATTENTION_COPY.heartbeatUnknown;
}

export type AttentionSourceKind =
	| "local_codex"
	| "local_devin"
	| "local_claude"
	| "cloud_tedi"
	| "factory"
	| "coordinator"
	| "unknown";

export function attentionSourceLabel(
	source: AttentionSourceKind,
	name?: string | null,
): string {
	if (source === "unknown") return ATTENTION_COPY.unknownSource;
	if (source === "cloud_tedi" && name)
		return attentionCopy("tediNamed", { name });
	if (source === "factory" && name)
		return attentionCopy("factoryNamed", { name });
	return ATTENTION_COPY[source];
}

export function attentionStatusLabel(
	card: {
		source?: string;
		activitySource?: AttentionSourceKind;
		column: "moving" | "waiting" | "blocked" | "done" | "backlog";
		heartbeatAt: string | null;
		note: string;
	},
	now: Date,
): string {
	if (
		card.source !== "interaction" &&
		card.activitySource?.startsWith("local_")
	) {
		if (localSessionInactive(card.heartbeatAt, now)) {
			return inactiveSessionLabel(card.heartbeatAt, now);
		}
		if (!card.heartbeatAt && card.column !== "done") {
			return ATTENTION_COPY.heartbeatUnknown;
		}
	}
	if (card.column === "blocked") {
		return card.note
			? attentionCopy("blockedReason", { reason: card.note })
			: ATTENTION_COPY.blocked;
	}
	return ATTENTION_COPY[card.column === "moving" ? "running" : card.column];
}

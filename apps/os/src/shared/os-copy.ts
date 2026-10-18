import type { WorkItemKind } from "@tedix/api-contract/schemas/work-items";
import { ATTENTION_COPY } from "@tedix/api-contract/utils/attention-copy";
import { readOsLocale as osLocale } from "@/shared/os-locale";
import {
	SPANISH_FEED_DECK_COPY,
	SPANISH_DECISION_CONTROLS,
} from "@/shared/os-copy-es";

/** Only call for interface labels, never for source text or exact action payloads. */
export function decisionText(english: string): string {
	return osLocale().startsWith("es")
		? (SPANISH_DECISION_CONTROLS[english] ?? english)
		: english;
}

/** Generic OS wording. Names and tenant-specific content come from records. */
const ENGLISH_COPY = {
	routePending: {
		loading: "Loading Tedix OS…",
	},
	outboundProfile: {
		title: "What we learned from your choices",
		description:
			"Your Deck decisions, approvals and sent emails help Tedix learn your preferences.",
		loading: "Loading your learning profile…",
		empty: "Your first decision or edit starts your profile.",
		decisions: (count: number) =>
			`Your profile includes ${count} recent ${count === 1 ? "decision" : "decisions"}.`,
		examples: (count: number) =>
			count
				? `${count} sent-mail examples are saved privately for you.`
				: "Import the plain text of your last 10 sent emails to teach your voice.",
		learn: "Learn from my last 10 sent emails",
		learning: "Reading your sent emails…",
		connections: "Manage Gmail accounts in Connections",
	},
	learning: {
		preference: (sentence: string) =>
			`Got it — ${sentence.replace(/^(Prefer|Use) /, "I’ll use ")}`,
		replied: "They replied — this outcome will help rank future suggestions.",
		shorter: (subject: string) => `Got it — shorter wording for ${subject}.`,
		less: (subject: string) => `Got it — less like this for ${subject}.`,
		later: (subject: string) =>
			`Got it — ${subject} can wait. I'll adjust what comes next.`,
		noted: (subject: string) =>
			`Got it — I'll use this signal for the next ${subject} suggestion.`,
		undo: "Undo learning",
		undone: "Learning corrected. Your decision is unchanged.",
		failed: "Couldn't correct that learning. Try again.",
		why: "Why this?",
		signals: "Signals used",
		evidence: "Evidence",
		initial: "I’ll learn from your next choice.",
		lessons: "Lessons used",
	},
	workHome: {
		feed: "Feed",
		deck: "Deck",
		decide: "Decide",
		views: "Work",
		apps: "Apps",
		back: "Back to Feed",
		loading: "Loading your Work apps…",
		unavailable: "Your Work apps could not be loaded.",
		install: "Choose a Feed and Deck app in your workspace to get started.",
		missing: "This app is not available in your workspaces.",
		workspaces: "Open workspaces",
		retry: "Retry",
		partial: "Some workspace apps could not be loaded.",
		moreApps: "All workspace apps",
		now: "Now",
		needsToday: (n: number) =>
			`${n} ${n === 1 ? "choice here needs" : "choices here need"} you today`,
		working: (names: string) => `Working now: ${names}`,
		noSessions: "No sessions reporting work",
		activityUnavailable: "Current activity is unavailable",
		nextDeadline: "Next known deadline",
		noDeadline: "No upcoming deadline in these updates",
		countUnavailable: "Count unavailable",
		loadedCount: "Choices in the current deck; more may be waiting",
		approvalRequester: "Work reviewer",
		openWork: "Open Work record",
		exactProposal: "Exact proposal",
		decisionReason: "Decision reason",
		reasonRequired: "Write a short reason for this decision.",
		approveExact: "Approve exact proposal",
		reject: "Not this",
		approvalConfirmation:
			"Approve this exact Work proposal with the reason you entered?",
	},
	feedDeckVisual: {
		agentSession: "Coding assistant",
		projectProposer: (name: string, project?: string) =>
			`${name} (for ${project ?? "this project"})`,
		publishHomeCta: "Publish the updated home page CTA?",
		more: "More",
		less: "Less",
		source: "Open source",
		linkedPage: "linked page",
		workspaceDocument: "Open workspace document",
		document: "Open document",
		workRecord: "Open Work record",
		openSite: (site: string) => `Open ${site}`,
		context: "What to know",
		choices: "What each choice does",
		learning: "Learning your preferences",
		clear: "Deck clear",
		thisMorning: "This morning",
		thisAfternoon: "This afternoon",
		thisEvening: "This evening",
		earlier: "Earlier",
		doneToday: (count: number) =>
			`${count} decision${count === 1 ? "" : "s"} made today. A little more room to think.`,
	},
	decisionDeck: {
		approvalActor: "your agent",
		approvalSummary: (source: string) =>
			`Let ${source} run the requested action. Review the exact operation and target in Details before approving.`,
		testLoginSummary: (source: string) =>
			`Let ${source} sign in a made-up test user to check the reported fix. The test link stays with the agent; no email is sent.`,
		explicitApproval:
			"This action needs your explicit approval. It cannot be delegated.",
		filters: "Find a decision",
		noMatches: "No decisions match these filters",
		workOverview: "Open Work overview",
		weeklyTitle: "What I learned about you this week",
		weeklyScope:
			"Your recent recorded choices, with links to check them. Corrections reset unchanged approvals.",
		learnedApprovals: (count: number) => `${count} unchanged approvals`,
		readReceipt: "Read receipt",
		workViews: "Work views",
		deck: "Deck",
		feed: "Feed",
		loadingApp: "Loading your Work app…",
		appUnavailable: "Your Work app could not be loaded.",
		installApp: "Choose a Deck and Feed app in your workspace to start here.",
		openWorkspaces: "Open workspaces",
		retry: "Try again",
		title: "One decision at a time",
		intro: "Make a few choices, then get back to your day.",
		shortcuts:
			"← Not this · → Approve · E Change · L Later · D Decide for me · ? Why this",
		left: (count: number) => `${count} left`,
		clear: "Deck clear",
		nextBatch: (time: string) => `Next cards at ${time}`,
		dailyGoal: (done: number, goal: number) => `${done}/${goal} daily goal`,
		streak: (days: number) => `${days} day streak`,
		nobodyOn: "Nobody is carrying this yet — choose who takes the next step.",
		revalidate:
			"This deadline has passed. Check the source before asking for a fresh decision.",
		expires: (minutes: number) =>
			minutes <= 0
				? "Expired — check the source before deciding"
				: `Expires in ${minutes} min`,
		metrics: {
			title: "Decision attention",
			loaded: "Recent recorded activity for you. Totals may be incomplete.",
			time: "Time to decide",
			delegation: "Decide for me",
			cards: "Cards today",
			visits: "Return visits today",
			corrections: "Corrections",
			unavailable: "Decision attention could not be loaded.",
		},
		cardKinds: {
			outbound: "Approve email",
			proposal: "Next step",
			question: "Your call",
			approval: "Your approval",
			decision: "Your call",
			adr: "Architecture decision",
		} as Record<string, string>,
		kinds: {
			all: "All kinds",
			outbound: "Messages",
			proposal: "Proposals",
			question: "Questions",
			approval: "Approvals",
			decision: "Choices",
			adr: "Architecture",
		},
		projects: {
			Examples: "Examples",
			Unfiled: "Unfiled",
			Organization: "Organization",
		},
		projectUnavailable: "Project unavailable",
	},
	slideFontFamilies: [
		["Inter", "Inter, sans-serif"],
		["Space Grotesk", "Space Grotesk, sans-serif"],
		["DM Sans", "DM Sans, sans-serif"],
		["IBM Plex Sans", "IBM Plex Sans, sans-serif"],
		["Manrope", "Manrope, sans-serif"],
		["Playfair Display", "Playfair Display, serif"],
		["Merriweather", "Merriweather, serif"],
		["JetBrains Mono", "JetBrains Mono, monospace"],
	],
	chatStarterPrompts: [
		"Create a doc titled Weekly update with three short sections.",
		"Make a sheet that tracks open tasks, owners and due dates.",
		"Summarize what changed this week and what I should decide next.",
	],
	tediCostHeaders: [
		"Tedi",
		"Estimated model cost",
		"Observed tokens",
		"Cache hit rate",
		"Pricing coverage",
		"Known subtotal",
		"Priced rows",
		"Unpriced rows",
		"Unpriced tokens",
	],
	dailyCostHeaders: [
		"Date",
		"Estimated model cost",
		"Observed tokens",
		"Pricing coverage",
		"Known subtotal",
		"Priced rows",
		"Unpriced rows",
		"Unpriced tokens",
	],
	portfolio: {
		defaults: [
			{ key: "projects", label: "Projects" },
			{ key: "programs", label: "Programs" },
			{ key: "prospects", label: "Prospects" },
			{ key: "applications", label: "Applications" },
			{ key: "communities", label: "Communities" },
			{ key: "other", label: "Other" },
		],
		unsorted: "Unsorted",
		unknown: (count: number, key: string) =>
			`${count} project${count === 1 ? " uses" : "s use"} section '${key}' which is not in your settings — add it or move them.`,
	},
	workspace: {
		allWorkspaces: "All workspaces",
	},
	notebookSubjects: ["Answers", "Git", "Deploys", "Work", "Agents"],
	weekdays: [
		"Sunday",
		"Monday",
		"Tuesday",
		"Wednesday",
		"Thursday",
		"Friday",
		"Saturday",
	],
	chatFormats: ["Document", "Spreadsheet", "Presentation"],
	work: {
		status: "Status",
		owner: "Owner",
		unassigned: ATTENTION_COPY.unassigned,
		ownerUnavailable: "Owner name unavailable",
		proposed: "Proposed — waiting for the owner to accept",
		needsAcceptance: (name: string) =>
			`Not started yet · ${name} needs to accept this`,
		accept: "Accept",
		accepting: "Accepting…",
		acceptError: "Could not accept this task. Please try again.",
		ready: ATTENTION_COPY.readyToPickUp,
		waitingNextStep: "Waiting for the next step",
		atAGlance: "At a glance",
		due: "Due",
		noDue: "No due date",
		nextStep: "Next step",
		noNextStep: "No steps left on the checklist",
		reminders: "Reminders",
		noReminders: "No reminders",
		reminder: "Reminder",
		project: "Project",
		noProject: "No project",
		description: "What needs to happen",
		activity: "Activity",
		activityDescription: "Progress and questions from people and tedis.",
		emptyActivity: "No updates yet.",
		technicalDetails: "Technical details",
		copyLink: "Copy link",
		checklistError: "Could not save this checkbox. Please try again.",
		checked: (task: string) => `Completed: ${task}`,
		unchecked: (task: string) => `Reopened: ${task}`,
		nothingProduced: "Nothing produced yet",
		kinds: {
			coding: "Software change",
			research: "Research task",
			operations: "Operations task",
			communication: "Conversation and follow-up",
			outbound: "Outreach and follow-up",
			browser: "Web task",
			design: "Design task",
			document: "Document to prepare",
			finance: "Finance task",
			incident: "Problem to resolve",
			legal: "Legal task",
			stewardship: "Care and maintenance",
			other: "Task",
		} satisfies Record<WorkItemKind, string>,
	},
	feed: {
		evidencePreview: "Work evidence preview",
		actors: {
			user: "Person",
			tedi: "Tedi",
			external_agent: "Project team",
			codex: "Codex",
			"claude-code": "Claude",
			system: "Tedix",
		},
		workEvents: {
			"work.created": "was proposed",
			"work.accepted": "was accepted",
			"work.completed": "was completed",
			"work.cancelled": "was cancelled",
			"work.specification_updated": "was updated",
			"attempt.started": "started",
			"attempt.expired": "needs a fresh attempt",
			"attempt.failed": "needs another look",
		},
		outcomes: {
			succeeded: "the work finished",
			failed: "needs another look",
			expired: "paused before finishing",
			cancelled: "was stopped",
		},
		workUpdated: "was updated",
		title: "Your activity",
		subtitle: "What matters now, with the record behind it.",
		filters: {
			all: "All",
			attention: "Needs me",
			office: "Replies",
			history: "Done",
			stalled: "Stalled",
			queue: "In progress",
		},
		greeting: (hour: number, name: string) =>
			`${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}, ${name}`,
		decisionsWaiting: (count: string) => `${count} decisions waiting → Deck`,
		deckClear: "Deck clear →",
		options: "Feed options",
		details: "Details",
		whileYouSlept: "While you slept",
		forProject: (name: string, project: string) => `${name} for ${project}`,
		more: "More like this",
		why: "Why?",
		mute: "Not for me",
		comment: "Comment",
		work: "Turn into Work",
		source: "Open receipt",
		deck: "Open decision deck",
		new: "New since you looked",
		due: "Time matters",
		digest: (n: number) => `${n} smaller ${n === 1 ? "update" : "updates"}`,
		digestHint: "Grouped to protect your attention. Open when you have time.",
		workExplanation: "Recorded in the linked Work history.",
		resultExplanation: "The linked attempt records this outcome.",
		correctionExplanation:
			"Your correction is recorded for reflection into personal lessons.",
		loading: "Loading your activity…",
		empty: "Nothing here needs your attention right now.",
		partial: "Some sources could not be read. Retry to see the full picture.",
		retry: "Retry",
		loadMore: "Earlier activity",
		end: "You reached the end of the available activity.",
		quiet: "Quiet hours · routine updates are grouped below.",
		saved: "Saved for you",
		correctionSaved: "Correction recorded for personal learning",
		failed: "Could not save. Please try again.",
		correction: "What should Tedix learn from this?",
		save: "Save correction",
		cancel: "Cancel",
		reset: "Reset feed preferences",
		markSeen: "Mark these updates seen",
		allProjects: "Your projects",
		project: "Filter projects",
		recommendation: "Recommendation",
		waiting: "Cost of waiting",
		lessons: "Lessons behind this",
		whyRank:
			"Rank considers importance, action needed, deadlines, changes since your last visit and your preferences. Time breaks ties.",
		learningHint:
			"Corrections become personal lessons through reflection. A reaction never authorizes an action.",
		workCreated: "Proposed Work created",
		kinds: {
			work: "Work",
			result: "Result",
			approval: "Approval",
			decision: "Decision",
			correction: "Correction",
			signal: "Signal",
		},
	},
} as const;

/** Resolve at render time so loading or changing personal preferences updates copy. */
export const OS_COPY = {
	...ENGLISH_COPY,
	get workHome() {
		return osLocale().startsWith("es")
			? SPANISH_FEED_DECK_COPY.workHome
			: ENGLISH_COPY.workHome;
	},
	get feedDeckVisual() {
		return osLocale().startsWith("es")
			? SPANISH_FEED_DECK_COPY.feedDeckVisual
			: ENGLISH_COPY.feedDeckVisual;
	},
	get decisionDeck() {
		return osLocale().startsWith("es")
			? SPANISH_FEED_DECK_COPY.decisionDeck
			: ENGLISH_COPY.decisionDeck;
	},
	get learning() {
		return osLocale().startsWith("es")
			? SPANISH_FEED_DECK_COPY.learning
			: ENGLISH_COPY.learning;
	},
	get feed() {
		return osLocale().startsWith("es")
			? SPANISH_FEED_DECK_COPY.feed
			: ENGLISH_COPY.feed;
	},
};

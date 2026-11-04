import type { AgentSessionRequestKind } from "@tedix/db/schema/agent-session-requests";

export const FILING_CORPUS_VERSION = "request-filing-fictional-v1";
export const FILING_ORG = "org-holdout";
export const FILING_OWNER = "user-ada";
export const FILING_NOW = "2026-10-20T10:00:00.000Z";
export const FILING_HARNESS = "codex";
export const FILING_SESSION_KEY = "session-holdout";

/**
 * The scripted upstream answer, mapped onto each arm's own model surface.
 * On the baseline path the single freeform model call emits `project`
 * when it is visible in the built prompt, else `baselineProject ?? null`;
 * `scoreProjectFit` returns `confidence` whenever the pick chose a project.
 * On the candidate path `chooseProject` returns `project` verbatim
 * (including NONE, UNCLEAR and foreign ids) with `confidence`, and the
 * grounded writer runs only for a novel container and returns `novelRaw`.
 */
export interface FilingUpstream {
	project: string;
	confidence: number;
	workItemId?: string | null;
	actionable: boolean;
	/** Project the baseline model emits when `project` is outside its window. */
	baselineProject?: string | null;
	container?: "project" | "workspace" | "factory_proposal";
	name?: string;
	brief?: string;
	reason?: string;
	/** Raw writer output for a confident NONE choice; also the baseline pick. */
	novelRaw?: string;
	/** Every model call throws this message. */
	throw?: string;
}

export interface FilingCase {
	id: string;
	split: "holdout";
	kind: AgentSessionRequestKind;
	text: string;
	/** Filler projects inserted before the named portfolio. */
	extraProjects?: number;
	session?: { projectId: string; label: string; summary?: string };
	work?: Array<{
		id: string;
		title: string;
		projectId: string | null;
		disposition?: string;
	}>;
	upstream: FilingUpstream;
	/** Gold project that should auto-file, or null when abstention is right. */
	expectedFiled: string | null;
	note?: string;
}

export const FILING_PORTFOLIO = [
	{
		id: "proj-docs",
		key: "DOCS",
		name: "Documentation",
		description: "Installation guides and workspace setup help",
	},
	{
		id: "proj-billing",
		key: "BILL",
		name: "Billing",
		description: "Invoices, metered usage and payouts",
	},
	{
		id: "proj-growth",
		key: "GROW",
		name: "Growth",
		description: "Outbound campaigns and referral programs",
	},
	{
		id: "proj-security",
		key: "SEC",
		name: "Security",
		description: "Access reviews and credential policy",
	},
	{
		id: "proj-intake",
		key: "INBX",
		name: "Inbox",
		description: "Unsorted captured requests awaiting review",
	},
	// Seeded last so zero-overlap ranking leaves it tail-most under truncation.
	{
		id: "proj-tail",
		key: "ARCH",
		name: "Archives",
		description: "Retention and quarterly archive indexes",
	},
] as const;

const novel = (raw: unknown) => JSON.stringify(raw);
const NOVEL_BRIEF = {
	projectId: null,
	workItemId: null,
	objectiveId: null,
	name: "Vendor audits",
	brief: "Track recurring vendor audits",
	container: "project",
	actionable: true,
	reason: "No existing project fits",
};

/** Frozen before replay. Gold labels must never enter model prompts. */
export const FILING_CASES: FilingCase[] = [
	{
		id: "h01",
		split: "holdout",
		kind: "request",
		text: "Fix the installation guide for new workspaces",
		upstream: { project: "proj-docs", confidence: 0.9, actionable: true },
		expectedFiled: "proj-docs",
	},
	{
		id: "h02",
		split: "holdout",
		kind: "request",
		text: "Draft the invoice template for metered usage",
		upstream: { project: "proj-billing", confidence: 0.92, actionable: true },
		expectedFiled: "proj-billing",
	},
	{
		id: "h03",
		split: "holdout",
		kind: "request",
		text: "Review the outbound referral campaign copy",
		upstream: { project: "proj-growth", confidence: 0.88, actionable: true },
		expectedFiled: "proj-growth",
	},
	{
		id: "h04",
		split: "holdout",
		kind: "issue",
		text: "Rotate the stale access credential",
		upstream: { project: "proj-security", confidence: 0.8, actionable: true },
		expectedFiled: "proj-security",
		note: "Boundary: the automatic threshold is inclusive at 0.8.",
	},
	{
		id: "h05",
		split: "holdout",
		kind: "request",
		text: "Continue the installation walkthrough",
		session: { projectId: "proj-docs", label: "Installation guides" },
		work: [
			{
				id: "work-docs",
				title: "Installation walkthrough",
				projectId: "proj-docs",
			},
		],
		upstream: {
			project: "proj-docs",
			confidence: 0.9,
			workItemId: "work-docs",
			actionable: true,
		},
		expectedFiled: "proj-docs",
		note: "Reuses matching existing Work instead of proposing a duplicate.",
	},
	{
		id: "h06",
		split: "holdout",
		kind: "question",
		text: "Update the invoice numbering scheme",
		upstream: { project: "proj-billing", confidence: 0.95, actionable: true },
		expectedFiled: "proj-billing",
	},
	{
		id: "h07",
		split: "holdout",
		kind: "request",
		text: "Adjust the referral payout wording",
		upstream: { project: "proj-billing", confidence: 0.9, actionable: true },
		expectedFiled: "proj-growth",
		note: "Scripted upstream error: a confident wrong pick files wrong on both arms.",
	},
	{
		id: "h08",
		split: "holdout",
		kind: "request",
		text: "Clarify the onboarding checklist step",
		upstream: { project: "proj-security", confidence: 0.85, actionable: true },
		expectedFiled: "proj-docs",
		note: "Scripted upstream error: a confident wrong pick files wrong on both arms.",
	},
	{
		id: "h09",
		split: "holdout",
		kind: "request",
		text: "Extend the installation troubleshooting page",
		upstream: { project: "proj-docs", confidence: 0.4, actionable: true },
		expectedFiled: null,
		note: "Below-threshold match stays pending with the project suggested.",
	},
	{
		id: "h10",
		split: "holdout",
		kind: "request",
		text: "Recount the quarterly invoice totals",
		upstream: { project: "proj-billing", confidence: 0.79, actionable: true },
		expectedFiled: null,
	},
	{
		id: "h11",
		split: "holdout",
		kind: "request",
		text: "Tidy the shared filing rules",
		upstream: { project: "UNCLEAR", confidence: 0.9, actionable: false },
		expectedFiled: null,
		note: "Baseline flags any project-free pick as a factory proposal; the chooser does not.",
	},
	{
		id: "h12",
		split: "holdout",
		kind: "request",
		text: "Sketch a one-off maintenance note",
		upstream: { project: "NONE", confidence: 0.4, actionable: false },
		expectedFiled: null,
		note: "Low-confidence NONE stays pending; the candidate never calls the writer.",
	},
	{
		id: "h13",
		split: "holdout",
		kind: "request",
		text: "Track the recurring vendor audits",
		upstream: {
			project: "NONE",
			confidence: 0.9,
			actionable: true,
			novelRaw: novel(NOVEL_BRIEF),
		},
		expectedFiled: null,
		note: "Confident NONE invokes the grounded writer once on the candidate only.",
	},
	{
		id: "h14",
		split: "holdout",
		kind: "request",
		text: "Close out the invoice dispute item",
		work: [
			{
				id: "work-billing",
				title: "Invoice dispute",
				projectId: "proj-billing",
			},
		],
		upstream: {
			project: "NONE",
			confidence: 0.9,
			workItemId: "work-billing",
			actionable: true,
		},
		expectedFiled: null,
		note: "A NONE choice with matching Work suppresses the novel writer.",
	},
	{
		id: "h15",
		split: "holdout",
		kind: "request",
		text: "Organize the recurring audit notes",
		upstream: {
			project: "NONE",
			confidence: 0.9,
			actionable: true,
			novelRaw: novel({ ...NOVEL_BRIEF, projectId: "proj-docs" }),
		},
		expectedFiled: null,
		note: "The writer tried to claim an existing project after a NONE choice; only the chooser path refuses it.",
	},
	{
		id: "h16",
		split: "holdout",
		kind: "request",
		text: "Plan the seasonal index cleanup",
		upstream: {
			project: "NONE",
			confidence: 0.9,
			actionable: true,
			novelRaw: "private request text",
		},
		expectedFiled: null,
		note: "Malformed writer output fails both arms without filing.",
	},
	{
		id: "h17",
		split: "holdout",
		kind: "ask",
		text: "May I archive the stale referral list?",
		upstream: { project: "proj-growth", confidence: 0.9, actionable: true },
		expectedFiled: "proj-growth",
		note: "An ask files to its project but is never marked actionable.",
	},
	{
		id: "h18",
		split: "holdout",
		kind: "decision",
		text: "Decide the retention policy window",
		upstream: { project: "proj-security", confidence: 0.9, actionable: true },
		expectedFiled: "proj-security",
		note: "A decision files to its project but is never marked actionable.",
	},
	{
		id: "h19",
		split: "holdout",
		kind: "request",
		text: "Note the unresolved import warning",
		session: { projectId: "proj-docs", label: "Import warnings" },
		upstream: { project: "NONE", confidence: 0.5, actionable: false },
		expectedFiled: null,
		note: "Pending suggestion falls back to the source session's project.",
	},
	{
		id: "h20",
		split: "holdout",
		kind: "request",
		text: "Record the miscellaneous admin chore",
		upstream: { project: "NONE", confidence: 0.6, actionable: false },
		expectedFiled: null,
		note: "Pending suggestion falls back to the owner's intake project.",
	},
	{
		id: "h21",
		split: "holdout",
		kind: "request",
		text: "Refactor the billing retry loop",
		upstream: { project: "proj-foreign", confidence: 0.9, actionable: true },
		expectedFiled: null,
		note: "A project id outside the supplied list fails closed on both arms.",
	},
	{
		id: "h22",
		split: "holdout",
		kind: "request",
		text: "Recheck the failing sync",
		upstream: {
			project: "proj-docs",
			confidence: 0.9,
			actionable: true,
			throw: "provider timeout",
		},
		expectedFiled: null,
		note: "A model timeout retains the request unfilled on both arms.",
	},
	{
		id: "h23",
		split: "holdout",
		kind: "request",
		text: "Rate the docs change risk",
		upstream: { project: "proj-docs", confidence: NaN, actionable: true },
		expectedFiled: null,
		note: "A non-finite confidence fails closed on both arms.",
	},
	{
		id: "h24",
		split: "holdout",
		kind: "request",
		text: "Refresh the vendor setup guide",
		extraProjects: 190,
		upstream: {
			project: "proj-tail",
			confidence: 0.9,
			actionable: true,
			baselineProject: "proj-docs",
		},
		expectedFiled: "proj-tail",
		note: "Baseline silently drops tail projects when its prompt overflows and files a confident wrong project; the chooser refuses a window that cannot hold the portfolio.",
	},
	{
		id: "h25",
		split: "holdout",
		kind: "request",
		text: "Refresh the vendor setup guide",
		extraProjects: 200,
		upstream: {
			project: "proj-tail",
			confidence: 0.9,
			actionable: true,
			baselineProject: "proj-docs",
		},
		expectedFiled: "proj-tail",
		note: "At 201+ live projects the chooser errors before any model call; baseline answers from a truncated portfolio.",
	},
];

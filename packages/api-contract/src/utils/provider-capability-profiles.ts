import * as z from "zod";
import type { PersonalResourceToolBinding } from "../schemas/tools";

/**
 * Reviewed provider capability profiles: the only place public source says what
 * a provider tool can reach and which consent or resource limit governs it.
 *
 * A profile is the ceiling. Tenants narrow it with their own stored rules
 * (a connection's allowed resources, a person's consent, an installed tool's
 * argument-path binding); no tenant rule can widen it. Any change to a profile
 * must bump its `version` (the test suite pins a fingerprint per version), so
 * every widening is a reviewed, recorded change. Customer-specific policy never
 * belongs here.
 */
export interface ProviderCapabilityProfileBase {
	id: string;
	version: number;
}

// ---------------------------------------------------------------------------
// Organization connection resource profiles (keyed by allowed-resource type)
// ---------------------------------------------------------------------------

export interface ResourceCapabilityProfile extends ProviderCapabilityProfileBase {
	resourceType: string;
	/** Reviewed tools; any tool missing here fails closed under a resource limit. */
	tools: Readonly<Record<string, z.ZodType>>;
	/** The upstream endpoint must be the official one; omitted means unchecked. */
	endpoint?: (config: unknown) => boolean;
	/** The single provider resource a call targets, or null when unverifiable. */
	target: (toolName: string, args: unknown) => string | null;
	/** Canonical identity of a stored allowed resource for comparison. */
	normalize: (resourceId: string) => string | null;
}

const repositoryPart = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+$/)
	.refine((value) => value !== "." && value !== "..");
const repository = { owner: repositoryPart, repo: repositoryPart };
const githubRepository = z.object(repository).loose();

const GITHUB_REPOSITORY_PROFILE: ResourceCapabilityProfile = {
	id: "github",
	version: 1,
	resourceType: "github_repository",
	tools: {
		issue_write: z
			.object({
				...repository,
				method: z.literal("update"),
				issue_number: z.number().int().positive(),
				title: z.string().optional(),
				body: z.string().optional(),
				state: z.enum(["open", "closed"]).optional(),
				state_reason: z
					.enum(["completed", "not_planned", "reopened"])
					.optional(),
				labels: z.array(z.string()).optional(),
				assignees: z.array(z.string()).optional(),
				milestone: z.number().int().positive().optional(),
				type: z.string().nullable().optional(),
			})
			.strict(),
		create_or_update_file: z
			.object({
				...repository,
				branch: z.string().min(1),
				content: z.string(),
				message: z.string(),
				path: z.string().min(1),
				sha: z.string().optional(),
				allow_symlink_write: z.boolean().optional(),
			})
			.strict(),
		get_file_contents: z
			.object({
				...repository,
				path: z.string().optional(),
				ref: z.string().optional(),
				sha: z.string().optional(),
			})
			.strict(),
	},
	endpoint: (config) => {
		const endpoint = z.object({ mcpServerUrl: z.string() }).safeParse(config);
		try {
			const url = new URL(endpoint.success ? endpoint.data.mcpServerUrl : "");
			return (
				url.origin === "https://api.githubcopilot.com" &&
				/^\/mcp(?:\/[a-zA-Z0-9_-]+)*\/?$/.test(url.pathname) &&
				!url.search &&
				!url.hash &&
				!url.username &&
				!url.password
			);
		} catch {
			return false;
		}
	},
	target: (_toolName, args) => {
		const parsed = githubRepository.safeParse(args);
		return parsed.success
			? `${parsed.data.owner}/${parsed.data.repo}`.toLowerCase()
			: null;
	},
	normalize: (resourceId) => resourceId.toLowerCase(),
};

const notionPageId = (value: string) => {
	if (
		!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
			value,
		)
	)
		return null;
	return value.replaceAll("-", "").toLowerCase();
};
const notionPageRead = z
	.object({
		page_id: z.string(),
		filter_properties: z.array(z.string()).optional(),
	})
	.strict();
const notionPageFetch = z.object({ url: z.string() }).strict();

const NOTION_PAGE_PROFILE: ResourceCapabilityProfile = {
	id: "notion",
	version: 1,
	resourceType: "notion_page",
	tools: {
		"API-retrieve-a-page": notionPageRead,
		"notion-fetch": notionPageFetch,
	},
	target: (toolName, args) => {
		if (toolName === "API-retrieve-a-page") {
			const parsed = notionPageRead.safeParse(args);
			return parsed.success ? notionPageId(parsed.data.page_id) : null;
		}
		const parsed = notionPageFetch.safeParse(args);
		if (!parsed.success) return null;
		let target = notionPageId(parsed.data.url);
		try {
			const url = new URL(parsed.data.url);
			if (
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				!url.port &&
				(url.hostname === "notion.com" ||
					url.hostname.endsWith(".notion.com") ||
					url.hostname === "notion.so" ||
					url.hostname.endsWith(".notion.so") ||
					url.hostname.endsWith(".notion.site"))
			) {
				// A view/block fragment must never turn into authority for a different resource.
				if (!url.hash && !url.search)
					target = notionPageId(url.pathname.slice(1).replace(/\/$/, ""));
			}
		} catch {
			/* Invalid URLs have no verifiable target. */
		}
		return target;
	},
	normalize: notionPageId,
};

const RESOURCE_PROFILES: Readonly<Record<string, ResourceCapabilityProfile>> = {
	[GITHUB_REPOSITORY_PROFILE.resourceType]: GITHUB_REPOSITORY_PROFILE,
	[NOTION_PAGE_PROFILE.resourceType]: NOTION_PAGE_PROFILE,
};

export function resourceCapabilityProfile(
	resourceType: string,
): ResourceCapabilityProfile | undefined {
	return Object.hasOwn(RESOURCE_PROFILES, resourceType)
		? RESOURCE_PROFILES[resourceType]
		: undefined;
}

// ---------------------------------------------------------------------------
// Personal account profiles (keyed by provider id)
// ---------------------------------------------------------------------------

/**
 * How much a person lets a worker do with their connected account, chosen on
 * the account's row in a Workspace: nothing, read, or read and organise.
 * Organising (operation `modify`) labels, archives, marks read and drafts; no
 * reviewed tool sends, trashes, marks spam or deletes.
 */
export const PERSONAL_ORGANISE_OPERATION = "modify";

export interface PersonalAccountCapabilityProfile extends ProviderCapabilityProfileBase {
	/** What people call the account in consent copy ("read my Gmail"). */
	displayName: string;
	/**
	 * Tools that act on the connected account itself and take no resource
	 * argument. A consent can never reach an account tool absent here.
	 */
	accountTools: Readonly<Record<string, PersonalResourceToolBinding>>;
	/** Narrowest OAuth scopes a reviewed read tool needs. */
	readScopes: readonly string[];
	/** Arguments that would turn an allowed tool into a destructive one. */
	forbiddenArguments?: {
		tools: readonly string[];
		keys: readonly string[];
		values: ReadonlySet<string>;
	};
}

const onAccount = (
	resourceType: string,
	operation: string,
): PersonalResourceToolBinding => ({
	operation,
	resourceType,
	target: "account",
});

const GMAIL_PROFILE: PersonalAccountCapabilityProfile = {
	id: "google-gmail",
	version: 1,
	displayName: "Gmail",
	accountTools: {
		...Object.fromEntries(
			["search_threads", "get_thread", "get_message", "list_labels"].map(
				(tool) => [tool, onAccount("mailbox", "read")],
			),
		),
		// Send, trash, spam and delete tools are deliberately absent.
		...Object.fromEntries(
			["label_thread", "unlabel_thread", "create_label", "create_draft"].map(
				(tool) => [tool, onAccount("mailbox", PERSONAL_ORGANISE_OPERATION)],
			),
		),
	},
	readScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
	// Adding Trash or Spam is how a label tool deletes mail, so no delegated
	// call may add them, whatever binding the installed tool carries.
	forbiddenArguments: {
		tools: ["label_thread", "label_message", "update_message_labels"],
		keys: ["labelIds", "addLabelIds"],
		values: new Set(["TRASH", "SPAM"]),
	},
};

const GOOGLE_CALENDAR_PROFILE: PersonalAccountCapabilityProfile = {
	id: "google-calendar",
	version: 1,
	displayName: "Calendar",
	accountTools: { list_events: onAccount("calendar_account", "read") },
	readScopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
};

const PERSONAL_PROFILES: Readonly<
	Record<string, PersonalAccountCapabilityProfile>
> = {
	[GMAIL_PROFILE.id]: GMAIL_PROFILE,
	[GOOGLE_CALENDAR_PROFILE.id]: GOOGLE_CALENDAR_PROFILE,
};

export function personalAccountCapabilityProfile(
	providerId: string,
): PersonalAccountCapabilityProfile | undefined {
	return Object.hasOwn(PERSONAL_PROFILES, providerId)
		? PERSONAL_PROFILES[providerId]
		: undefined;
}

// ---------------------------------------------------------------------------
// Provider-documented scope implications
// ---------------------------------------------------------------------------

export const GOOGLE_CALENDAR_SCOPE_ROOT =
	"https://www.googleapis.com/auth/calendar";
/** Every Google Calendar scope the root scope implies, by exact identity. */
export const GOOGLE_CALENDAR_SCOPE_FAMILY: ReadonlySet<string> = new Set([
	GOOGLE_CALENDAR_SCOPE_ROOT,
	`${GOOGLE_CALENDAR_SCOPE_ROOT}.readonly`,
	`${GOOGLE_CALENDAR_SCOPE_ROOT}.events`,
	`${GOOGLE_CALENDAR_SCOPE_ROOT}.events.readonly`,
	`${GOOGLE_CALENDAR_SCOPE_ROOT}.calendarlist.readonly`,
]);

export interface ScopeImplicationProfile extends ProviderCapabilityProfileBase {
	/** A granted scope (exact identity) and the exact scopes it covers. */
	implications: ReadonlyArray<{
		granted: string;
		covers: readonly string[];
	}>;
}

const microsoftCalendarsRead = [
	"Calendars.Read",
	"https://graph.microsoft.com/Calendars.Read",
];

export const SCOPE_IMPLICATION_PROFILES: readonly ScopeImplicationProfile[] = [
	{
		id: "google-calendar-scopes",
		version: 1,
		implications: [
			{
				granted: GOOGLE_CALENDAR_SCOPE_ROOT,
				covers: [...GOOGLE_CALENDAR_SCOPE_FAMILY],
			},
			{
				granted: `${GOOGLE_CALENDAR_SCOPE_ROOT}.events`,
				covers: [`${GOOGLE_CALENDAR_SCOPE_ROOT}.events.readonly`],
			},
			{
				granted: `${GOOGLE_CALENDAR_SCOPE_ROOT}.readonly`,
				covers: [
					`${GOOGLE_CALENDAR_SCOPE_ROOT}.calendarlist.readonly`,
					`${GOOGLE_CALENDAR_SCOPE_ROOT}.events.readonly`,
				],
			},
		],
	},
	{
		id: "microsoft-graph-calendar-scopes",
		version: 1,
		implications: [
			{ granted: "Calendars.ReadWrite", covers: microsoftCalendarsRead },
			{
				granted: "https://graph.microsoft.com/Calendars.ReadWrite",
				covers: microsoftCalendarsRead,
			},
		],
	},
];

// ---------------------------------------------------------------------------
// Consent scope profiles: which granted scopes satisfy a provider capability
// ---------------------------------------------------------------------------

export interface ConsentScopeProfile extends ProviderCapabilityProfileBase {
	/** Granted scopes, any one of which gives this consent (exact identity). */
	anyOf: readonly string[];
	/** Scopes a delegation requests for this capability, when it requests any. */
	requests?: readonly string[];
}

const CONSENT_SCOPE_PROFILES: Readonly<Record<string, ConsentScopeProfile>> =
	Object.fromEntries(
		(
			[
				{
					// A calendar Workspace attachment needs some Google Calendar scope.
					id: "google-calendar-attach",
					version: 1,
					anyOf: [...GOOGLE_CALENDAR_SCOPE_FAMILY],
				},
				{
					id: "google-calendar-event-read",
					version: 1,
					anyOf: [
						GOOGLE_CALENDAR_SCOPE_ROOT,
						`${GOOGLE_CALENDAR_SCOPE_ROOT}.readonly`,
						`${GOOGLE_CALENDAR_SCOPE_ROOT}.events`,
						`${GOOGLE_CALENDAR_SCOPE_ROOT}.events.readonly`,
					],
				},
				{
					id: "google-calendar-event-write",
					version: 1,
					anyOf: [
						GOOGLE_CALENDAR_SCOPE_ROOT,
						`${GOOGLE_CALENDAR_SCOPE_ROOT}.events`,
					],
					requests: [
						`${GOOGLE_CALENDAR_SCOPE_ROOT}.events`,
						`${GOOGLE_CALENDAR_SCOPE_ROOT}.calendarlist.readonly`,
					],
				},
				{
					id: "microsoft-calendar-read",
					version: 2,
					anyOf: [
						"Calendars.Read",
						"https://graph.microsoft.com/Calendars.Read",
						"Calendars.ReadWrite",
						"https://graph.microsoft.com/Calendars.ReadWrite",
					],
				},
				{
					id: "microsoft-calendar-write",
					version: 2,
					anyOf: [
						"Calendars.ReadWrite",
						"https://graph.microsoft.com/Calendars.ReadWrite",
					],
					requests: ["Calendars.ReadWrite"],
				},
				{
					// Drafting or sending through Gmail needs compose authority.
					id: "google-gmail-compose",
					version: 1,
					anyOf: [
						"https://www.googleapis.com/auth/gmail.compose",
						"https://www.googleapis.com/auth/gmail.modify",
						"https://mail.google.com/",
					],
				},
			] satisfies ConsentScopeProfile[]
		).map((profile) => [profile.id, profile]),
	);

export function consentScopeProfile(id: string): ConsentScopeProfile {
	if (!Object.hasOwn(CONSENT_SCOPE_PROFILES, id))
		throw new Error(`Unknown consent scope profile: ${id}`);
	return CONSENT_SCOPE_PROFILES[id]!;
}

/** The granted scopes that give a reviewed consent; empty means not granted. */
export function scopesGrantingConsent(
	profileId: string,
	granted: readonly string[],
): string[] {
	const profile = consentScopeProfile(profileId);
	return granted.filter((scope) => profile.anyOf.includes(scope));
}

/** Every reviewed profile, for audit listings and the version pin test. */
export const PROVIDER_CAPABILITY_PROFILES: readonly ProviderCapabilityProfileBase[] =
	[
		...Object.values(RESOURCE_PROFILES),
		...Object.values(PERSONAL_PROFILES),
		...SCOPE_IMPLICATION_PROFILES,
		...Object.values(CONSENT_SCOPE_PROFILES),
	];

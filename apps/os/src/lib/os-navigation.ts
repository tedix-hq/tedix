import { navigationDescription, OS_COPY } from "@/shared/os-copy";

export const OS_SURFACE_IDS = [
	"work",
	"chat",
	"workspaces",
	"blueprints",
	"outputs",
	"team",
	"skills",
	"sites",
	"gateways",
	"brain",
	"audit",
	"widget",
	"compute",
	"install",
] as const;

export type OsSurfaceId = (typeof OS_SURFACE_IDS)[number];

export type OsNavigationItem = Readonly<{
	id: OsSurfaceId;
	label: string;
	path: `/${string}` | "/";
	description: string;
}>;

const OS_SURFACES = [
	{
		id: "work",
		get label() {
			return OS_COPY.navigation.work;
		},
		path: "/work",
		get description() {
			return navigationDescription(
				"work",
				"See what needs you and track your tasks.",
			);
		},
	},
	{
		id: "chat",
		get label() {
			return OS_COPY.navigation.chat;
		},
		path: "/chat",
		get description() {
			return navigationDescription(
				"chat",
				"Talk to your tedis and see their replies.",
			);
		},
	},
	{
		id: "workspaces",
		get label() {
			return OS_COPY.navigation.workspaces;
		},
		path: "/workspaces",
		get description() {
			return navigationDescription(
				"workspaces",
				"Keep your work, documents and apps together.",
			);
		},
	},
	{
		id: "blueprints",
		get label() {
			return OS_COPY.navigation.blueprints;
		},
		path: "/blueprints",
		get description() {
			return navigationDescription(
				"blueprints",
				"Reusable starting points for your workspaces.",
			);
		},
	},
	{
		id: "outputs",
		get label() {
			return OS_COPY.navigation.outputs;
		},
		path: "/outputs",
		get description() {
			return navigationDescription(
				"outputs",
				"Find your documents, sheets and presentations.",
			);
		},
	},
	{
		id: "team",
		get label() {
			return OS_COPY.navigation.team;
		},
		path: "/team",
		get description() {
			return navigationDescription(
				"team",
				"Manage the people and tedis on your team.",
			);
		},
	},
	{
		id: "skills",
		get label() {
			return OS_COPY.navigation.skills;
		},
		path: "/skills",
		get description() {
			return navigationDescription(
				"skills",
				"Choose instructions and tasks Tedix can repeat for you.",
			);
		},
	},
	{
		id: "sites",
		get label() {
			return OS_COPY.navigation.sites;
		},
		path: "/sites",
		get description() {
			return navigationDescription("sites", "Create and manage your websites.");
		},
	},
	{
		id: "gateways",
		get label() {
			return OS_COPY.navigation.gateways;
		},
		path: "/apps",
		get description() {
			return navigationDescription(
				"gateways",
				"Apps and tools Tedix can use for you.",
			);
		},
	},
	{
		id: "brain",
		get label() {
			return OS_COPY.navigation.brain;
		},
		path: "/brain",
		get description() {
			return navigationDescription(
				"brain",
				"Review what Tedix remembers and learns.",
			);
		},
	},
	{
		id: "audit",
		get label() {
			return OS_COPY.navigation.audit;
		},
		path: "/audit",
		get description() {
			return navigationDescription(
				"audit",
				"See what happened and who made each change.",
			);
		},
	},
	{
		id: "widget",
		get label() {
			return OS_COPY.navigation.widget;
		},
		path: "/widget",
		get description() {
			return navigationDescription(
				"widget",
				"Add a chat assistant to your website.",
			);
		},
	},
	{
		id: "compute",
		get label() {
			return OS_COPY.navigation.usage;
		},
		path: "/compute",
		get description() {
			return navigationDescription(
				"compute",
				"Check your usage, spending and plan.",
			);
		},
	},
	{
		id: "install",
		get label() {
			return OS_COPY.navigation.install;
		},
		path: "/install",
		get description() {
			return navigationDescription(
				"install",
				"Connect Tedix to the apps you use.",
			);
		},
	},
] as const satisfies readonly OsNavigationItem[];

export type OsPage = Readonly<{
	id: string;
	path: `/${string}`;
	label: string;
	parentId?: string;
	palette?: true;
	settings?: true;
	description?: string;
	surfaceId?: OsSurfaceId;
	titleKey?: "output" | "skill" | "app" | "workspace";
	// Existing resource tabs, Work views and tedi tabs keep their parent crumb.
	breadcrumb?: "parent" | "section";
}>;

export const OS_PAGES: readonly OsPage[] = [
	...OS_SURFACES.map((surface): OsPage => ({
		id: surface.id,
		path: surface.path,
		get label() {
			return surface.label;
		},
		get description() {
			return surface.description;
		},
		surfaceId: surface.id,
		palette: true,
		...(["blueprints", "widget", "audit", "compute"].includes(surface.id)
			? { parentId: "admin", settings: true as const }
			: {}),
	})),
	{
		id: "admin",
		path: "/admin",
		get label() {
			return OS_COPY.navigation.settings;
		},
		palette: true,
		settings: true,
		description: "Manage your organization, access and billing.",
	},
	{
		id: "admin-billing",
		path: "/admin/billing",
		get label() {
			return OS_COPY.navigation.billing;
		},
		parentId: "admin",
		palette: true,
		settings: true,
	},
	{
		id: "admin-organization",
		path: "/admin/organization",
		label: "Organization",
		parentId: "admin",
		palette: true,
		settings: true,
	},
	{
		id: "admin-connections",
		path: "/admin/connections",
		label: "Connections",
		parentId: "admin",
		palette: true,
		settings: true,
	},
	{
		id: "admin-api-keys",
		path: "/admin/api-keys",
		label: "API keys",
		parentId: "admin",
		palette: true,
		settings: true,
	},
	{
		id: "admin-payments",
		path: "/admin/payments",
		label: "Payments",
		parentId: "admin",
		palette: true,
		settings: true,
	},
	{ id: "account", path: "/account", label: "Account", breadcrumb: "section" },
	{
		id: "account-settings",
		path: "/account/settings",
		get label() {
			return OS_COPY.navigation.personalSettings;
		},
		parentId: "account",
		palette: true,
		settings: true,
		description: "Choose your appearance and personal preferences.",
	},
	{
		id: "account-connections",
		path: "/account/connections",
		label: "Connected applications",
		parentId: "account",
		palette: true,
		settings: true,
	},
	{
		id: "account-profile",
		path: "/account/profile",
		label: "Profile",
		parentId: "account",
		palette: true,
		settings: true,
	},
	{
		id: "account-authorizations",
		path: "/account/authorizations",
		label: "Authorizations",
		parentId: "account",
		palette: true,
		settings: true,
	},
	{
		id: "account-organizations",
		path: "/account/organizations",
		label: "Organizations",
		parentId: "account",
		palette: true,
	},
	{
		id: "account-onboarding",
		path: "/account/onboarding",
		label: "Onboarding",
		parentId: "account",
	},
	{
		id: "tedi",
		path: "/team/$tediId",
		label: "Tedi",
		parentId: "team",
		breadcrumb: "parent",
	},
	{
		id: "team-new",
		path: "/team/new",
		label: "New tedi",
		parentId: "team",
		palette: true,
		breadcrumb: "parent",
	},
	{
		id: "tedi-authority",
		path: "/team/$tediId/authority",
		label: "Authority",
		parentId: "tedi",
		palette: true,
		breadcrumb: "parent",
	},
	{
		id: "tedi-learning",
		path: "/team/$tediId/learning",
		label: "Learning",
		parentId: "tedi",
		palette: true,
		breadcrumb: "parent",
	},
	{
		id: "tedi-mailbox",
		path: "/team/$tediId/mailbox",
		label: "Mailbox",
		parentId: "tedi",
		palette: true,
		breadcrumb: "parent",
	},
	{
		id: "tedi-memory",
		path: "/team/$tediId/memory",
		label: "Memory",
		parentId: "tedi",
		palette: true,
		breadcrumb: "parent",
	},
	{
		id: "tedi-settings",
		path: "/team/$tediId/settings",
		label: "Settings",
		parentId: "tedi",
		palette: true,
		breadcrumb: "parent",
	},
	{
		id: "tedi-telemetry",
		path: "/team/$tediId/telemetry",
		label: "Telemetry",
		parentId: "tedi",
		palette: true,
		breadcrumb: "parent",
	},
	{
		id: "output",
		path: "/outputs/$outputId",
		label: "Document",
		parentId: "outputs",
		titleKey: "output",
	},
	{
		id: "skill",
		path: "/skills/$skillId",
		label: "Skill",
		parentId: "skills",
		titleKey: "skill",
	},
	{
		// Former gateway list; the route redirects to Apps (the surface above).
		id: "gateways-redirect",
		path: "/gateways",
		get label() {
			return OS_COPY.navigation.gateways;
		},
	},
	{
		id: "app",
		path: "/apps/$appId",
		label: "App",
		parentId: "gateways",
		titleKey: "app",
	},
	{
		id: "workspace",
		path: "/workspace/$workspaceId",
		label: "Workspace",
		parentId: "workspaces",
		titleKey: "workspace",
	},
	{
		id: "explore-apps",
		path: "/explore/apps",
		label: "Explore apps",
		palette: true,
	},
	{
		id: "explore-app",
		path: "/explore/apps/$slug",
		label: "App",
		parentId: "explore-apps",
	},
	{
		id: "home",
		path: "/",
		get label() {
			return OS_COPY.navigation.work;
		},
	},
	{ id: "shared", path: "/shared", label: "Shared" },
	{
		id: "shared-workspace",
		path: "/shared/workspace/$workspaceId",
		label: "Shared workspace",
	},
	{ id: "login", path: "/login", label: "Sign in" },
	{ id: "invite", path: "/invite", label: "Invitation" },
	{ id: "cli-login", path: "/cli/login", label: "CLI sign in" },
	{
		id: "oauth-consent",
		path: "/oauth/consent",
		label: "Authorize application",
	},
	{ id: "oauth-callback", path: "/oauth/callback", label: "Authorization" },
	{
		id: "app-analytics",
		path: "/apps/$appId/analytics",
		label: "Analytics",
		parentId: "app",
		breadcrumb: "parent",
	},
	{
		id: "app-content",
		path: "/apps/$appId/content",
		label: "Content",
		parentId: "app",
		breadcrumb: "parent",
	},
	{
		id: "app-settings",
		path: "/apps/$appId/settings",
		label: "Settings",
		parentId: "app",
		breadcrumb: "parent",
	},
	{
		id: "app-tools",
		path: "/apps/$appId/tools",
		label: "Tools",
		parentId: "app",
		breadcrumb: "parent",
	},
	{
		id: "skill-runs",
		path: "/skills/$skillId/runs",
		label: "Runs",
		parentId: "skill",
		breadcrumb: "parent",
	},
	{
		id: "skill-schedule",
		path: "/skills/$skillId/schedule",
		label: "Schedule",
		parentId: "skill",
		breadcrumb: "parent",
	},
	{
		id: "skill-versions",
		path: "/skills/$skillId/versions",
		label: "Versions",
		parentId: "skill",
		breadcrumb: "parent",
	},
	{
		id: "work-admission",
		path: "/work/admission",
		label: "Admission",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-approvals",
		path: "/work/approvals",
		label: "Approvals",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-attempts",
		path: "/work/attempts",
		label: "Attempts",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-attention",
		path: "/work/attention",
		label: "Attention",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-capacity",
		path: "/work/capacity",
		label: "Capacity",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-cases",
		path: "/work/cases",
		label: "Cases",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-clusters",
		path: "/work/clusters",
		label: "Clusters",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-control",
		path: "/work/control",
		label: "Control",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-graph",
		path: "/work/graph",
		label: "Graph",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-interactions",
		path: "/work/interactions",
		label: "Interactions",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-needs-you",
		path: "/work/needs-you",
		label: "Needs You",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-portfolio",
		path: "/work/portfolio",
		label: "Portfolio",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-queue",
		path: "/work/queue",
		label: "Queue",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-recovery",
		path: "/work/recovery",
		label: "Recovery",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-cases-detail",
		path: "/work/cases/$caseId",
		label: "Cases",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-executions-detail",
		path: "/work/executions/$runId",
		label: "Executions",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-interactions-detail",
		path: "/work/interactions/$requestId",
		label: "Interactions",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-items-detail",
		path: "/work/items/$workItemId",
		label: "Items",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-projects-detail",
		path: "/work/projects/$projectId",
		label: "Projects",
		parentId: "work",
		breadcrumb: "parent",
	},
	{
		id: "work-runs-detail",
		path: "/work/runs/$runId",
		label: "Runs",
		parentId: "work",
		breadcrumb: "parent",
	},
];

export const OS_NAVIGATION: readonly OsNavigationItem[] = OS_PAGES.filter(
	(page): page is OsPage & OsNavigationItem => page.surfaceId !== undefined,
);

export function getOsSurface(id: OsSurfaceId): OsNavigationItem {
	const surface = OS_NAVIGATION.find((item) => item.id === id);
	if (!surface) throw new Error(`Unknown Tedix OS surface: ${id}`);
	return surface;
}

export const OS_SETTINGS_NAVIGATION = [
	getOsSurface("blueprints"),
	getOsSurface("widget"),
	getOsSurface("audit"),
	getOsSurface("compute"),
] as const;

export function osPageParents(page: OsPage): OsPage[] {
	const parent = OS_PAGES.find((candidate) => candidate.id === page.parentId);
	return parent ? [...osPageParents(parent), page] : [page];
}

export function matchOsPage(pathname: string):
	| {
			page: OsPage;
			params: Record<string, string>;
	  }
	| undefined {
	const segments = pathname.replace(/\/$/, "").split("/");
	const matches = OS_PAGES.flatMap((page) => {
		const pattern = page.path.replace(/\/$/, "").split("/");
		if (pattern.length !== segments.length) return [];
		const params: Record<string, string> = {};
		for (const [index, part] of pattern.entries()) {
			if (part.startsWith("$")) {
				if (!segments[index]) return [];
				params[part.slice(1)] = segments[index]!;
			} else if (part !== segments[index]) return [];
		}
		return [
			{
				page,
				params,
				specificity: pattern.filter((part) => !part.startsWith("$")).length,
			},
		];
	});
	return matches.sort((a, b) => b.specificity - a.specificity)[0];
}

export function osPagePath(
	page: OsPage,
	params: Record<string, string>,
): string | undefined {
	const missing = page.path
		.split("/")
		.some((part) => part.startsWith("$") && !params[part.slice(1)]);
	if (missing) return undefined;
	return page.path.replace(/\$([^/]+)/g, (_, key: string) => params[key]!);
}

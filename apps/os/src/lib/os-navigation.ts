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

export const OS_NAVIGATION = [
	{
		id: "work",
		label: "Work",
		path: "/work",
		description:
			"Portfolio, queues, attempts, approvals, evidence, and recovery",
	},
	{
		id: "chat",
		label: "Chat",
		path: "/chat",
		description: "Talk to your tedis; every run is governed and recorded",
	},
	{
		id: "workspaces",
		label: "Workspaces",
		path: "/workspaces",
		description: "Workspaces, Gadgets, layouts, and previews",
	},
	{
		id: "blueprints",
		label: "Blueprints",
		path: "/blueprints",
		description: "Versioned templates for governed workspaces",
	},
	{
		id: "outputs",
		label: "Outputs",
		path: "/outputs",
		description: "Documents, sheets, presentations, and artifacts",
	},
	{
		id: "team",
		label: "Team",
		path: "/team",
		description: "Tedis, people, delegation, and authority",
	},
	{
		id: "skills",
		label: "Skills",
		path: "/skills",
		description: "Instructions, automations, flows, and schedules",
	},
	{
		id: "sites",
		label: "Sites",
		path: "/sites",
		description: "CMS websites and documentation sites",
	},
	{
		id: "gateways",
		label: "MCP Gateway",
		path: "/gateways",
		description:
			"Your organization's MCP entry point and the apps it is filled from",
	},
	{
		id: "brain",
		label: "Brain",
		path: "/brain",
		description: "Memory, rationale, and bounded context",
	},
	{
		id: "audit",
		label: "Audit",
		path: "/audit",
		description: "Identity, policy, costs, receipts, and traces",
	},
	{
		id: "widget",
		label: "Widget",
		path: "/widget",
		description:
			"Embedded assistant tenants, experience, usage, and governance",
	},
	{
		id: "compute",
		label: "Usage & budgets",
		path: "/compute",
		description: "Spend, budgets, models, and where every number came from",
	},
	{
		id: "install",
		label: "Install Tedix",
		path: "/install",
		description: "Set up the CLI, Codex, ChatGPT Work, and Claude Code",
	},
] as const satisfies readonly OsNavigationItem[];

export function getOsSurface(id: OsSurfaceId): OsNavigationItem {
	const surface = OS_NAVIGATION.find((item) => item.id === id);
	if (!surface) throw new Error(`Unknown Tedix OS surface: ${id}`);
	return surface;
}

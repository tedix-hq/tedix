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

export const OS_NAVIGATION = [
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
		path: "/gateways",
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
			return OS_COPY.navigation.compute;
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

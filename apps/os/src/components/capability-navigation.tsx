import { getOsSurface } from "@/lib/os-navigation";
import { useOsLocale } from "@/lib/use-os-locale";
import { Link } from "@tanstack/react-router";
import { KumoTabs } from "@/components/kumo/tabs";

/**
 * The connections area has three tabs. Apps covers the apps in use and the
 * catalog to add more; Accounts covers every account those apps use, the
 * organization's and your own. The gateway is how all apps are reached, so it
 * is a line on Apps, not a tab.
 */
export const CAPABILITY_NAV_ITEMS = [
	{ id: "apps", label: "Apps", to: "/apps" },
	{ id: "accounts", label: "Accounts", to: "/admin/connections" },
	{
		id: "skills",
		get label() {
			return getOsSurface("skills").label;
		},
		to: "/skills",
	},
] as const;

/** Views inside a tab: each keeps its existing route. */
export const CAPABILITY_SUB_NAV_ITEMS = {
	apps: [
		{ id: "installed", label: "In use", to: "/apps" },
		{ id: "browse", label: "Browse and add", to: "/explore/apps" },
	],
	accounts: [
		{ id: "organization", label: "Organization", to: "/admin/connections" },
		{ id: "personal", label: "Only you", to: "/account/connections" },
	],
} as const;

export type CapabilityView =
	| "installed"
	| "browse"
	| "skills"
	| "organization"
	| "personal";

export function capabilityTab(
	view: CapabilityView,
): (typeof CAPABILITY_NAV_ITEMS)[number]["id"] {
	if (view === "installed" || view === "browse") return "apps";
	if (view === "organization" || view === "personal") return "accounts";
	return "skills";
}

/** Navigation between distinct inventories; installation never implies a credential. */
export function CapabilityNavigation({ active }: { active: CapabilityView }) {
	const tab = capabilityTab(active);
	const views = tab === "skills" ? [] : CAPABILITY_SUB_NAV_ITEMS[tab];
	useOsLocale();
	return (
		<div className="grid min-w-0 gap-3">
			<div data-capability-nav="" className="min-w-0">
				<KumoTabs
					aria-label="Apps, accounts and skills"
					variant="underline"
					value={tab}
					tabs={CAPABILITY_NAV_ITEMS.map((item) => ({
						value: item.id,
						label: item.label,
						nativeButton: false,
						render: (
							<Link
								to={item.to}
								preload="intent"
								aria-current={tab === item.id ? "page" : undefined}
							/>
						),
					}))}
				/>
			</div>
			{views.length > 0 ? (
				<div data-capability-subnav="" className="min-w-0">
					<KumoTabs
						aria-label={tab === "apps" ? "Apps views" : "Account owners"}
						size="sm"
						className="w-fit"
						value={active}
						tabs={views.map((view) => ({
							value: view.id,
							label: view.label,
							nativeButton: false,
							render:
								view.id === "browse" ? (
									<Link
										to={view.to}
										search={{ offset: 0 }}
										preload="intent"
										aria-current={active === view.id ? "page" : undefined}
									/>
								) : (
									<Link
										to={view.to}
										preload="intent"
										aria-current={active === view.id ? "page" : undefined}
									/>
								),
						}))}
					/>
				</div>
			) : null}
		</div>
	);
}

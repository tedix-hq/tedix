import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "@/components/kumo/link";
import { canAccessAdminSection } from "@/components/admin-layout";
import { OS_SETTINGS_NAVIGATION } from "@/lib/os-navigation";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { OS_COPY } from "@/shared/os-copy";

/** Settings share their existing routes so saved links and read permissions survive. */
export function OsSettingsFrame({
	pathname,
	children,
}: {
	pathname: string;
	children: ReactNode;
}) {
	const context = useOsOperationalContext();
	const navigation = useRef<HTMLElement>(null);
	useEffect(() => {
		navigation.current
			?.querySelector<HTMLElement>("[data-settings-active]")
			?.parentElement?.scrollIntoView({ block: "nearest", inline: "end" });
	}, [pathname]);
	const isAdmin = context.data?.authority
		? canAccessAdminSection(context.data.authority)
		: false;
	const isSettings =
		pathname === "/admin" ||
		pathname.startsWith("/admin/") ||
		OS_SETTINGS_NAVIGATION.some((item) => item.path === pathname);
	if (!isSettings) return children;
	const usageActive = pathname === "/compute" || pathname === "/admin/billing";
	const canManageBilling =
		context.data?.authority.permissions.includes("billing:manage") ?? false;
	const items = [
		...(isAdmin
			? [
					{ path: "/admin", label: OS_COPY.navigation.settings },
					{ path: "/admin/organization", label: "Organization" },
					{ path: "/admin/connections", label: "Connected accounts" },
					{ path: "/admin/api-keys", label: "API keys" },
				]
			: []),
		...OS_SETTINGS_NAVIGATION,
		...(canManageBilling
			? [{ path: "/admin/payments", label: "Payments" }]
			: []),
	];
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
			<nav
				ref={navigation}
				aria-label="Settings sections"
				className="flex shrink-0 gap-1 overflow-x-auto border-b border-kumo-line bg-kumo-base p-2 md:w-48 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r"
			>
				{items.map((item) => (
					<div key={item.path} className="flex shrink-0 flex-col">
						<Link
							href={item.path}
							data-settings-active={
								pathname === item.path ||
								(item.path === "/compute" && usageActive)
									? ""
									: undefined
							}
							variant="navigation"
							aria-current={
								pathname === item.path ||
								(item.path === "/compute" && usageActive)
									? "page"
									: undefined
							}
							className="justify-start whitespace-nowrap"
						>
							{item.label}
						</Link>
						{item.path === "/compute" && usageActive ? (
							<div className="flex gap-1 pl-3 md:flex-col">
								<Link
									href="/compute"
									variant="navigation"
									aria-current={pathname === "/compute" ? "page" : undefined}
									className="justify-start"
								>
									{OS_COPY.navigation.usage}
								</Link>
								{canManageBilling ? (
									<Link
										href="/admin/billing"
										variant="navigation"
										aria-current={
											pathname === "/admin/billing" ? "page" : undefined
										}
										className="justify-start"
									>
										{OS_COPY.navigation.billing}
									</Link>
								) : null}
							</div>
						) : null}
					</div>
				))}
			</nav>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
				{children}
			</div>
		</div>
	);
}

import {
	Coins,
	GearSix,
	SidebarSimple,
	SignOut,
	UserCircle,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarTrigger,
	useSidebar,
} from "@/components/kumo/sidebar";
import { formatUsageCredits } from "@/lib/billing-credit-display";
import { hasUnlimitedTokenUsage } from "@/lib/billing-display";
import { isLocalSession } from "@/lib/local-inference";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import type { OsIdentity } from "@/lib/use-os-identity";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { buildAccountProfileUrl } from "@/shared/account-profile-routing";
import { OS_LOGOUT_PATH } from "@/shared/session-status";

export function OsAccountMenu({ identity }: { identity: OsIdentity }) {
	const { state } = useSidebar();
	const context = useOsOperationalContext();
	const canManageBilling =
		!isLocalSession() &&
		(context.data?.authority.permissions.includes("billing:manage") ?? false);
	const overview = useQuery({
		...billingOverviewQueryOptions(),
		enabled: canManageBilling,
		staleTime: 30_000,
		refetchInterval: canManageBilling ? 60_000 : false,
	});
	const balance = canManageBilling ? overview.data : undefined;
	const remaining = balance
		? balance.credits?.billingMode === "monetary"
			? `${formatUsageCredits(balance.credits.availableMicros, balance.credits.creditValueMicros)} left`
			: hasUnlimitedTokenUsage(balance.snapshot, balance.plan)
				? "Unlimited tokens"
				: `${balance.snapshot.remainingIncludedTokens.toLocaleString()} tokens left`
		: null;
	const UsageIcon = SURFACE_ICONS.compute;
	const avatar = (
		<Avatar className="size-5 shrink-0">
			{identity.avatarUrl ? (
				<AvatarImage src={identity.avatarUrl} alt="" />
			) : null}
			<AvatarFallback className="font-semibold uppercase">
				{identity.name[0] || "T"}
			</AvatarFallback>
		</Avatar>
	);

	return (
		<SidebarMenu aria-label="Account" className="w-full">
			<SidebarMenuItem className="relative flex flex-col gap-1">
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<SidebarMenuButton
								aria-label="Account menu"
								tooltip="Account"
								className="pr-14 font-medium! data-[popup-open]:bg-kumo-tint"
								icon={
									<span className="flex size-4 shrink-0 items-center justify-center">
										{avatar}
									</span>
								}
							>
								{identity.name}
							</SidebarMenuButton>
						}
					/>
					<DropdownMenuContent
						side="top"
						align="start"
						collisionPadding={8}
						className="w-(--anchor-width) min-w-60 max-w-[calc(100vw-1rem)] p-0 outline-none! [&_[role=menuitem]]:px-3 [&_[role=menuitem]>svg]:mr-0 [&_[role=menuitem]>svg]:size-4"
					>
						<DropdownMenuGroup>
							<DropdownMenuLabel className="flex items-center gap-2 px-3 py-2">
								<span className="flex size-4 shrink-0 items-center justify-center">
									{avatar}
								</span>
								<div className="min-w-0">
									<div className="truncate text-kumo-default type-tedix-label">
										{identity.name}
									</div>
									<div className="truncate text-kumo-subtle type-tedix-caption font-normal">
										{identity.email}
									</div>
								</div>
							</DropdownMenuLabel>
							<DropdownMenuLinkItem
								closeOnClick
								href="/compute"
								icon={
									<span className="flex size-4 shrink-0 items-center justify-center">
										<UsageIcon size={16} />
									</span>
								}
							>
								Usage
								{remaining ? (
									<span className="ml-auto text-kumo-subtle type-tedix-caption">
										{remaining}
									</span>
								) : null}
							</DropdownMenuLinkItem>
							{canManageBilling ? (
								<DropdownMenuLinkItem
									closeOnClick
									href="/admin/billing"
									icon={Coins}
								>
									Billing
								</DropdownMenuLinkItem>
							) : null}
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLinkItem closeOnClick href="/admin" icon={GearSix}>
								Organization settings
							</DropdownMenuLinkItem>
							<DropdownMenuLinkItem
								closeOnClick
								href="/account/settings"
								icon={UserCircle}
							>
								Personal settings
							</DropdownMenuLinkItem>
							<DropdownMenuLinkItem
								closeOnClick
								href={buildAccountProfileUrl(new URL(window.location.href))}
								icon={UserCircle}
							>
								Profile
							</DropdownMenuLinkItem>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuLinkItem
							closeOnClick
							href={OS_LOGOUT_PATH}
							icon={SignOut}
						>
							Sign out
						</DropdownMenuLinkItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<SidebarTrigger
					aria-label={
						state === "collapsed" ? "Expand sidebar" : "Collapse sidebar"
					}
					title={state === "collapsed" ? "Expand sidebar" : "Collapse sidebar"}
					className="absolute top-0 right-0 size-11 shrink-0 group-data-[state=collapsed]/sidebar:static group-data-[state=collapsed]/sidebar:self-center"
				>
					<SidebarSimple size={15} />
				</SidebarTrigger>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

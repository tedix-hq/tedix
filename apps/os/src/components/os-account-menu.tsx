import { Coins, GearSix, SignOut, UserCircle } from "@phosphor-icons/react";
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
import { useSidebar } from "@/components/kumo/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
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
		<Avatar size="sm" className="size-7 shrink-0">
			{identity.avatarUrl ? (
				<AvatarImage src={identity.avatarUrl} alt="" />
			) : null}
			<AvatarFallback className="font-semibold uppercase">
				{identity.name[0] || "T"}
			</AvatarFallback>
		</Avatar>
	);

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger
					render={
						<DropdownMenuTrigger
							aria-label="Account menu"
							className="group/user-chip flex min-w-0 items-center gap-2 self-stretch rounded-lg text-left text-kumo-subtle type-tedix-label transition-colors hover:text-kumo-default max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11 group-data-[state=collapsed]/sidebar:self-auto"
						/>
					}
				>
					{avatar}
					<span className="max-w-[116px] truncate group-data-[state=collapsed]/sidebar:hidden">
						{identity.name}
					</span>
					<UserCircle
						className="shrink-0 opacity-0 transition-opacity group-hover/user-chip:opacity-100 group-focus-visible/user-chip:opacity-100 group-data-[state=collapsed]/sidebar:hidden"
						size={13}
					/>
				</TooltipTrigger>
				{state === "collapsed" ? (
					<TooltipContent side="right">Account</TooltipContent>
				) : null}
			</Tooltip>
			<DropdownMenuContent
				side={state === "collapsed" ? "right" : "top"}
				align={state === "collapsed" ? "end" : "start"}
				collisionPadding={8}
				className="w-[calc(var(--sidebar-width,260px)-2rem)] max-w-[calc(100vw-1rem)] outline-none!"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel className="flex items-center gap-2 px-2 py-2">
						{avatar}
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
							<span className="mr-2 flex size-4 shrink-0 items-center justify-center">
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
				<DropdownMenuLinkItem closeOnClick href={OS_LOGOUT_PATH} icon={SignOut}>
					Sign out
				</DropdownMenuLinkItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

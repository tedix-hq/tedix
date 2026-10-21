import { useRef } from "react";
import { DotsThree, type Icon } from "@phosphor-icons/react";
import { Button } from "./kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./kumo/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./kumo/tooltip";

export type FocusRowAction = {
	label: string;
	Icon: Icon;
	onClick: (trigger: HTMLButtonElement) => void;
	disabled?: boolean;
	expanded?: boolean;
	controls?: string;
};

export function FocusRowActions({ actions }: { actions: FocusRowAction[] }) {
	const menuTrigger = useRef<HTMLButtonElement>(null);
	return (
		<div className="focus-row-tools">
			<div className="focus-actions">
				{actions.map(
					({ label, Icon, onClick, disabled, expanded, controls }) => (
						<Tooltip key={label}>
							<TooltipTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={label}
										disabled={disabled}
										aria-expanded={expanded}
										aria-controls={controls}
										onClick={(event) => onClick(event.currentTarget)}
									/>
								}
							>
								<Icon size={16} aria-hidden />
							</TooltipTrigger>
							<TooltipContent>{label}</TooltipContent>
						</Tooltip>
					),
				)}
			</div>
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger
						render={
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="More actions"
										ref={menuTrigger}
									/>
								}
							/>
						}
					>
						<DotsThree size={20} aria-hidden />
					</TooltipTrigger>
					<TooltipContent>More actions</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end">
					{actions.map(
						({ label, Icon, onClick, disabled, expanded, controls }) => (
							<DropdownMenuItem
								key={label}
								icon={Icon}
								disabled={disabled}
								aria-expanded={expanded}
								aria-controls={controls}
								selected={expanded}
								onClick={() => {
									if (menuTrigger.current) onClick(menuTrigger.current);
								}}
							>
								{label}
							</DropdownMenuItem>
						),
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

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
	onClick: () => void;
	disabled?: boolean;
	expanded?: boolean;
};

export function FocusRowActions({ actions }: { actions: FocusRowAction[] }) {
	return (
		<div className="focus-row-tools">
			<div className="focus-actions">
				{actions.map(({ label, Icon, onClick, disabled, expanded }) => (
					<Tooltip key={label}>
						<TooltipTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={label}
									disabled={disabled}
									aria-expanded={expanded}
									onClick={onClick}
								/>
							}
						>
							<Icon size={16} aria-hidden />
						</TooltipTrigger>
						<TooltipContent>{label}</TooltipContent>
					</Tooltip>
				))}
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
					{actions.map(({ label, Icon, onClick, disabled }) => (
						<DropdownMenuItem
							key={label}
							icon={Icon}
							disabled={disabled}
							onClick={onClick}
						>
							{label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

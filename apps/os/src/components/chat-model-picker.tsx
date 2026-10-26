import { Check } from "@phosphor-icons/react";
import { Button } from "@/components/kumo/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";

type PickerModel = { ref: string; label: string };

/**
 * The composer's model button always names what will answer. With nothing
 * to choose from it reads "Auto" and opens nothing: the organization picks.
 */
export function ChatModelPicker({
	models,
	choices,
	selectedRef,
	onSelect,
}: {
	/** Every allowed model, so a kept but superseded choice still has a name. */
	models: readonly PickerModel[];
	/** The models a new selection may pick. */
	choices: readonly PickerModel[];
	selectedRef: string | null;
	onSelect: (ref: string) => void;
}) {
	const label =
		models.find((model) => model.ref === selectedRef)?.label ?? "Auto";
	if (choices.length === 0) {
		return (
			<Button
				type="button"
				size="sm"
				variant="ghost"
				className="chat-composer-picker"
				disabled
				aria-label={`Model: ${label}`}
				title="Your organization picks the model"
			>
				<span className="truncate">{label}</span>
			</Button>
		);
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="chat-composer-picker"
						aria-label={`Model: ${label}`}
					>
						<span className="truncate">{label}</span>
					</Button>
				}
			/>
			<DropdownMenuContent>
				{choices.map((model) => {
					const selected = model.ref === selectedRef;
					return (
						<DropdownMenuItem
							key={model.ref}
							aria-current={selected || undefined}
							onClick={() => onSelect(model.ref)}
						>
							{selected ? (
								<Check size={16} aria-hidden="true" />
							) : (
								<span className="size-4 shrink-0" aria-hidden="true" />
							)}
							{model.label}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

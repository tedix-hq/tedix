import {
	APPROVAL_MODES,
	type ApprovalMode,
} from "@tedix/api-contract/schemas/workspace-agent-access";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import type { ApprovalModeState } from "@/lib/workspace-chat-protocol";

/** What each approval mode is called and does, in the words the picker uses. */
export const APPROVAL_MODE_TEXT: Record<
	ApprovalMode,
	{ label: string; description: string }
> = {
	read_only: {
		label: "Read only",
		description:
			"The agent only reads. Anything that would change something is refused.",
	},
	ask_every_time: {
		label: "Ask every time",
		description:
			"Asks before changes, commands and reading a new web site. Edits to this workspace's files apply at once and can be undone.",
	},
	ask_for_changes: {
		label: "Ask for changes",
		description:
			"Reading runs without asking, new web sites included. Changes and commands ask first.",
	},
	auto: {
		label: "Auto",
		description:
			"The agent decides. It still asks before messages to outside people, money, deleting data and steps only a person may take.",
	},
};

/**
 * How often the agent asks this person before acting in this workspace.
 * Modes looser than the workspace allows are shown disabled with the reason;
 * the store remembers the pick for this person and applies the same cap.
 */
export function ApprovalModePicker({
	state,
	onChange,
	disabled,
}: {
	state: ApprovalModeState;
	onChange: (mode: ApprovalMode) => void;
	disabled?: boolean;
}) {
	const highest = APPROVAL_MODES.indexOf(state.highest);
	return (
		<Select
			value={state.mode}
			onValueChange={(mode) => onChange(mode as ApprovalMode)}
			disabled={disabled}
		>
			<SelectTrigger
				aria-label="Approval mode"
				className="workspace-chat-meta-button"
				size="sm"
				title={APPROVAL_MODE_TEXT[state.mode].description}
			>
				<SelectValue>{APPROVAL_MODE_TEXT[state.mode].label}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{APPROVAL_MODES.map((mode, index) => {
					const capped = index > highest;
					return (
						<SelectItem
							key={mode}
							value={mode}
							disabled={capped}
							title={APPROVAL_MODE_TEXT[mode].description}
						>
							<span className="grid">
								<span>{APPROVAL_MODE_TEXT[mode].label}</span>
								{capped ? (
									<span className="text-kumo-subtle type-tedix-caption">
										This workspace allows up to{" "}
										{APPROVAL_MODE_TEXT[state.highest].label}
									</span>
								) : null}
							</span>
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}

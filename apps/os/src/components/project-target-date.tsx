import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarBlankIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { DatePicker } from "@/components/kumo/date-picker";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";
import { osQueryKeys } from "@/lib/os-query-options";
import {
	projectTargetDay,
	projectTargetLabel,
	projectTargetValue,
} from "@/lib/project-target-date";

/**
 * Sets, changes or removes a project's target date. Shown as the date itself
 * when one is set, and as a quiet "Set target date" action when not.
 */
export function ProjectTargetDate({
	projectId,
	targetDate,
}: {
	projectId: string;
	targetDate: string | null;
}) {
	useOsFormattingPreferences();
	const client = useQueryClient();
	const [open, setOpen] = useState(false);
	const label = projectTargetLabel(targetDate);
	const save = useMutation({
		mutationFn: (next: string | null) =>
			osApi.projects.update({ id: projectId, targetDate: next }),
		onSuccess: async () => {
			setOpen(false);
			await client.invalidateQueries({ queryKey: osQueryKeys.projects() });
		},
	});
	const selected = projectTargetDay(targetDate);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						variant={label ? "ghost" : "outline"}
						size="sm"
						className={label ? "-ml-2 font-medium" : undefined}
					/>
				}
				aria-label={label ? `Target date ${label}, change` : "Set target date"}
				data-project-target={targetDate ?? ""}
			>
				<CalendarBlankIcon aria-hidden size={14} />
				{label ?? "Set target date"}
			</PopoverTrigger>
			<PopoverContent align="start" className="grid w-auto gap-2 p-2">
				<DatePicker
					mode="single"
					selected={selected}
					defaultMonth={selected}
					onChange={(day: Date | undefined) => {
						if (day) save.mutate(projectTargetValue(day));
					}}
				/>
				{targetDate ? (
					<Button
						variant="ghost"
						size="sm"
						disabled={save.isPending}
						onClick={() => save.mutate(null)}
					>
						Remove target date
					</Button>
				) : null}
				{save.isError ? (
					<Text as="p" role="label" tone="error" className="m-0 max-w-64">
						{errorMessage(save.error, "The date could not be saved.")}
					</Text>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

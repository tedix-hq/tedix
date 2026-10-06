import type { EmbeddedTediSelectionPolicy } from "@tedix/api-contract/schemas/embedded-widget-access";
import { Checkbox } from "@/components/kumo/checkbox";
import { KumoSelect } from "@/components/kumo/select";

export function WidgetTediSelection({
	value,
	disabled = false,
	tedis,
	onChange,
}: {
	value?: EmbeddedTediSelectionPolicy;
	disabled?: boolean;
	tedis: Array<{ id: string; name: string }>;
	onChange: (value: EmbeddedTediSelectionPolicy | undefined) => void;
}) {
	const choices = [
		...tedis,
		...(value?.allowedTediIds ?? [])
			.filter((id) => !tedis.some((tedi) => tedi.id === id))
			.map((id) => ({ id, name: `Unavailable tedi (${id})` })),
	];
	return (
		<fieldset className="grid gap-3" disabled={disabled}>
			<legend className="text-sm font-medium">Selectable tedis</legend>
			<p className="text-sm text-kumo-subtle">
				Choose which tedis appear in the widget. Switching starts a separate
				conversation.
			</p>
			{tedis.length === 0 && <p role="status">No active tedis available.</p>}
			{choices.map((tedi) => (
				<label key={tedi.id} className="flex items-center gap-2">
					<Checkbox
						checked={value?.allowedTediIds.includes(tedi.id) ?? false}
						onCheckedChange={(checked) => {
							const ids = checked
								? [...(value?.allowedTediIds ?? []), tedi.id]
								: (value?.allowedTediIds ?? []).filter((id) => id !== tedi.id);
							onChange(
								ids.length
									? {
											allowedTediIds: ids,
											defaultTediId:
												value && ids.includes(value.defaultTediId)
													? value.defaultTediId
													: tedi.id === value?.defaultTediId
														? ids[0]!
														: (value?.defaultTediId ?? tedi.id),
										}
									: undefined,
							);
						}}
					/>
					{tedi.name}
				</label>
			))}
			{value && (
				<label className="grid gap-2 text-sm">
					Default tedi
					<KumoSelect<string>
						aria-label="Default tedi"
						className="w-full"
						disabled={disabled}
						value={value.defaultTediId}
						onValueChange={(id) => {
							if (id) onChange({ ...value, defaultTediId: id });
						}}
						items={choices
							.filter((tedi) => value.allowedTediIds.includes(tedi.id))
							.map((tedi) => ({ value: tedi.id, label: tedi.name }))}
					/>
				</label>
			)}
		</fieldset>
	);
}

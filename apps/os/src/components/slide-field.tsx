import { type ReactNode, useState } from "react";
import { Input } from "@/components/kumo/input";
import { Text } from "@/components/kumo/text";
import { safeImageSource } from "@/lib/output-models";
import { cn } from "@/lib/utils";

export function SlideField({
	label,
	inline = false,
	children,
}: {
	label: string;
	inline?: boolean;
	children: ReactNode;
}) {
	return (
		<Text
			as={inline ? "span" : "label"}
			role="label"
			tone="secondary"
			className={cn(
				"[&_:is(input,textarea):focus]:ring-2 [&_:is(input,textarea):focus]:ring-inset [&_:is(input,textarea):focus]:ring-kumo-focus",
				inline
					? "flex min-w-0 items-center justify-between gap-2"
					: "grid min-w-0 gap-1",
			)}
		>
			{label}
			{children}
		</Text>
	);
}

export function SlideImageUrlField({
	label,
	ariaLabel,
	src,
	disabled,
	onChange,
}: {
	label: string;
	ariaLabel: string;
	src?: string;
	disabled?: boolean;
	onChange: (src: string | undefined) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const linked = safeImageSource(src)?.startsWith("https://");
	return (
		<SlideField label={label}>
			<Input
				type="url"
				aria-label={ariaLabel}
				maxLength={2_048}
				disabled={disabled}
				placeholder={src && !linked ? "Uploaded image" : "https://"}
				value={draft ?? (linked ? src : "")}
				onBlur={() => setDraft(null)}
				onChange={(event) => {
					setDraft(event.target.value);
					const next = event.target.value.trim();
					// Keep the stored image while a replacement address is incomplete.
					if (next === "" || safeImageSource(next)) onChange(next || undefined);
				}}
			/>
		</SlideField>
	);
}

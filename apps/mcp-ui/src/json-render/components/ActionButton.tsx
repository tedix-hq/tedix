import { Button } from "@tedix/widget-ui/button";

export type ActionButtonTone =
	| "default"
	| "primary"
	| "success"
	| "warning"
	| "destructive"
	| "ghost";

const toneVariant: Record<
	ActionButtonTone,
	| "default"
	| "soft"
	| "soft-success"
	| "soft-warning"
	| "soft-destructive"
	| "ghost"
> = {
	default: "soft",
	primary: "default",
	success: "soft-success",
	warning: "soft-warning",
	destructive: "soft-destructive",
	ghost: "ghost",
};

interface ActionButtonProps {
	label?: string | null;
	tone?: ActionButtonTone | null;
	disabled?: boolean | null;
	fullWidth?: boolean | null;
	onPress: () => void;
}

/**
 * A layout-authorable button whose behavior is entirely an `on.press` action
 * from the spec (`open_url`, `follow_up`, `call_tool`, …). The component owns
 * only presentation; every side effect stays in the registered action
 * handlers, so a spec can never smuggle logic past the action allowlist.
 */
export function ActionButtonComponent({
	label,
	tone,
	disabled,
	fullWidth,
	onPress,
}: ActionButtonProps) {
	if (!label) return null;
	return (
		<Button
			className={fullWidth ? "w-full" : undefined}
			disabled={disabled ?? false}
			onClick={onPress}
			type="button"
			variant={toneVariant[tone ?? "default"]}
		>
			{label}
		</Button>
	);
}

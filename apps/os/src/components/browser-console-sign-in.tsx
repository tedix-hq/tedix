import {
	ToolPolicySchema,
	type ToolPolicy,
} from "@tedix/api-contract/schemas/tedi";
import { Switch } from "@/components/kumo/switch";

export function BrowserConsoleSignIn({
	policy,
	disabled,
	onChange,
}: {
	policy: ToolPolicy | null | undefined;
	disabled: boolean;
	onChange: (policy: ToolPolicy) => void;
}) {
	return (
		<Switch
			label="Allow Tedix console sign-in"
			checked={
				policy?.browserEgress?.presets?.includes("tedix-console-sign-in") ??
				false
			}
			disabled={disabled}
			onCheckedChange={(checked) => {
				const current = ToolPolicySchema.parse(policy ?? {});
				onChange({
					...current,
					browserEgress: {
						allowedHostnames: current.browserEgress?.allowedHostnames ?? [],
						deniedHostnames: current.browserEgress?.deniedHostnames ?? [],
						presets: checked ? ["tedix-console-sign-in"] : [],
					},
				});
			}}
		/>
	);
}

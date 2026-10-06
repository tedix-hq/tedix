import { CAPABILITY_SCOPES } from "@tedix/mcp-shared/auth/scopes";
import { selectConsentPreset } from "@tedix/mcp-shared/auth/consent-scopes";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { normalizeConsentPermissions } from "@/shared/consent-permissions";
import { ConsentPermissionGroups } from "@/account/consent-permission-groups";
export const CLI_LOGIN_SELECTABLE_SCOPES = [
	...CAPABILITY_SCOPES,
	"connections.read",
	"connections.execute",
	"connections.admin",
	"platform:admin",
] as const;
const permissions = normalizeConsentPermissions(CLI_LOGIN_SELECTABLE_SCOPES);
export function defaultCliLoginScopes(): string[] {
	return selectConsentPreset(permissions, "read");
}
export function readOnlyCliLoginScopes(): string[] {
	return defaultCliLoginScopes();
}
export function CliLoginPermissions({
	value,
	onChange,
	disabled,
}: {
	value: readonly string[];
	onChange: (scopes: string[]) => void;
	disabled?: boolean;
}) {
	return (
		<div className="grid gap-3">
			<Text role="body" tone="secondary">
				Choose the exact permissions the CLI will request. Each organization
				reviews the same selection.
			</Text>
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					disabled={disabled}
					onClick={() => onChange(defaultCliLoginScopes())}
				>
					Read only
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={disabled}
					onClick={() =>
						onChange(
							selectConsentPreset(
								permissions.filter((scope) => scope.name !== "platform:admin"),
								"all",
							),
						)
					}
				>
					Full organization access
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={disabled}
					onClick={() => onChange([])}
				>
					Deselect all
				</Button>
			</div>
			<Text role="label" tone="secondary">
				{value.length} of {permissions.length} selected
			</Text>
			<ConsentPermissionGroups
				permissions={permissions}
				selectedScopes={value}
				onSelectionChange={disabled ? undefined : onChange}
			/>
			{value.includes("platform:admin") ? (
				<Text role="body" tone="warning">
					Platform administration grants cross-organization operator authority
					when your account is eligible.
				</Text>
			) : null}
			{value.length === 0 ? (
				<Text role="body" tone="error">
					Select at least one permission to continue.
				</Text>
			) : null}
		</div>
	);
}

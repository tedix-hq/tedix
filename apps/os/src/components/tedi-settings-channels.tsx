import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import * as z from "zod";
import type { ChannelsConfig } from "@tedix/api-contract/schemas/tedi";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Button } from "@/components/kumo/button";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { SelectItem } from "@/components/kumo/select";
import { SensitiveInput } from "@/components/kumo/sensitive-input";
import { Surface } from "@/components/kumo/surface";
import { Switch } from "@/components/kumo/switch";
import { toast } from "@/components/kumo/toast";
import { osApi } from "@/lib/api";
import { errorMessage } from "@/lib/orpc-error";
import {
	osQueryKeys,
	tediPairingRequestsQueryOptions,
} from "@/lib/os-query-options";

type ManagedChannel = "telegram";
type DmPolicy = "allowlist" | "disabled" | "open" | "pairing";
type GroupPolicy = "allowlist" | "disabled" | "open";
type CommonChannelPolicy = {
	dmPolicy: DmPolicy;
	groupPolicy: GroupPolicy;
	requireMention: boolean;
};

const DEFAULT_CHANNEL_POLICY: CommonChannelPolicy = {
	dmPolicy: "allowlist",
	groupPolicy: "allowlist",
	requireMention: true,
};

/**
 * Plain-language labels for what the runtime actually does with each policy
 * (`apps/tedi-runtime/src/telegram-turn-policy.ts`). The stored enum values
 * are unchanged; `pairing` is kept because it may already be stored, but the
 * runtime has no pairing-approval flow and treats it exactly as `allowlist`.
 */
export const DM_POLICY_OPTIONS: ReadonlyArray<{
	value: DmPolicy;
	label: string;
	help: string;
}> = [
	{
		value: "pairing",
		label: "Allowlist (pairing not yet available)",
		help: "Behaves exactly like Allowlist until a pairing approval flow exists.",
	},
	{
		value: "allowlist",
		label: "Allowlist",
		help: "Only listed users get the tedi's full tool set. Everyone else gets a short reply only: no tools, nothing is learned.",
	},
	{
		value: "open",
		label: "Open",
		help: "Anyone can message. Unverified senders get a short reply only: no tools, nothing is learned.",
	},
	{
		value: "disabled",
		label: "Disabled",
		help: "Direct messages are dropped without a reply.",
	},
];

export const GROUP_POLICY_OPTIONS: ReadonlyArray<{
	value: GroupPolicy;
	label: string;
	help: string;
}> = [
	{
		value: "allowlist",
		label: "Allowlist",
		help: "Only listed group members get the tedi's full tool set. Everyone else gets a short reply only: no tools, nothing is learned.",
	},
	{
		value: "open",
		label: "Open",
		help: "Anyone in a group can message. Unverified senders get a short reply only: no tools, nothing is learned.",
	},
	{
		value: "disabled",
		label: "Disabled",
		help: "Group messages are dropped without a reply.",
	},
];

export const ALLOW_FROM_HELP = "Telegram user id or @username, one per line.";

export function policyHelp<T extends string>(
	options: ReadonlyArray<{ value: T; help: string }>,
	value: T,
): string {
	return options.find((option) => option.value === value)?.help ?? "";
}

/** One allowlist entry per line; blank lines are ignored. */
export function parseAllowFrom(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function allowFromText(value: unknown): string {
	return Array.isArray(value)
		? value.filter((entry) => typeof entry === "string").join("\n")
		: "";
}

export function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

const channelPolicySchema = z.object({
	enabled: z.boolean(),
	botToken: z.string(),
	dmPolicy: z.enum(["allowlist", "disabled", "open", "pairing"]),
	allowFrom: z.string(),
	groupPolicy: z.enum(["allowlist", "disabled", "open"]),
	groupAllowFrom: z.string(),
	requireMention: z.boolean(),
});

const liveChannelsSchema = z.object({
	telegram: channelPolicySchema,
});

type LiveChannelsValues = z.output<typeof liveChannelsSchema>;

export function liveChannelValues(channelsValue: unknown): LiveChannelsValues {
	const channels = recordValue(channelsValue);
	return Object.fromEntries(
		(["telegram"] as const).map((channel) => {
			const existing = recordValue(channels[channel]);
			const dmPolicy = ["allowlist", "disabled", "open", "pairing"].includes(
				String(existing.dmPolicy),
			)
				? (existing.dmPolicy as DmPolicy)
				: DEFAULT_CHANNEL_POLICY.dmPolicy;
			const groupPolicy = ["allowlist", "disabled", "open"].includes(
				String(existing.groupPolicy),
			)
				? (existing.groupPolicy as GroupPolicy)
				: DEFAULT_CHANNEL_POLICY.groupPolicy;
			return [
				channel,
				{
					enabled: existing.enabled === true,
					botToken: "",
					dmPolicy,
					allowFrom: allowFromText(existing.allowFrom),
					groupPolicy,
					groupAllowFrom: allowFromText(existing.groupAllowFrom),
					requireMention: existing.requireMention !== false,
				},
			];
		}),
	) as LiveChannelsValues;
}

export function LiveChannelsForm({
	values,
	canManage,
	canReadSecrets,
	canManageSecrets,
	isSaving,
	isTesting,
	onSave,
	onTest,
}: {
	values: LiveChannelsValues;
	canManage: boolean;
	canReadSecrets: boolean;
	canManageSecrets: boolean;
	isSaving: boolean;
	isTesting: boolean;
	onSave: (value: LiveChannelsValues) => Promise<boolean>;
	onTest: (channel: ManagedChannel, token: string) => void;
}) {
	const dmPolicyOptions = DM_POLICY_OPTIONS.filter(
		(option) =>
			option.value !== "pairing" || values.telegram.dmPolicy === "pairing",
	);
	const form = useZodForm({
		schema: liveChannelsSchema,
		defaultValues: values,
		onSubmit: async ({ value }) => {
			if (await onSave(value)) {
				form.reset(
					Object.fromEntries(
						(["telegram"] as const).map((channel) => [
							channel,
							{ ...value[channel], botToken: "" },
						]),
					) as LiveChannelsValues,
				);
			}
		},
	});
	useEffect(() => form.reset(values), [form, values]);

	return (
		<form
			className="space-y-5"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			{(["telegram"] as const).map((channel) => (
				<Surface key={channel} className="space-y-3 p-3">
					<FormField
						form={form}
						name={`${channel}.enabled`}
						label={channel}
						orientation="horizontal"
					>
						{(field, meta) => (
							<Switch
								id={meta.id}
								checked={field.state.value}
								disabled={!canManage}
								onCheckedChange={field.handleChange}
							/>
						)}
					</FormField>
					<FormField
						form={form}
						name={`${channel}.botToken`}
						label={`${channel} bot token`}
						description={
							canReadSecrets
								? "Leave blank to preserve the current credential."
								: "Credential presence is unknown."
						}
					>
						{(field, meta) => (
							<div className="flex flex-wrap items-start gap-2">
								<div className="min-w-0 flex-1">
									<SensitiveInput
										id={meta.id}
										aria-labelledby={`${meta.id}-label`}
										aria-invalid={meta.invalid || undefined}
										aria-describedby={meta.descriptionId}
										aria-errormessage={meta.errorId}
										placeholder={
											canReadSecrets
												? "Enter a replacement token"
												: "Credential presence unknown"
										}
										disabled={!canManageSecrets}
										value={field.state.value}
										onValueChange={field.handleChange}
									/>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isTesting || !field.state.value}
									onClick={() => onTest(channel, field.state.value)}
								>
									Test replacement credential
								</Button>
							</div>
						)}
					</FormField>
					<form.Subscribe
						selector={(state) => ({
							dmPolicy: state.values[channel].dmPolicy,
							groupPolicy: state.values[channel].groupPolicy,
						})}
					>
						{({ dmPolicy, groupPolicy }) => (
							<div className="grid gap-3 sm:grid-cols-2">
								<FormField
									form={form}
									name={`${channel}.dmPolicy`}
									label="Direct messages"
									description={policyHelp(DM_POLICY_OPTIONS, dmPolicy)}
								>
									{(field, meta) => (
										<FormSelect
											field={field}
											{...meta}
											disabled={!canManage}
											items={dmPolicyOptions}
										>
											{dmPolicyOptions.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</FormSelect>
									)}
								</FormField>
								<FormField
									form={form}
									name={`${channel}.allowFrom`}
									label="Trusted DM senders"
									description={ALLOW_FROM_HELP}
								>
									{(field, meta) => (
										<FormTextarea
											field={field}
											{...meta}
											rows={3}
											disabled={!canManage}
										/>
									)}
								</FormField>
								<FormField
									form={form}
									name={`${channel}.groupPolicy`}
									label="Groups"
									description={policyHelp(GROUP_POLICY_OPTIONS, groupPolicy)}
								>
									{(field, meta) => (
										<FormSelect field={field} {...meta} disabled={!canManage}>
											{GROUP_POLICY_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{option.label}
												</SelectItem>
											))}
										</FormSelect>
									)}
								</FormField>
								<FormField
									form={form}
									name={`${channel}.groupAllowFrom`}
									label="Trusted group members"
									description={ALLOW_FROM_HELP}
								>
									{(field, meta) => (
										<FormTextarea
											field={field}
											{...meta}
											rows={3}
											disabled={!canManage}
										/>
									)}
								</FormField>
								<FormField
									form={form}
									name={`${channel}.requireMention`}
									label="Reply in groups only when mentioned"
									description="On: group messages that do not mention the bot are dropped. Off: the tedi reads every group message."
									orientation="horizontal"
								>
									{(field, meta) => (
										<Switch
											id={meta.id}
											checked={field.state.value}
											disabled={!canManage}
											onCheckedChange={field.handleChange}
										/>
									)}
								</FormField>
							</div>
						)}
					</form.Subscribe>
				</Surface>
			))}
			<Button type="submit" disabled={!canManage || isSaving}>
				Save channels
			</Button>
		</form>
	);
}

export function useTediSettingsChannels(
	tediId: string,
	tedi: { data?: { channels?: unknown } },
	invalidateTedi: () => Promise<unknown>,
) {
	const queryClient = useQueryClient();
	const pairingRequests = useQuery({
		...tediPairingRequestsQueryOptions(tediId),
		refetchInterval: 30_000,
	});
	const channelValues = useMemo(
		() => liveChannelValues(tedi.data?.channels),
		[tedi.data?.channels],
	);
	const saveChannels = useMutation({
		mutationFn: async (value: LiveChannelsValues) => {
			if (!tedi.data) throw new Error("Tedi settings are unavailable");
			const current = recordValue(tedi.data.channels);
			const nextChannels = {
				...current,
				telegram: {
					...recordValue(current.telegram),
					enabled: value.telegram.enabled,
					dmPolicy: value.telegram.dmPolicy,
					allowFrom: parseAllowFrom(value.telegram.allowFrom),
					groupPolicy: value.telegram.groupPolicy,
					groupAllowFrom: parseAllowFrom(value.telegram.groupAllowFrom),
					requireMention: value.telegram.requireMention,
				},
			} as ChannelsConfig;

			await osApi.tedis.update({ tediId, channels: nextChannels });
			const issues: string[] = [];
			const secretWrites = [
				{ name: "TELEGRAM_BOT_TOKEN", value: value.telegram.botToken },
			]
				.filter(({ value }) => value.length > 0)
				.map(({ name, value }) =>
					osApi.tediSecrets.set({ tediId, name, value }),
				);
			const secretResults = await Promise.allSettled(secretWrites);
			const failedSecrets = secretResults.filter(
				(result) => result.status === "rejected",
			).length;
			if (failedSecrets)
				issues.push(`${failedSecrets} credential writes failed`);

			const policyResults = await Promise.allSettled(
				(["telegram"] as const).map((channel) =>
					osApi.tedis.updateChannelConfig({
						tediId,
						channel,
						config: {
							enabled: value[channel].enabled,
							dmPolicy: value[channel].dmPolicy,
							allowFrom: parseAllowFrom(value[channel].allowFrom),
							groupPolicy: value[channel].groupPolicy,
							groupAllowFrom: parseAllowFrom(value[channel].groupAllowFrom),
							requireMention: value[channel].requireMention,
						},
					}),
				),
			);
			const failedPolicies = policyResults.filter(
				(result) => result.status === "rejected",
			).length;
			if (failedPolicies)
				issues.push(`${failedPolicies} live channel policies did not save`);
			try {
				await osApi.tedis.syncConfig({ tediId });
			} catch {
				issues.push("runtime config sync did not finish");
			}
			return issues;
		},
		onSuccess: async (issues) => {
			await invalidateTedi();
			if (issues.length) {
				toast.warning(
					`Channels saved with partial outcomes: ${issues.join("; ")}`,
				);
			} else {
				toast.success("Channels saved and synced");
			}
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Channel metadata did not save")),
	});

	const testChannelToken = useMutation({
		mutationFn: ({
			channel,
			token,
		}: {
			channel: ManagedChannel;
			token: string;
		}) => osApi.tedis.testChannelToken({ tediId, channel, token }),
		onSuccess: (result, { channel }) => {
			if (result.valid) {
				toast.success(
					`${channel} credential is valid${result.botUsername ? ` for @${result.botUsername}` : ""}`,
				);
			} else {
				toast.error(result.error ?? `${channel} credential is invalid`);
			}
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Credential validation failed")),
	});

	const approvePairing = useMutation({
		mutationFn: (code: string) =>
			osApi.tedis.approvePairing({ tediId, channel: "telegram", code }),
		onSuccess: async (result) => {
			await Promise.all([
				pairingRequests.refetch(),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
			]);
			toast.success(result.message || "Telegram pairing approved");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to approve Telegram pairing")),
	});

	return {
		channelValues,
		pairingRequests,
		saveChannels,
		testChannelToken,
		approvePairing,
	};
}

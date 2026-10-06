import { WidgetTediSelection } from "@/components/widget-tedi-selection";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	OrganizationMetadataSchema,
	type Organization,
} from "@tedix/api-contract/schemas/organization";
import { buildTranslate } from "@tedix/widget-i18n";
import {
	resolveWidgetCatalog,
	WIDGET_CATALOGS,
} from "@tedix/widget-i18n/catalogs";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	SectionHeader,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Input } from "@/components/kumo/input";
import { Textarea } from "@/components/kumo/textarea";
import { Switch } from "@/components/kumo/switch";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { osApi } from "@/lib/api";
import {
	osQuery,
	organizationDetailQueryOptions,
} from "@/lib/os-query-options";
import {
	resolveTediWidgetConfig,
	type TediWidgetConfig,
} from "@/lib/tedi-widget-config";

const schema = OrganizationMetadataSchema.shape.tediWidget.unwrap();
const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/** Merge only edited fields into a fresh read. This is conflict detection, not CAS. */
export function mergeExperienceDraft(
	base: TediWidgetConfig,
	draft: TediWidgetConfig,
	latest: TediWidgetConfig,
): TediWidgetConfig {
	function merge(before: unknown, after: unknown, current: unknown): unknown {
		if (same(before, after)) return current;
		const record = (value: unknown): value is Record<string, unknown> =>
			!!value && typeof value === "object" && !Array.isArray(value);
		if (
			(before === undefined || record(before)) &&
			record(after) &&
			(current === undefined || record(current))
		) {
			const previous = record(before) ? before : {};
			const result = { ...current };
			for (const key of new Set([
				...Object.keys(previous),
				...Object.keys(after),
			])) {
				const next = merge(previous[key], after[key], current?.[key]);
				if (next === undefined) delete result[key];
				else result[key] = next;
			}
			return result;
		}
		if (!same(current, before) && !same(current, after))
			throw new Error(
				"These settings changed while you were editing. Discard your draft to load the latest version, then try again.",
			);
		return after;
	}
	return schema.parse(merge(base, draft, latest));
}

function localized(config: TediWidgetConfig) {
	const locale = (config.locale ?? "en-US").toLowerCase();
	const entries = Object.entries(config.translations ?? {});
	const match =
		entries.find(([key]) => key.toLowerCase() === locale) ??
		entries.find(
			([key]) => key.toLowerCase().split("-")[0] === locale.split("-")[0],
		);
	return {
		key: match?.[0] ?? config.locale ?? "en-US",
		copy: match?.[1] ?? {},
	};
}
function starterText(config: TediWidgetConfig) {
	return (
		localized(config).copy.conversationStarters ?? config.conversationStarters
	).join("\n");
}
function withStarters(
	config: TediWidgetConfig,
	text: string,
): TediWidgetConfig {
	const questions = text
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
	const { key, copy } = localized(config);
	if (copy.conversationStarters)
		return {
			...config,
			translations: {
				...config.translations,
				[key]: { ...copy, conversationStarters: questions },
			},
		} as TediWidgetConfig;
	return { ...config, conversationStarters: questions };
}

function languageName(locale: string): string {
	try {
		return (
			new Intl.DisplayNames(["en"], {
				type: "language",
				languageDisplay: "standard",
			}).of(locale) ?? locale
		);
	} catch {
		return locale;
	}
}

export function draftIssueMessage(issue: {
	path: PropertyKey[];
	message: string;
}): string {
	const key = String(issue.path.at(-1) ?? "");
	if (key === "accentColor" || key === "accentColorDark")
		return `${key === "accentColor" ? "Brand color" : "Dark brand color"}: enter a six-digit hex color such as #1594c7.`;
	if (issue.path.includes("conversationStarters"))
		return "Suggested questions: use up to 6 questions, each no longer than 240 characters.";
	const labels: Record<string, string> = {
		title: "Assistant name",
		subtitle: "Text below the assistant’s name",
		product: "Product name",
		welcomeHeading: "Welcome heading",
		welcomeBody: "Welcome message",
		locale: "Default language",
		assistantLogoUrl: "Assistant logo URL",
		assistantLogoUrlDark: "Dark assistant logo URL",
		launcherIconUrl: "Chat button image URL",
		launcherIconUrlDark: "Dark chat button image URL",
		horizontalOffset: "Distance from side",
		bottomOffset: "Distance from bottom",
		zIndex: "Stacking order",
	};
	if (key.includes("Url"))
		return `${labels[key]}: enter a valid URL or leave this field empty.`;
	if (key === "horizontalOffset" || key === "bottomOffset")
		return `${labels[key]}: enter a whole number from 8 to 120 pixels.`;
	if (key === "zIndex")
		return "Stacking order: enter a whole number from 1 to 2147483647.";
	const lengths: Record<string, number> = {
		title: 80,
		subtitle: 160,
		product: 100,
		welcomeHeading: 160,
		welcomeBody: 320,
	};
	if (lengths[key])
		return `${labels[key]}: enter text up to ${lengths[key]} characters.`;
	return `${labels[key] ?? "Widget settings"}: ${issue.message}`;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<SettingsSection>
			<SectionHeader>
				<SectionTitle>{title}</SectionTitle>
			</SectionHeader>
			<SettingsSectionContent className="grid items-start gap-4 sm:grid-cols-2">
				{children}
			</SettingsSectionContent>
		</SettingsSection>
	);
}
function Choice({
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	label: string;
	value: string;
	options: Array<[string, string]>;
	onChange(value: string): void;
	disabled: boolean;
}) {
	return (
		<label className="grid gap-1">
			{label}
			<Select
				value={value}
				disabled={disabled}
				onValueChange={(next) => next && onChange(next)}
			>
				<SelectTrigger aria-label={label}>
					<SelectValue>
						{options.find(([key]) => key === value)?.[1] ?? value}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map(([key, text]) => (
						<SelectItem key={key} value={key}>
							{text}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</label>
	);
}

export function ExperienceEditor({
	organization,
	config,
}: {
	organization: Organization;
	config: TediWidgetConfig;
}) {
	const client = useQueryClient();
	const tedis = useQuery(
		osQuery.tedis.list.queryOptions({ input: { limit: 100, offset: 0 } }),
	);
	const [base, setBase] = useState(config);
	const [draft, setDraft] = useState(config);
	const [starters, setStarters] = useState(starterText(config));
	const [saved, setSaved] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [wide, setWide] = useState(
		() => window.matchMedia("(min-width: 1024px)").matches,
	);
	useEffect(() => {
		const media = window.matchMedia("(min-width: 1024px)");
		const update = () => setWide(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	const candidate = withStarters(draft, starters);
	const dirty = !same(base, candidate);
	useEffect(() => {
		if (!dirty && !same(base, config)) {
			setBase(config);
			setDraft(config);
			setStarters(starterText(config));
		}
	}, [config, base, dirty]);
	const validation = schema.safeParse(candidate);
	const mutation = useMutation({
		mutationFn: async () => {
			const parsed = schema.parse(candidate);
			const current = await osApi.organizations.get({
				organizationId: organization.id,
			});
			client.setQueryData(
				organizationDetailQueryOptions(organization.id).queryKey,
				current,
			);
			const next = mergeExperienceDraft(
				base,
				parsed,
				resolveTediWidgetConfig(current),
			);
			return await osApi.organizations.update({
				organizationId: organization.id,
				metadata: { tediWidget: next },
			});
		},
		onSuccess: (result) => {
			const published = resolveTediWidgetConfig(result);
			setBase(published);
			setDraft(published);
			setStarters(starterText(published));
			setSaved(true);
			client.setQueryData(
				organizationDetailQueryOptions(organization.id).queryKey,
				result,
			);
		},
	});
	const pending = mutation.isPending;
	const edit = <K extends keyof TediWidgetConfig>(
		key: K,
		value: TediWidgetConfig[K],
	) => {
		setDraft((current) => ({ ...current, [key]: value }));
		mutation.reset();
	};
	const locale = draft.locale ?? "en-US";
	const { key: translationKey, copy } = localized(draft);
	const setCopy = (
		key: "title" | "subtitle" | "welcomeHeading" | "welcomeBody",
		value: string,
	) => {
		const next = { ...copy };
		if (value) next[key] = value;
		else delete next[key];
		edit("translations", { ...draft.translations, [translationKey]: next });
	};
	const catalog = resolveWidgetCatalog(locale);
	const t = buildTranslate(copy, catalog.catalog);
	const languages: Array<[string, string]> = Object.keys(WIDGET_CATALOGS).map(
		(code) => [code, languageName(code)],
	);
	if (!languages.some(([code]) => code === locale))
		languages.push([locale, languageName(locale)]);
	const field = (
		key:
			| "title"
			| "product"
			| "subtitle"
			| "assistantLogoUrl"
			| "assistantLogoUrlDark"
			| "launcherIconUrl"
			| "launcherIconUrlDark",
		label: string,
	) => (
		<label className="grid gap-1" key={key}>
			{label}
			<Input
				aria-label={label}
				value={
					(key === "title" || key === "subtitle" ? copy[key] : undefined) ??
					draft[key] ??
					""
				}
				onChange={(event) =>
					(key === "title" || key === "subtitle") && copy[key] !== undefined
						? setCopy(key, event.target.value)
						: edit(
								key,
								event.target.value ||
									(key.endsWith("Url") || key.endsWith("Dark")
										? undefined
										: ""),
							)
				}
			/>
		</label>
	);
	const color = (key: "accentColor" | "accentColorDark", label: string) => (
		<label className="grid gap-1">
			{label}
			<div className="flex gap-2">
				<Input
					className="w-12"
					type="color"
					aria-label={`${label} picker`}
					value={
						/^#[0-9a-f]{6}$/i.test(draft[key] ?? "") ? draft[key] : "#2557d6"
					}
					onChange={(event) => edit(key, event.target.value)}
				/>
				<Input
					aria-label={label}
					value={draft[key] ?? ""}
					onChange={(event) => edit(key, event.target.value || undefined)}
				/>
			</div>
		</label>
	);
	return (
		<div className="grid gap-6 [&_input]:scroll-mt-24 [&_textarea]:scroll-mt-24 [&_button]:scroll-mt-24">
			<Surface
				tier="panel"
				className="sticky top-0 z-10 flex flex-wrap items-center gap-3 px-4 py-3"
			>
				<Button
					disabled={pending || !dirty || !validation.success}
					onClick={() => mutation.mutate()}
				>
					{pending ? "Publishing…" : "Publish changes"}
				</Button>
				<Button
					variant="secondary"
					disabled={pending || !dirty}
					onClick={() => {
						setBase(config);
						setDraft(config);
						setStarters(starterText(config));
						mutation.reset();
					}}
				>
					Discard draft
				</Button>
				<span role="status" className="text-sm text-kumo-subtle">
					{pending
						? "Publishing your changes"
						: dirty
							? "Unsaved changes"
							: saved || organization.metadata?.tediWidget
								? "Published"
								: "Not published"}
				</span>
			</Surface>
			{!validation.success && (
				<Alert variant="destructive" role="alert">
					<AlertTitle>Check your draft</AlertTitle>
					<AlertDescription>
						<ul>
							{validation.error.issues.map((issue, index) => (
								<li key={index}>{draftIssueMessage(issue)}</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			)}
			{mutation.isError && (
				<Alert variant="destructive" role="alert">
					<AlertTitle>Could not publish</AlertTitle>
					<AlertDescription>
						{mutation.error instanceof Error
							? mutation.error.message
							: "Your draft is saved here. Try again."}
					</AlertDescription>
				</Alert>
			)}
			<SettingsSection>
				<SectionHeader>
					<SectionTitle>OS quick chat</SectionTitle>
				</SectionHeader>
				<SettingsSectionContent>
					{tedis.isError ? (
						<p role="alert">Could not load tedis.</p>
					) : (
						<WidgetTediSelection
							disabled={pending}
							value={draft.tediSelection}
							tedis={(tedis.data?.data ?? [])
								.filter((tedi) => tedi.status === "active" && !tedi.retiredAt)
								.map((tedi) => ({
									id: tedi.id,
									name: tedi.displayName || tedi.name,
								}))}
							onChange={(value) => edit("tediSelection", value)}
						/>
					)}
					<p className="text-sm text-kumo-subtle">
						Customer widget tedis are configured per business in Access
						settings.
					</p>
				</SettingsSectionContent>
			</SettingsSection>
			<p className="text-sm text-kumo-subtle">
				Applies to all your customer apps on their next widget load.
			</p>
			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
				<aside className="order-first lg:order-last lg:sticky lg:top-20">
					<Button
						variant="secondary"
						className="lg:hidden"
						aria-expanded={previewOpen}
						onClick={() => setPreviewOpen((value) => !value)}
					>
						{previewOpen ? "Hide preview" : "Preview"}
					</Button>
					{(wide || previewOpen) && (
						<WidgetAppearancePreview config={candidate} />
					)}
				</aside>
				<div className="grid gap-6">
					<fieldset disabled={pending} className="grid min-w-0 gap-6">
						<Group title="Appearance">
							{field("title", "Assistant name")}
							{field("product", "Product name")}
							{field("subtitle", "Text below the assistant’s name")}
							{color("accentColor", "Brand color")}
							<Choice
								label="Theme"
								value={draft.themeMode ?? "host"}
								disabled={pending}
								options={[
									["host", "Match your application"],
									["system", "Match the visitor’s device"],
									["light", "Always light"],
									["dark", "Always dark"],
								]}
								onChange={(value) =>
									edit("themeMode", value as TediWidgetConfig["themeMode"])
								}
							/>
							<Choice
								label="Button position"
								value={draft.launcherPosition ?? "bottom-right"}
								disabled={pending}
								options={[
									["bottom-right", "Bottom right"],
									["bottom-left", "Bottom left"],
								]}
								onChange={(value) =>
									edit(
										"launcherPosition",
										value as TediWidgetConfig["launcherPosition"],
									)
								}
							/>
						</Group>
						<Collapsible>
							<CollapsibleTrigger>Advanced appearance</CollapsibleTrigger>
							<CollapsibleContent className="grid gap-4 pt-4 sm:grid-cols-2">
								{field("assistantLogoUrl", "Assistant logo URL")}
								{field("launcherIconUrl", "Chat button image URL")}
								{field("assistantLogoUrlDark", "Assistant logo URL · dark")}
								{field("launcherIconUrlDark", "Chat button image URL · dark")}
								{color("accentColorDark", "Dark brand color")}
								{(
									[
										["horizontalOffset", "Distance from side (px)", 22],
										["bottomOffset", "Distance from bottom (px)", 22],
										["zIndex", "Stacking order", 2147483000],
									] as const
								).map(([key, label, fallback]) => (
									<label key={key} className="grid gap-1">
										{label}
										<Input
											type="number"
											aria-label={label}
											value={draft[key] ?? fallback}
											onChange={(event) =>
												edit(
													key,
													event.target.value === ""
														? Number.NaN
														: Number(event.target.value),
												)
											}
										/>
									</label>
								))}
							</CollapsibleContent>
						</Collapsible>
						<Group title="Welcome">
							<div className="grid gap-2">
								<Choice
									label="Default language"
									value={locale}
									disabled={pending}
									options={languages}
									onChange={(value) => {
										const next = { ...candidate, locale: value };
										setDraft(next);
										setStarters(starterText(next));
										mutation.reset();
									}}
								/>
								<p className="text-sm text-kumo-subtle">
									Your app or a visitor’s language may override this default.
									The preview uses this language.
								</p>
							</div>
							<label className="grid gap-1">
								Welcome heading
								<Input
									aria-label="Welcome heading"
									value={copy.welcomeHeading ?? ""}
									placeholder={t("how_can_i_help_you_in", {
										product: draft.product,
									})}
									onChange={(event) =>
										setCopy("welcomeHeading", event.target.value)
									}
								/>
							</label>
							<label className="grid gap-1 sm:col-span-2">
								Welcome message
								<Textarea
									aria-label="Welcome message"
									value={copy.welcomeBody ?? ""}
									placeholder={t("i_m_connected_to_your_workspace", {
										product: draft.product,
									})}
									onChange={(event) =>
										setCopy("welcomeBody", event.target.value)
									}
								/>
							</label>
							<label className="grid gap-1 sm:col-span-2">
								Suggested questions
								<Textarea
									aria-label="Suggested questions"
									rows={4}
									value={starters}
									onChange={(event) => {
										setStarters(event.target.value);
										mutation.reset();
									}}
								/>
								<span className="text-sm text-kumo-subtle">
									One question per line, up to 6. All questions appear in the
									preview.
								</span>
							</label>
						</Group>
						<Group title="Behavior">
							<Choice
								label="When opened"
								value={draft.startMode ?? "home"}
								disabled={pending}
								options={[
									["home", "Show welcome screen"],
									["conversation", "Go straight to conversation"],
								]}
								onChange={(value) =>
									edit("startMode", value as TediWidgetConfig["startMode"])
								}
							/>
							<Choice
								label="Chat button"
								value={draft.launcherMode ?? "default"}
								disabled={pending}
								options={[
									["default", "Show chat button"],
									["host", "Use your application’s button"],
									["hidden", "Hide chat button"],
								]}
								onChange={(value) =>
									edit(
										"launcherMode",
										value as TediWidgetConfig["launcherMode"],
									)
								}
							/>
							{(
								[
									["welcome", "Show welcome message"],
									["recent", "Show recent conversations"],
								] as const
							).map(([module, label]) => (
								<div
									key={module}
									className="flex items-center justify-between gap-2"
								>
									<span>{label}</span>
									<Switch
										aria-label={label}
										disabled={pending || draft.startMode === "conversation"}
										checked={(
											draft.homeModules ?? ["welcome", "recent"]
										).includes(module)}
										onCheckedChange={(checked) =>
											edit(
												"homeModules",
												(["welcome", "recent"] as const).filter((item) =>
													item === module
														? checked
														: (
																draft.homeModules ?? ["welcome", "recent"]
															).includes(item),
												),
											)
										}
									/>
								</div>
							))}
						</Group>
					</fieldset>
				</div>
			</div>
		</div>
	);
}

export function WidgetAppearancePreview({
	config,
}: {
	config: TediWidgetConfig;
}) {
	const [dark, setDark] = useState(false);
	const locale = config.locale ?? "en-US";
	const resolved = resolveWidgetCatalog(locale);
	const translation = localized(config).copy;
	const t = buildTranslate(translation, resolved.catalog);
	const accent =
		(dark
			? (config.accentColorDark ?? config.accentColor)
			: config.accentColor) ?? "#2557d6";
	const logo = dark
		? (config.assistantLogoUrlDark ?? config.assistantLogoUrl)
		: config.assistantLogoUrl;
	const launcher = dark
		? (config.launcherIconUrlDark ?? config.launcherIconUrl)
		: config.launcherIconUrl;
	const modules = config.homeModules ?? ["welcome", "recent"];
	const configuredQuestions =
		translation.conversationStarters ?? config.conversationStarters;
	const previewQuestions = configuredQuestions.length
		? configuredQuestions
		: [
				t("starter_attention"),
				t("starter_recent_activity"),
				t("starter_explain_page"),
			];
	return (
		<section aria-label="Preview" className="grid gap-3">
			<div className="flex items-center justify-between">
				<strong>Preview</strong>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => setDark((value) => !value)}
				>
					{dark ? "Show light" : "Show dark"}
				</Button>
			</div>
			<p className="text-xs text-kumo-subtle">
				{languageName(locale)} · {dark ? "Dark" : "Light"}. Example content;
				this preview does not start a chat.
			</p>
			<div
				data-theme="tedix"
				data-mode={dark ? "dark" : "light"}
				style={
					{
						colorScheme: dark ? "dark" : "light",
						// Kumo leaves inherit already-resolved colors from the OS root. Restate
						// the preview's leaves locally, as the fixed-light editor surfaces do.
						"--color-kumo-base": dark ? "#242424" : "#ffffff",
						"--color-kumo-tint": dark ? "#202020" : "#fafafa",
						"--text-color-kumo-default": dark ? "#f4f4f5" : "#18181b",
						"--text-color-kumo-subtle": dark ? "#a1a1aa" : "#71717a",
						"--color-kumo-line": dark
							? "rgba(255,255,255,.11)"
							: "rgba(24,24,27,.12)",
					} as CSSProperties
				}
				className="relative overflow-hidden rounded-xl border border-kumo-line bg-kumo-tint p-3 pb-20 text-kumo-default"
			>
				<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base shadow-tedix-raised">
					<header className="flex items-center gap-3 border-b border-kumo-line p-3">
						{logo ? (
							<img
								src={logo}
								alt="Assistant logo"
								className="size-9 object-contain"
							/>
						) : (
							<span style={{ color: accent }}>T</span>
						)}
						<div>
							<strong>{translation.title ?? config.title}</strong>
							<p className="text-xs text-kumo-subtle">
								{translation.subtitle ?? config.subtitle}
							</p>
						</div>
					</header>
					<div className="grid min-h-40 gap-3 p-4">
						{config.startMode !== "conversation" ? (
							<>
								{modules.includes("welcome") && (
									<div>
										<h4 className="font-semibold">
											{translation.welcomeHeading ??
												t("how_can_i_help_you_in", { product: config.product })}
										</h4>
										<p className="mt-1 text-sm text-kumo-subtle">
											{translation.welcomeBody ??
												t("i_m_connected_to_your_workspace", {
													product: config.product,
												})}
										</p>
									</div>
								)}
								{previewQuestions.map((question, index) => (
									<div
										key={index}
										className="rounded-lg border border-kumo-line px-3 py-2 text-sm"
									>
										{question}
									</div>
								))}
								{modules.includes("recent") && (
									<div className="text-xs text-kumo-subtle">
										{t("recent_chats")}
										<span className="block">Example conversation history</span>
									</div>
								)}
							</>
						) : (
							<p className="text-sm text-kumo-subtle">
								{t("new_conversation")}
							</p>
						)}
					</div>
					<div className="m-3 rounded-full border border-kumo-line px-3 py-2 text-sm text-kumo-subtle">
						{t("ask", { assistant: translation.title ?? config.title })}
					</div>
				</div>
				{(config.launcherMode ?? "default") === "default" && (
					<div
						aria-label="Preview launcher"
						className={`absolute bottom-3 grid size-12 place-items-center rounded-full text-white ${config.launcherPosition === "bottom-left" ? "left-3" : "right-3"}`}
						style={{ background: accent }}
					>
						{launcher ? (
							<img
								src={launcher}
								alt="Launcher icon"
								className="size-8 object-contain"
							/>
						) : (
							"T"
						)}
					</div>
				)}
				{config.launcherMode === "host" && (
					<p className="mt-3 text-xs text-kumo-subtle">
						Opened by your application’s button
					</p>
				)}
			</div>
		</section>
	);
}

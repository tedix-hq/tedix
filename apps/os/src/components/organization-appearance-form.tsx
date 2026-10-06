import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	DEFAULT_ORGANIZATION_OS_THEME,
	type OrganizationOsTheme,
	OrganizationOsThemeSchema,
	type OsCodeFont,
	type OsThemePalette,
	type OsUiFont,
} from "@tedix/api-contract/schemas/os-theme";
import { ArrowCounterClockwise, Check } from "@phosphor-icons/react";
import { type CSSProperties, useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Slider } from "@/components/kumo/slider";
import { Surface } from "@/components/kumo/surface";
import { osApi } from "@/lib/api";
import { organizationThemeVariables } from "@/lib/organization-theme";
import { errorMessage } from "@/lib/orpc-error";
import { osQueryKeys } from "@/lib/os-query-options";

const UI_FONT_OPTIONS: Array<{ value: OsUiFont; label: string }> = [
	{ value: "tedix", label: "Tedix" },
	{ value: "system", label: "System default" },
	{ value: "serif", label: "System serif" },
];

const CODE_FONT_OPTIONS: Array<{ value: OsCodeFont; label: string }> = [
	{ value: "tedix-mono", label: "Apercu Mono" },
	{ value: "system-mono", label: "System mono" },
];

function PaletteField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="grid grid-cols-[1fr_8.5rem] items-center gap-3 border-kumo-hairline border-b py-2.5 last:border-b-0">
			<span className="font-medium type-tedix-control text-kumo-default">
				{label}
			</span>
			<span className="flex items-center gap-2 rounded-lg bg-kumo-control p-1 ring ring-kumo-line">
				<input
					aria-label={`${label} color`}
					className="size-7 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 max-sm:size-11 coarse:size-11"
					type="color"
					value={value}
					onChange={(event) => onChange(event.target.value)}
				/>
				<Input
					aria-label={`${label} hex value`}
					size="sm"
					className="border-0 px-1 font-mono shadow-none ring-0"
					maxLength={7}
					value={value}
					onChange={(event) => onChange(event.target.value)}
				/>
			</span>
		</label>
	);
}

function ThemePreview({
	mode,
	palette,
	theme,
}: {
	mode: "light" | "dark";
	palette: OsThemePalette;
	theme: OrganizationOsTheme;
}) {
	const style = organizationThemeVariables(palette, theme) as CSSProperties;
	return (
		<Surface
			data-mode={mode}
			style={style}
			tier="panel"
			className="p-3 font-sans text-kumo-default"
		>
			<div className="mb-3 flex items-center justify-between">
				<span className="font-medium type-tedix-control capitalize">
					{mode}
				</span>
				<Badge variant="success">Live preview</Badge>
			</div>
			<Surface variant="raised" className="p-3">
				<p className="font-medium text-kumo-strong">Organization workspace</p>
				<p className="mt-1 type-tedix-control text-kumo-subtle">
					Semantic surfaces stay readable as the palette changes.
				</p>
				<div className="mt-3 flex flex-wrap gap-2">
					<Button size="sm">Primary action</Button>
					<Button size="sm" variant="secondary">
						Secondary
					</Button>
				</div>
				<code className="mt-3 block rounded bg-kumo-recessed p-2 font-mono type-tedix-caption">
					const tenant = &quot;personalized&quot;;
				</code>
			</Surface>
		</Surface>
	);
}

export function OrganizationAppearanceForm({
	organizationId,
	initialTheme,
}: {
	organizationId: string;
	initialTheme: OrganizationOsTheme | null | undefined;
}) {
	const queryClient = useQueryClient();
	const [theme, setTheme] = useState<OrganizationOsTheme>(
		initialTheme ?? DEFAULT_ORGANIZATION_OS_THEME,
	);
	const [saved, setSaved] = useState(false);
	const validation = OrganizationOsThemeSchema.safeParse(theme);

	const save = useMutation({
		mutationFn: (next: OrganizationOsTheme | null) =>
			osApi.organizations.update({
				organizationId,
				metadata: { osTheme: next },
			}),
		onMutate: () => setSaved(false),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: osQueryKeys.organizationDetail(),
				}),
				queryClient.invalidateQueries({
					queryKey: osQueryKeys.operationalContext(),
				}),
			]);
			setSaved(true);
		},
	});

	const patchPalette = (
		mode: "light" | "dark",
		patch: Partial<OsThemePalette>,
	) =>
		setTheme((current) => ({
			...current,
			[mode]: { ...current[mode], ...patch },
		}));

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Appearance</SectionTitle>
					<SectionDescription>
						Set the organization default. Members can still choose light, dark,
						or system mode and keep their accessibility preferences.
					</SectionDescription>
				</SectionHeading>
				<SectionActions>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setTheme(DEFAULT_ORGANIZATION_OS_THEME);
							save.mutate(null);
						}}
					>
						<ArrowCounterClockwise className="size-4" /> Reset
					</Button>
				</SectionActions>
			</SectionHeader>
			<SettingsSectionContent className="space-y-5">
				<div className="grid gap-4 lg:grid-cols-2">
					{(["light", "dark"] as const).map((mode) => (
						<Surface key={mode} tier="panel" className="p-3">
							<h3 className="mb-1 font-medium type-tedix-body capitalize">
								{mode} theme
							</h3>
							<PaletteField
								label="Accent"
								value={theme[mode].accent}
								onChange={(accent) => patchPalette(mode, { accent })}
							/>
							<PaletteField
								label="Background"
								value={theme[mode].background}
								onChange={(background) => patchPalette(mode, { background })}
							/>
							<PaletteField
								label="Foreground"
								value={theme[mode].foreground}
								onChange={(foreground) => patchPalette(mode, { foreground })}
							/>
							<label className="mt-2 grid grid-cols-[1fr_8.5rem] items-center gap-3 py-2">
								<span className="font-medium type-tedix-control">Contrast</span>
								<span className="flex items-center gap-2">
									<Slider
										ariaLabel={`${mode} theme contrast`}
										className="min-w-0 flex-1"
										min={0}
										max={100}
										value={theme[mode].contrast}
										onValueChange={(contrast) =>
											patchPalette(mode, {
												contrast,
											})
										}
									/>
									<output className="w-7 text-right type-tedix-control text-kumo-subtle">
										{theme[mode].contrast}
									</output>
								</span>
							</label>
						</Surface>
					))}
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<label className="space-y-2">
						<span className="block font-medium type-tedix-control">
							UI font
						</span>
						<Select
							value={theme.uiFont}
							onValueChange={(uiFont) =>
								setTheme((current) => ({
									...current,
									uiFont: uiFont as OsUiFont,
								}))
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue>
									{UI_FONT_OPTIONS.find(
										(option) => option.value === theme.uiFont,
									)?.label ?? theme.uiFont}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{UI_FONT_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>
					<label className="space-y-2">
						<span className="block font-medium type-tedix-control">
							Code font
						</span>
						<Select
							value={theme.codeFont}
							onValueChange={(codeFont) =>
								setTheme((current) => ({
									...current,
									codeFont: codeFont as OsCodeFont,
								}))
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue>
									{CODE_FONT_OPTIONS.find(
										(option) => option.value === theme.codeFont,
									)?.label ?? theme.codeFont}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{CODE_FONT_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>
				</div>

				<div className="grid gap-3 md:grid-cols-2">
					<ThemePreview mode="light" palette={theme.light} theme={theme} />
					<ThemePreview mode="dark" palette={theme.dark} theme={theme} />
				</div>

				{save.isError && (
					<p role="alert" className="type-tedix-control text-kumo-danger">
						{errorMessage(
							save.error,
							"The appearance profile could not be saved.",
						)}
					</p>
				)}
				{!validation.success && (
					<p role="alert" className="type-tedix-control text-kumo-danger">
						{validation.error.issues[0]?.message ??
							"Choose a valid, accessible palette."}
					</p>
				)}
				<div className="flex items-center justify-end gap-3">
					{saved && (
						<span className="inline-flex items-center gap-1 type-tedix-control text-kumo-success">
							<Check className="size-4" /> Published
						</span>
					)}
					<Button
						disabled={save.isPending || !validation.success}
						onClick={() => {
							if (validation.success) save.mutate(validation.data);
						}}
					>
						{save.isPending ? "Publishing…" : "Publish appearance"}
					</Button>
				</div>
			</SettingsSectionContent>
		</SettingsSection>
	);
}

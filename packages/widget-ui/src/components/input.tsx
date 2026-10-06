"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2, X } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

const inputVariants = cva(
	"w-full min-w-0 border bg-clip-padding text-base outline-none transition-colors file:inline-flex file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
	{
		variants: {
			variant: {
				outline: "border-input bg-input/30",
				soft: "border-transparent bg-muted",
			},
			size: {
				sm: "h-8 px-2.5 py-1 text-sm file:h-6",
				md: "h-9 px-3 py-1.5 file:h-7",
				lg: "h-10 px-3.5 py-2 file:h-8",
			},
			pill: {
				true: "rounded-full",
				false: "rounded-lg",
			},
		},
		defaultVariants: {
			variant: "outline",
			size: "md",
			pill: false,
		},
	},
);

export interface InputProps
	extends
		Omit<React.ComponentProps<"input">, "size">,
		VariantProps<typeof inputVariants> {
	/**
	 * Content rendered at the start of the input (apps-sdk-ui compatible)
	 */
	startAdornment?: React.ReactNode;
	/**
	 * Content rendered at the end of the input (apps-sdk-ui compatible)
	 */
	endAdornment?: React.ReactNode;
	/**
	 * Make end adornment clickable (for password toggle, clear)
	 */
	onEndIconClick?: () => void;
	/**
	 * Show loading spinner in place of endAdornment
	 */
	loading?: boolean;
	/**
	 * Show character counter (requires maxLength)
	 */
	showCharacterCount?: boolean;
	/**
	 * Helper text shown below input (non-error)
	 */
	helperText?: React.ReactNode;
	/**
	 * Error message shown below input
	 */
	error?: React.ReactNode;
	/**
	 * Mark the input as invalid (apps-sdk-ui compatible)
	 * @default false
	 */
	invalid?: boolean;
	/**
	 * Show clear button when input has value
	 */
	clearable?: boolean;
	/**
	 * Callback when clear button clicked
	 */
	onClear?: () => void;
	/**
	 * Select all contents of the input when mounted (apps-sdk-ui compatible)
	 * @default false
	 */
	autoSelect?: boolean;
}

/**
 * Input - Base UI input primitive with apps-sdk-ui theming
 *
 * @example
 * ```tsx
 * <Input placeholder="Enter text..." />
 * <Input type="email" startAdornment={<MailIcon />} />
 * <Input type="search" endAdornment={<SearchIcon />} />
 * <Input size="lg" variant="soft" />
 * <Input pill />
 * <Input clearable onClear={() => setValue("")} />
 * <Input loading />
 * <Input showCharacterCount maxLength={100} />
 * <Input helperText="Your email will not be shared" />
 * <Input error="Email is required" invalid />
 * <Input autoSelect />
 * ```
 */
function Input({
	className,
	type,
	variant = "outline",
	size = "md",
	pill = false,
	startAdornment,
	endAdornment,
	onEndIconClick,
	loading,
	showCharacterCount,
	helperText,
	error,
	invalid,
	clearable,
	onClear,
	autoSelect,
	maxLength,
	value,
	defaultValue,
	onChange,
	...props
}: InputProps) {
	const inputRef = React.useRef<HTMLInputElement>(null);

	// Track internal value for character count and clearable
	const [internalValue, setInternalValue] = React.useState(
		value ?? defaultValue ?? "",
	);

	// Update internal value when controlled value changes
	React.useEffect(() => {
		if (value !== undefined) {
			setInternalValue(value);
		}
	}, [value]);

	// Auto-select content on mount (apps-sdk-ui compatible)
	React.useEffect(() => {
		if (autoSelect) {
			inputRef.current?.select();
		}
	}, [autoSelect]);

	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setInternalValue(e.target.value);
		onChange?.(e);
	};

	const handleClear = () => {
		setInternalValue("");
		onClear?.();
	};

	// Determine what to show in end position
	const hasValue = String(internalValue).length > 0;
	const showClearButton = clearable && hasValue && !loading;
	const showLoadingSpinner = loading;

	let finalEndAdornment = endAdornment;
	if (showLoadingSpinner) {
		finalEndAdornment = <Loader2 className="animate-spin" />;
	} else if (showClearButton) {
		finalEndAdornment = <X />;
	}

	const hasEndAction = onEndIconClick || showClearButton;
	const handleEndIconClick = showClearButton ? handleClear : onEndIconClick;

	// Compute invalid state from prop or error
	const isInvalid = invalid || !!error;

	// Check if we need wrapper (adornments, helper text, error, or character count)
	const needsWrapper =
		startAdornment ||
		finalEndAdornment ||
		showCharacterCount ||
		helperText !== undefined ||
		error !== undefined;

	// Calculate character count
	const currentLength = String(internalValue).length;

	// Invalid state classes
	const invalidClasses =
		"border-destructive ring-[3px] ring-destructive/20 dark:border-destructive/50 dark:ring-destructive/40";

	// If no wrapper needed, render simple input
	if (!needsWrapper) {
		return (
			<InputPrimitive
				ref={inputRef}
				type={type}
				data-slot="input"
				aria-invalid={isInvalid || undefined}
				className={cn(
					inputVariants({ variant, size, pill }),
					isInvalid && invalidClasses,
					className,
				)}
				maxLength={maxLength}
				value={value}
				defaultValue={defaultValue}
				onChange={onChange}
				{...props}
			/>
		);
	}

	// Wrap with container for adornments and helper text
	return (
		<div className="w-full" data-slot="input-container">
			<div
				className="relative flex w-full items-center"
				data-slot="input-wrapper"
			>
				{startAdornment && (
					<div
						className="pointer-events-none absolute left-3 text-muted-foreground [&_svg]:size-4"
						data-slot="input-start-adornment"
					>
						{startAdornment}
					</div>
				)}
				<InputPrimitive
					ref={inputRef}
					type={type}
					data-slot="input"
					aria-invalid={isInvalid || undefined}
					className={cn(
						inputVariants({ variant, size, pill }),
						isInvalid && invalidClasses,
						startAdornment && "pl-10",
						finalEndAdornment && "pr-10",
						className,
					)}
					maxLength={maxLength}
					value={value}
					defaultValue={defaultValue}
					onChange={handleChange}
					{...props}
				/>
				{finalEndAdornment && (
					<div
						className={cn(
							"absolute right-3 text-muted-foreground [&_svg]:size-4",
							hasEndAction && "pointer-events-auto",
							!hasEndAction && "pointer-events-none",
						)}
						data-slot="input-end-adornment"
					>
						{hasEndAction ? (
							<button
								type="button"
								onClick={handleEndIconClick}
								className="inline-flex items-center justify-center rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
								tabIndex={-1}
								aria-label={showClearButton ? "Clear input" : undefined}
							>
								{finalEndAdornment}
							</button>
						) : (
							finalEndAdornment
						)}
					</div>
				)}
			</div>
			{(error || helperText || showCharacterCount) && (
				<div
					className="mt-1.5 flex items-center justify-between gap-2 px-3 text-xs"
					data-slot="input-footer"
				>
					{error ? (
						<span
							role="alert"
							data-slot="input-error"
							className="text-destructive"
						>
							{error}
						</span>
					) : (
						helperText && (
							<span
								data-slot="input-helper-text"
								className="text-muted-foreground"
							>
								{helperText}
							</span>
						)
					)}
					{showCharacterCount && maxLength && (
						<span
							data-slot="input-character-count"
							className={cn(
								"ml-auto tabular-nums",
								currentLength > maxLength
									? "text-destructive"
									: "text-muted-foreground",
							)}
						>
							{currentLength}/{maxLength}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

export { Input, inputVariants };

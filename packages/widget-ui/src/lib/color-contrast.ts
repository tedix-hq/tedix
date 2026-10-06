/**
 * WCAG 2.0 Color Contrast Validation Utilities
 *
 * Provides color contrast calculation and validation per WCAG 2.0 guidelines.
 *
 * WCAG 2.0 Contrast Requirements:
 * - AA Normal Text: 4.5:1
 * - AA Large Text: 3:1
 * - AAA Normal Text: 7:1
 * - AAA Large Text: 4.5:1
 *
 * Large text is defined as 14pt bold or 18pt regular (roughly 18.66px/24px)
 *
 * @see https://www.w3.org/TR/WCAG20/#visual-audio-contrast-contrast
 */

/**
 * Normalize hex color to standard 6-digit format
 *
 * @example
 * normalizeHexColor('#f00') // '#ff0000'
 * normalizeHexColor('abc') // '#aabbcc'
 * normalizeHexColor('#12345678') // null (invalid)
 */
export function normalizeHexColor(color: string): string | null {
	// Remove hash if present
	const cleaned = color.replace(/^#/, "");

	// Handle 3-digit hex
	if (cleaned.length === 3) {
		return `#${cleaned[0]}${cleaned[0]}${cleaned[1]}${cleaned[1]}${cleaned[2]}${cleaned[2]}`;
	}

	// Handle 6-digit hex
	if (cleaned.length === 6) {
		return `#${cleaned}`;
	}

	return null; // Invalid format
}

/**
 * Validate if string is a valid hex color
 *
 * @example
 * isValidHexColor('#ff0000') // true
 * isValidHexColor('#f00') // true
 * isValidHexColor('invalid') // false
 */
export function isValidHexColor(color: string): boolean {
	const normalized = normalizeHexColor(color);
	if (!normalized) return false;

	const hex = normalized.replace(/^#/, "");
	return /^[0-9A-Fa-f]{6}$/.test(hex);
}

/**
 * Calculate relative luminance per WCAG 2.0 formula
 *
 * Formula:
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 * where R, G, B are:
 * - sRGB / 255
 * - if sRGB <= 0.03928: sRGB / 12.92
 * - else: ((sRGB + 0.055) / 1.055) ^ 2.4
 *
 * @see https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
export function getRelativeLuminance(hex: string): number {
	const normalized = normalizeHexColor(hex);
	if (!normalized) {
		throw new Error(`Invalid hex color: ${hex}`);
	}

	const hexValue = normalized.replace(/^#/, "");
	const r = Number.parseInt(hexValue.slice(0, 2), 16) / 255;
	const g = Number.parseInt(hexValue.slice(2, 4), 16) / 255;
	const b = Number.parseInt(hexValue.slice(4, 6), 16) / 255;

	const gamma = (channel: number) => {
		return channel <= 0.03928
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	};

	return 0.2126 * gamma(r) + 0.7152 * gamma(g) + 0.0722 * gamma(b);
}

/**
 * Calculate contrast ratio between two colors
 *
 * Formula: (L1 + 0.05) / (L2 + 0.05)
 * where L1 is the lighter color and L2 is the darker color
 *
 * Returns a ratio from 1:1 (no contrast) to 21:1 (maximum contrast)
 *
 * @see https://www.w3.org/TR/WCAG20/#contrast-ratiodef
 */
export function getContrastRatio(
	foreground: string,
	background: string,
): number {
	const l1 = getRelativeLuminance(foreground);
	const l2 = getRelativeLuminance(background);

	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);

	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Get contrasting text color (black or white) for background
 *
 * Uses WCAG relative luminance to determine which text color
 * provides better contrast against the given background.
 *
 * @example
 * getContrastColor('#000000') // '#FFFFFF'
 * getContrastColor('#FFFFFF') // '#000000'
 * getContrastColor('#0066CC') // '#FFFFFF'
 */
export function getContrastColor(background: string): "#000000" | "#FFFFFF" {
	if (!isValidHexColor(background)) {
		throw new Error(`Invalid hex color: ${background}`);
	}

	const luminance = getRelativeLuminance(background);

	// WCAG threshold: 0.179 provides good results
	// Lighter backgrounds get black text, darker get white
	return luminance > 0.179 ? "#000000" : "#FFFFFF";
}

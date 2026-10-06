/**
 * Price Formatting Utilities
 *
 * Centralized price formatting functions to eliminate duplication across layouts.
 * Provides consistent currency formatting and discount math.
 *
 * **Usage:**
 * ```ts
 * import { formatPrice } from "./price-utils"
 *
 * formatPrice(1234.56, 'EUR')              // "€1,234.56"
 * formatPrice(1234.56, 'USD', 'de-DE')     // "$1.234,56"
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Supported currency codes (ISO 4217)
 */
export type CurrencyCode =
	| "EUR"
	| "USD"
	| "GBP"
	| "CHF"
	| "JPY"
	| "CNY"
	| "AUD"
	| "CAD"
	| "SEK"
	| "NOK"
	| "DKK"
	| "PLN"
	| "CZK"
	| "HUF"
	| "BRL"
	| "MXN"
	| "INR"
	| "SGD"
	| "HKD"
	| "NZD"
	| "ZAR"
	| "AED"
	| "SAR"
	| "TRY"
	| "RUB"
	| "KRW"
	| "IDR"
	| "THB"
	| "MYR"
	| "PHP"
	| "VND";

/**
 * Currency symbols mapping
 */
const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
	EUR: "€",
	USD: "$",
	GBP: "£",
	CHF: "CHF",
	JPY: "¥",
	CNY: "¥",
	AUD: "A$",
	CAD: "C$",
	SEK: "kr",
	NOK: "kr",
	DKK: "kr",
	PLN: "zł",
	CZK: "Kč",
	HUF: "Ft",
	BRL: "R$",
	MXN: "MX$",
	INR: "₹",
	SGD: "S$",
	HKD: "HK$",
	NZD: "NZ$",
	ZAR: "R",
	AED: "د.إ",
	SAR: "﷼",
	TRY: "₺",
	RUB: "₽",
	KRW: "₩",
	IDR: "Rp",
	THB: "฿",
	MYR: "RM",
	PHP: "₱",
	VND: "₫",
};

/**
 * Currencies that display symbol after the amount
 */
const SYMBOL_AFTER_CURRENCIES: CurrencyCode[] = [
	"CHF",
	"SEK",
	"NOK",
	"DKK",
	"CZK",
	"PLN",
];

/**
 * Currencies that don't use decimal places
 */
const NO_DECIMAL_CURRENCIES: CurrencyCode[] = [
	"JPY",
	"KRW",
	"IDR",
	"VND",
	"HUF",
];

// =============================================================================
// Core Formatting Functions
// =============================================================================

/**
 * Format a price for display with currency symbol and locale-aware formatting
 *
 * @param amount - The price amount to format
 * @param currency - Currency code (default: "EUR")
 * @param locale - Locale for number formatting (default: "en-US")
 * @returns Formatted price string (e.g., "€1,234.56", "$1,234.56")
 *
 * @example
 * ```ts
 * formatPrice(1234.56, 'EUR')              // "€1,234.56"
 * formatPrice(1234.56, 'USD')              // "$1,234.56"
 * formatPrice(1234.56, 'CHF')              // "CHF 1,234.56"
 * formatPrice(1234.56, 'JPY')              // "¥1,235" (no decimals)
 * formatPrice(1234.56, 'EUR', 'de-DE')     // "€1.234,56" (German formatting)
 * formatPrice(null, 'EUR')                 // "€0.00"
 * formatPrice(NaN, 'EUR')                  // "€0.00"
 * ```
 */
export function formatPrice(
	amount: number | null | undefined,
	currency: string = "EUR",
	locale = "en-US",
): string {
	// Handle edge cases
	if (amount == null || Number.isNaN(amount)) {
		amount = 0;
	}

	const symbol = CURRENCY_SYMBOLS[currency as CurrencyCode] || currency;
	const useDecimals = !NO_DECIMAL_CURRENCIES.includes(currency as CurrencyCode);

	// Round if no decimals (e.g., JPY)
	const finalAmount = useDecimals ? amount : Math.round(amount);

	const formatted = finalAmount.toLocaleString(locale, {
		minimumFractionDigits: useDecimals ? 2 : 0,
		maximumFractionDigits: useDecimals ? 2 : 0,
	});

	// Position symbol before or after based on currency
	if (SYMBOL_AFTER_CURRENCIES.includes(currency as CurrencyCode)) {
		return `${symbol} ${formatted}`;
	}

	return `${symbol}${formatted}`;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get currency symbol for a currency code
 *
 * @param currency - Currency code
 * @returns Currency symbol (e.g., "€", "$")
 */
export function getCurrencySymbol(currency: CurrencyCode): string {
	return CURRENCY_SYMBOLS[currency] || currency;
}

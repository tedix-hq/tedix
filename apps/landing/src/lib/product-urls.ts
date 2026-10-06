/**
 * The single product front door for every marketing CTA (login, request
 * access, waitlist). Tedix OS is the centralized auth surface; its apex login
 * bootstraps a first organization for brand-new users, which the retired
 * dashboard entry (`app.tedix.dev/login`) never did.
 */
export const PRODUCT_AUTH_URL = "https://os.tedix.dev/";

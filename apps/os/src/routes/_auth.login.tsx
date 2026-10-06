import { createFileRoute } from "@tanstack/react-router";
import { ProductLoginPage } from "@/account/product-login-page";

export const Route = createFileRoute("/_auth/login")({
	component: ProductLoginPage,
});

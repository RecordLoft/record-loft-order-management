import { type LoaderFunctionArgs } from "react-router";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    throw await login(request);
  }

  throw new Response("Not Found", { status: 404 });
};

export default function AuthLogin() {
  return null;
}
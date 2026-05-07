import { redirect, type LoaderFunctionArgs } from "react-router"; // Add redirect here
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	await authenticate.admin(request);
	const searchParams = new URL(request.url).searchParams;
	return redirect(`/app/shipping?${searchParams}`);
};
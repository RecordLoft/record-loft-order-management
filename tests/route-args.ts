import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export function routeArgs(
  request: Request,
  params: Record<string, string> = {},
): LoaderFunctionArgs & ActionFunctionArgs {
  return {
    request,
    params,
    context: {},
    unstable_url: new URL(request.url),
    unstable_pattern: "",
  };
}

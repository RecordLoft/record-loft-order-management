import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";
import { PassThrough } from "stream";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "https://admin.shopify.com",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Shopify-Access-Token",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          responseHeaders.set("Access-Control-Allow-Origin", "https://admin.shopify.com");
          responseHeaders.set("Content-Security-Policy", "frame-ancestors https://*.myshopify.com https://admin.shopify.com;");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}

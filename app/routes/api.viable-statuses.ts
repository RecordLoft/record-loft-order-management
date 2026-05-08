import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("id");

  if (!orderId) {
    return new Response(JSON.stringify({ error: "Order ID is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.ORDER_STATUS_PRO_API_KEY;
  if (!apiKey) {
    console.error("Missing ORDER_STATUS_PRO_API_KEY in environment variables.");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const response = await fetch(
      `https://app.orderstatuspro.com/api/v1/orders/${orderId}/viable-statuses`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `OrderStatusPro API error: ${response.status} - ${errorText}`,
      );
      throw new Error("Failed to fetch statuses from external API");
    }

    const data = await response.json();

    const choices = Array.isArray(data)
      ? data.map((status: any) => ({
          label: status.name,
          value: status.code,
        }))
      : [];

    return choices;
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || "Could not load statuses" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

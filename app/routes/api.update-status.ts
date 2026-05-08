import type { ActionFunctionArgs } from "react-router";

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const idsRaw = formData.get("ids") as string;
  const statusCode = formData.get("status_code");

  const orderIds = idsRaw
    .split(",")
    .map((id) => parseInt(id.split("/").pop() || "", 10))
    .filter((id) => !isNaN(id));

  try {
    const response = await fetch(
      "https://app.orderstatuspro.com/api/v1/orders/bulk-status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ORDER_STATUS_PRO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order_ids: orderIds,
          status_code: statusCode,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || "Bulk update failed");
    }

    return { success: true };
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

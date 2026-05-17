import { render } from 'preact';
import { useState } from 'preact/hooks';

const GET_FO_IDS = `
  query GetFOs($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        fulfillmentOrders(first: 5) {
          nodes { 
            id 
            status 
            deliveryMethod { methodType } 
          }
        }
      }
    }
  }
`;

const MARK_READY = `
  mutation MarkReady($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
    fulfillmentOrderLineItemsPreparedForPickup(input: $input) {
      userErrors { message }
    }
  }
`;

type Status = 'idle' | 'loading' | 'success' | 'error';

declare var shopify: import('@shopify/ui-extensions/admin.order-index.selection-action.render').Api;

export default async function () {
  render(<Extension />, document.body);
}

function Extension() {
  const { data, close } = shopify;
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  const handleAction = async () => {
    setStatus('loading');
    setMessage('');

    const orderIds = data.selected.map((o) => o.id);

    try {
      const queryResult = await shopify.query(GET_FO_IDS, { variables: { ids: orderIds } });

      if (queryResult.errors?.length) {
        throw new Error(queryResult.errors[0].message);
      }

      const foIds = (queryResult.data as any)?.nodes
        ?.filter((node: any) => node != null)
        .flatMap((node: any) => node.fulfillmentOrders.nodes)
        .filter(
          (fo: any) =>
            fo.status === 'OPEN' && fo.deliveryMethod?.methodType === 'PICK_UP',
        )
        .map((fo: any) => fo.id) ?? [];

      if (foIds.length === 0) {
        setStatus('error');
        setMessage('No eligible pickup orders selected.');
        return;
      }

      for (const id of foIds) {
        const result = await shopify.query(MARK_READY, {
          variables: {
            input: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: id }] },
          },
        });

        if (result.errors?.length) {
          throw new Error(result.errors[0].message);
        }

        const userErrors =
          (result.data as any)?.fulfillmentOrderLineItemsPreparedForPickup
            ?.userErrors ?? [];
        if (userErrors.length) {
          throw new Error(userErrors.map((e) => e.message).join(', '));
        }
      }

      setStatus('success');
      setMessage(`Notified ${foIds.length} customer(s).`);
      setTimeout(() => close(), 1500);
    } catch (error) {
      setStatus('error');
      setMessage(
        error instanceof Error ? error.message : 'An error occurred during processing.',
      );
    }
  };

  const isBusy = status === 'loading' || status === 'success';

  return (
    <s-admin-action heading="Mark Ready" loading={status === 'loading'}>
      {status === 'success' && (
        <s-banner tone="success">{message}</s-banner>
      )}
      {status === 'error' && (
        <s-banner tone="critical">{message}</s-banner>
      )}
      <s-text>
        You selected {data.selected.length} orders. We will identify and update only
        the pickup-eligible orders.
      </s-text>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleAction}
        disabled={isBusy}
      >
        {status === 'loading' ? 'Processing…' : 'Mark Ready For Pickup'}
      </s-button>
      <s-button slot="secondary-actions" onClick={() => close()} disabled={isBusy}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}

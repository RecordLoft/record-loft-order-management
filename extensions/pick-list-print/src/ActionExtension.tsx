import { render } from 'preact';

declare var shopify: any;

export default async function () {
  // @ts-ignore
  render(<Extension />, document.body);
}

function Extension() {
  const { data } = shopify;

  // 1. Extract IDs
  const ids = (data?.selected ?? [])
    .map(({ id }: { id: string }) => id.split('/').pop())
    .filter(Boolean)
    .join(',');

  const printUrl = `/print/pick-list?ids=${ids}`;

  return (
    // @ts-ignore
    <s-admin-action title="Print Pick List">
      {ids ? (
        // @ts-ignore
        <s-admin-print-action src={printUrl} />
      ) : (
        // @ts-ignore
        <s-text>No orders selected.</s-text>
      )}
    </s-admin-action>
  );
}
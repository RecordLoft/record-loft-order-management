import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/ActionExtension.tsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-index.selection-print-action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

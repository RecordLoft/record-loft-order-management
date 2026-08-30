-- Record Planet list/search filters shop + deliveryMethod on every request.
CREATE INDEX "Order_shop_deliveryMethod_idx" ON "Order"("shop", "deliveryMethod");

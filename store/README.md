# Christmas Super-Pack checkout

The released game displays **Coming soon** with a price of **$1.50 USD**. It does not contact a merchant service while its two shop configuration entries are empty. The public game never holds a Stripe secret or a receipt signing private key.

## Connect a merchant later

1. Run `winter-store-service.mjs` under Node 22.19 or later on a server with a persistent SQLite volume, HTTPS, and a stable hostname.
2. Outside the repository, generate one private signing key with `node winter-store-service.mjs --generate-receipt-key /persistent/private/receipt.pem`. Back up the PEM privately. The printed value is the **public** verification key for the game.
3. Set the server environment. `STRIPE_SECRET_KEY` is the merchant's Stripe secret. `STRIPE_WEBHOOK_SECRET` is the endpoint signing secret. `CORNY_STORE_DB` is the persistent database path and `CORNY_RECEIPT_KEY_FILE` is the private PEM path. Set `CORNY_GAME_URL` to the canonical public game page. Set `PORT` and `HOST` for your host or reverse proxy.
4. Register the server's `/v1/stripe-webhook` endpoint for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. The service verifies the raw signed event, bound checkout attempt, exact $1.50 payment, currency, product, mode and live/test environment. On return it can reconcile the saved Checkout Session directly with Stripe.
5. In the HTML build, set the `corny-store-url` meta content to the public HTTPS server base and the `corny-store-receipt-key` meta content to the public key from step 2. Publish the rebuilt game. Leave both entries empty until the server and merchant are ready.

Set `CORNY_STORE_TEST=1` to exercise a test-only Stripe account and database before connecting live checkout. Use separate keys and signing material for testing and production.

Each player store account has a private recovery key saved on the device. **Save or restore a purchase** in the event shop lets the owner copy that key or restore the skins on another device. One account can buy the pack once. Concurrent checkout requests reuse the same session. The server signs the entitlement and binds the consumable rewards to the owner's first eligible solo world. Inventory and its delivery marker are saved together before acknowledgment, so reopening the game after an interrupted save can resume delivery.

[Stripe Checkout session creation](https://docs.stripe.com/api/checkout/sessions/create) · [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment) · [Webhook signature verification](https://docs.stripe.com/webhooks/signature)


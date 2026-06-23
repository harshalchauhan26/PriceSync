# MBO Tracker - React and Node

This is the primary web stack:

- React 18 and Tailwind CSS client in client
- Node.js and Express API in server
- Supabase Postgres as the permanent data store

The scraper, FX conversion, review workflow, approval history, alerts,
Shopify push, email reporting, authentication, roles, and owner console are
implemented in the Node server. The Python application remains available as
the behavior reference and legacy entry point.

## Intended sheet workflow

Each imported row has two different URL responsibilities:

1. Designer Product URL is fetched by the price-checking pipeline.
2. MBO Product URL identifies the Shopify product to update when an approved
   price is pushed. It can be a Shopify Admin URL such as
   `https://admin.shopify.com/store/shashank-sing/products/9508098932963`, a
   numeric product-id URL, or a storefront `/products/handle` URL.

The Integrations toggle can temporarily switch pushes back to Designer URL,
but MBO URL is the default. A missing MBO URL falls back to Designer URL and
the recorded push status shows which URL source was used.

## Development

Install dependencies once:

    cd web/server
    npm install
    cd ../client
    npm install

Run the API:

    cd web/server
    npm run dev

Run the client in another terminal:

    cd web/client
    npm run dev

Vite serves the UI on port 5173 and proxies API requests to Node on port 8090.

## Production

Build the client, then start Node:

    cd web/client
    npm run build
    cd ../server
    npm start

Express serves the built React application and API together from port 8090.
Both applications read the repository-level .env file. Set NODE_PORT to
override 8090 and NODE_HOST to control the bind address.

Run one Node process. Pipeline progress, rate limits, live sessions, and logs
are intentionally held in memory.

## Source toggles

The Pipeline page can switch between:

- Database: current rows in products, including their latest workflow state.
- Imported: the latest persistent import_catalog snapshot. This remains
  available after restarts and is refreshed whenever a sheet is imported.

The Integrations page controls which URL identifies a Shopify product during
price updates:

- Designer URL preserves the original behavior.
- MBO URL reads the Shopify Admin product id or storefront handle from the MBO
  Product URL.

Both choices are stored in the Supabase meta table. If the selected Shopify URL
is empty for a row, the updater safely falls back to the other URL and reports
which source was actually used in the push status.

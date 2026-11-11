# WealthLab 4 — API-ready release

**Status:** Browser calculations + market-search backend are implemented and locally tested. **Live third-party data is not activated** until the owner creates a Scrappa API key and adds it as a secret in a deployed Render web service. A local test cannot prove the credentials work with Scrappa. The app is not publicly hosted by merely downloading this archive.

## What it does

- 5 existing tabs: comparison, apartment, VND savings, USD, government bonds.
- Visible synchronized monthly top-up in VND savings, USD, bonds (no new input; no modification to finance calculations).
- On-demand apartment sale search around the target buying budget (default ±20%), apartment category 324, by city, bedroom count, and area.
- For each matched project, looks up apartment rental listings (category 326) using project id and comparable size and bedrooms. Calculates listing-median sale, rent and gross rental yield, with sample counts and source links.
- Displays **asking prices only**, not verified executed transactions; flags absent rental samples and rental lookup failures rather than inventing values.
- 15-minute result cache, per-client rate limits, and an additional in-process cap on upstream API calls/day to help control usage. For a serious publicly used app, install persistent rate limits and monitoring.

## 1. Obtain the provider key (owner action)

1. Sign in or register at <https://scrappa.co/> and verify email.
2. On the Scrappa Dashboard, create an API key, copy its value from the one-time reveal screen, and store it securely. **Do not paste it into ChatGPT, README, GitHub, or the HTML file.**
3. Provider docs: <https://scrappa.co/docs/batdongsan-api/batdongsan_search>. Search endpoint `GET https://scrappa.co/api/batdongsan/search`, auth header `X-API-KEY`.

Scrappa indicates 500 free credits/month after email verification, with one successful call costing one credit. A single WealthLab search may call up to **8 times** (up to 2 sale pages and up to 6 project rent lookups), excluding repeated user searches after cache expires. Availability and charges are subject to provider changes.

## 2. Deploy to Render (Git-backed)

Render MCP currently requires this folder to be in a GitHub/GitLab/Bitbucket repository to create a web service. Push the **contents of this directory to the repository root**. The root includes `render.yaml` and `package.json`. Do not commit `.env`.

Blueprint configuration in `render.yaml`:

- Node web service, Free plan, build `npm install`, start `npm start`, port from Render `PORT`, binding `0.0.0.0`.
- `SCRAPPA_API_KEY` is declared with `sync: false` so its value is not written into Git.
- `SCRAPPA_MAX_CALLS_PER_DAY=100` to limit application usage (best-effort per-process counter).

In the Render Dashboard, connect the Git repository, deploy it as a web service or apply the Blueprint. Set environment secret `SCRAPPA_API_KEY` using **Service > Environment > Add Environment Variable**. Avoid showing the key in screenshots/logs. Trigger deploy or save and deploy.

## 3. Verify

1. Open `https://<your-render-hostname>/api/status` and check `ready: true`, `verified: false`. This means a key is configured, *not* that authentication has been tested.
2. In the live app, open the Chung cư tab, set ngân sách 3 tỷ, biên độ 20%, 2PN, press **Tìm tin mới**.
3. On a successful call, verify the source timestamps, number of sale and rent samples, original listing links, price values, and that the UI indicates **GIÁ RAO**.
4. If provider responds 401/403, the app returns `INVALID_API_KEY` without revealing credentials. If no key is present, the API returns 503 `NOT_CONFIGURED`.

## Local test without a real API key

Requirements: Node.js >=20. Run `npm test` (no provider credentials or billing); `npm start` then visit `http://localhost:3000` for the offline financial tools. To exercise a real live query locally, inject `SCRAPPA_API_KEY` via process environment, **not** into source.

## Security and data constraints

- Key only loaded on backend, never sent to browsers.
- Fixed upstream hostname, strict query validation, external URL allowlist, no personal data collected.
- Public deployment requires rate limiting, privacy/terms review, and charge monitoring. Provider is independent of Batdongsan.com.vn.
- Ads may be duplicates, stale, or mispriced. Do not label them verified transactions or claim real-time database freshness.

# Data Provider

The market-data provider is NOT hardcoded into the scoring/storage layer.
Every HTTP Request node that talks to a provider reads its base URL and key
from environment variables:

```env
MARKET_DATA_PROVIDER=eodhd
MARKET_API_BASE_URL=
MARKET_API_KEY=
EGX_EXCHANGE_CODE=EGX
```

`MARKET_DATA_PROVIDER` is currently informational/documentation-only — no
workflow branches its logic on this value. If you want provider-specific
request shapes (different auth header, different date-range param names),
add an `IF`/routing step keyed on `$env.MARKET_DATA_PROVIDER` around the HTTP
Request nodes described below; the normalization layer downstream already
tolerates shape differences (see "Normalization contract").

## Why the endpoint URLs ship as placeholders

Exact REST endpoints for "list all symbols on an exchange" and "get EOD
history for a symbol" differ between providers and change over time. Rather
than guess and silently ship something that looks configured but returns
nothing (or worse, hits the wrong URL), every such HTTP Request node in this
project is named `... (CONFIGURE ENDPOINT)` and ships with a URL like:

```
{{ $env.MARKET_API_BASE_URL }}/CONFIGURE-EXCHANGE-SYMBOL-LIST-ENDPOINT
```

**You must edit these before running the corresponding workflow.** They
appear in:

| Workflow | Node | What it should become |
|---|---|---|
| `01-egx-stock-universe` | `Fetch EGX Universe (CONFIGURE ENDPOINT)` | Your provider's "list exchange constituents" endpoint |
| `02-egx-historical-import` | `Fetch Historical OHLCV (CONFIGURE ENDPOINT)` | Your provider's EOD/historical candles endpoint |
| `03-egx-daily-market-update` | `Fetch Recent OHLCV (CONFIGURE ENDPOINT)` | Same endpoint as above, called with a short lookback |
| `03-egx-daily-market-update` | `Fetch EGX30 Index (OPTIONAL, CONFIGURE ENDPOINT)` | Optional — your provider's index-history endpoint |

## Example shapes (verify against current provider docs before use)

**EODHD** (`https://eodhistoricaldata.com/api`):
- Exchange symbol list: historically `/exchange-symbol-list/{EXCHANGE_CODE}?api_token=...&fmt=json`
- EOD history: historically `/eod/{SYMBOL}.{EXCHANGE_CODE}?api_token=...&period=d&from=...&to=...&fmt=json`

**Twelve Data** (`https://api.twelvedata.com`):
- Symbol search/list: historically `/stocks?exchange={EXCHANGE_CODE}&apikey=...`
- Time series: historically `/time_series?symbol={SYMBOL}&interval=1day&start_date=...&end_date=...&apikey=...`

These are offered as a starting point, not a guarantee — always check the
provider's current documentation. Neither endpoint shape above is asserted
to be currently correct; that's exactly why they aren't hardcoded into the
workflow JSON.

## Normalization contract

Regardless of provider, every downstream Code node (`Normalize ... Response`
in `01`/`02`/`03`) converts the raw HTTP response into this shape before
anything touches the database:

```json
{
  "symbol": "COMI",
  "date": "2026-08-18",
  "open": 100.20,
  "high": 103.10,
  "low": 99.80,
  "close": 102.70,
  "volume": 12500000,
  "tradedValue": 1270000000
}
```

The normalize nodes are tolerant of common field-name variants
(`open`/`Open`, `close`/`Close`/`adjusted_close`, `date`/`Date`/`datetime`,
etc.) and of the response being either a bare array or wrapped in
`{ data: [...] }` / `{ results: [...] }`. If your provider's response shape
doesn't match ANY of these, edit the `Normalize ... Response` Code node in
that workflow — the parsing logic is intentionally isolated there and
nowhere else, so a provider swap never touches validation, storage, or
scoring code.

`tradedValue` is derived (`helpers.deriveTradedValue`, typical price ×
volume) when the provider doesn't supply it directly.

## Adding a second provider

1. Add its base URL / key to `.env` under a distinct variable if you want to
   run against two providers side by side (otherwise reuse
   `MARKET_API_BASE_URL`/`MARKET_API_KEY`).
2. Edit the four `(CONFIGURE ENDPOINT)` HTTP Request nodes' URLs and query
   parameters to match.
3. Extend the `Normalize ... Response` Code nodes' field-name fallbacks if
   the new provider uses different keys than the ones already handled.
4. Nothing else changes — validation (`helpers.js`), storage, indicators, and
   every scanner are provider-agnostic by construction.

# Data Provenance Badges

A small badge that says whether a value on screen is **live**, **cached**, **demo** or **predicted**.

> Implemented for [Issue #1206](https://github.com/Nanle-code/stellar-dev-dashboard/issues/1206).
> Types: [`src/types/provenance.ts`](../src/types/provenance.ts). Logic: [`src/lib/provenance.ts`](../src/lib/provenance.ts). Component: [`src/components/common/ProvenanceBadge.tsx`](../src/components/common/ProvenanceBadge.tsx).

## The four kinds

| Kind        | Means                                                                                   | Tone    | Icon          |
| ----------- | --------------------------------------------------------------------------------------- | ------- | ------------- |
| `live`      | Fetched from the network recently and the last refresh succeeded                        | success | radio         |
| `cached`    | Served from a cache, the last refresh failed, or the value is older than expected       | neutral | clock         |
| `demo`      | Bundled sample data, not real network data                                              | warning | flask         |
| `predicted` | An estimate from a model, not an observed value                                         | info    | sparkles      |

They are mutually exclusive. When signals conflict the strongest caveat wins: **demo > predicted > cached > live**.

## Deciding the kind

`resolveProvenance()` takes whatever the caller knows:

```ts
resolveProvenance({
  isDemo, // bundled fixtures
  isPredicted, // model output
  fromCache, // read from a cache layer
  fetchedAt, // ms epoch or Date of the last successful fetch
  hasError, // the most recent refresh failed
  staleAfterMs, // default 2 minutes
  now, // clock override for tests
})
```

"Live" has to be earned. It needs a fetch time, no failed refresh, and an age of at most `staleAfterMs`. A value that was never fetched, or whose freshness is unknown, is reported as **cached**, so the interface errs toward "this may be old". A timestamp in the future is treated as age 0.

## The component

```tsx
<ProvenanceBadge provenance="predicted" />
<ProvenanceBadge signals={{ fetchedAt: lastUpdated, hasError: Boolean(error), staleAfterMs: 3 * 60_000 }} />
<ProvenanceBadge provenance={resolveProvenance(...)} showAge={false} />
```

Live and cached badges show how old the value is ("Live 30s ago"). An unrecognised kind, or no information at all, renders as **cached**, never live.

### Where it is used

- **Price ticker** (`PriceTicker`): resolved from the last successful fetch and the store's price error. The ticker refreshes every 60 seconds; after 3 minutes without a success it reads "Cached".
- **Network Fee Forecast**: the chart is labelled **Demo** (the 72-hour history is generated sample data) and **Predicted** (the forecast band is a model output).

## Accessibility

- The kind is always written as text and has its own icon: meaning never depends on colour. Cached and predicted also use dashed and dotted borders.
- One accessible name per badge: `role="img"` with `aria-label="Data source: Cached. The last refresh failed; showing the value fetched 5m ago."`. The visible text is hidden from assistive technology so it is not read twice.
- The same sentence is the tooltip (`title`).
- Colours come from the design-system `Badge` tones and keep their existing contrast.

## Testing

`src/lib/__tests__/provenance.test.ts` covers every precedence rule, the stale threshold at exactly the limit and one millisecond over, custom thresholds, failed refreshes, missing and invalid timestamps, future timestamps, and age formatting. `src/components/common/__tests__/ProvenanceBadge.test.tsx` covers labels, tooltips, accessible names, distinct icons, age display, the fallback to cached, and class names.

## Privacy

The badge shows only a kind, an age and a generic explanation. It never includes the data source URL, account identifiers or response contents.

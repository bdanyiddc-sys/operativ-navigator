# CONFIG stabilítási audit

- Időpont: 2026-06-19T20:11:05.994Z
- BASE: `http://localhost:3000`
- Direct `/api/config`: 20 vehicles, 20 drivers, 5 ms

## A-clean (10x Ctrl+F5, SW off)

| Run | vehicles | drivers | status | API (banner) | CONFIG via | /api/config ms | rsv_api_base |
|-----|----------|---------|--------|--------------|------------|----------------|-------------|
| 1 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 4 | (üres) |
| 2 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 11 | (üres) |
| 3 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 18 | (üres) |
| 4 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 12 | (üres) |
| 5 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 13 | (üres) |
| 6 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 4 | (üres) |
| 7 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 9 | (üres) |
| 8 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 7 | (üres) |
| 9 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 8 | (üres) |
| 10 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 10 | (üres) |

**Eredmény:** 10/10 × vehicles=20, drivers=20 (ok)
**Nincs 0/0 állapot a végleges bannerben.**

## B-sw-on (10x Ctrl+F5, SW on)

| Run | vehicles | drivers | status | API (banner) | CONFIG via | /api/config ms | rsv_api_base |
|-----|----------|---------|--------|--------------|------------|----------------|-------------|
| 1 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 16 | (üres) |
| 2 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 9 | (üres) |
| 3 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 10 | (üres) |
| 4 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 11 | (üres) |
| 5 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 6 | (üres) |
| 6 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 12 | (üres) |
| 7 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 9 | (üres) |
| 8 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 9 | (üres) |
| 9 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 9 | (üres) |
| 10 | 20 | 20 | ok | localhost:3000 | same-origin-api-config | 8 | (üres) |

**Eredmény:** 10/10 × vehicles=20, drivers=20 (ok)
**Nincs 0/0 állapot a végleges bannerben.**

## C-bad-ls (rossz rsv_api_base)

| Run | vehicles | drivers | status | API (banner) | CONFIG via | /api/config ms | rsv_api_base |
|-----|----------|---------|--------|--------------|------------|----------------|-------------|
| 1 | 20 | 20 | ok | localhost:3999 | same-origin-api-config | 5 | http://localhost:3999 |

**Eredmény:** 1/1 × vehicles=20, drivers=20 (ok)
**Nincs 0/0 állapot a végleges bannerben.**

## Vizsgált mechanizmusok

- `localStorage.rsv_api_base`: API_BASE feloldás; a **config fetch** `adminApiUrl()` → same-origin `/api/config`
- `resolveRentApiBase()`: bannerben látszik (API: …); localhoston → `http://localhost:3000`
- Service Worker: sorozat B-ben aktív; HTML cache nem érinti `/api/config` (network-first)
- `loadFleetConfig()`: primary `/api/config` → fallback `/api/vehicles` + `/api/drivers`
- Render sorrend: `bootApplication()` → `loadFleetConfig().finally()` → bookings → `render()`

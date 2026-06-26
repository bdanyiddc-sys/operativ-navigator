# CLEANUP_BASELINE_BEFORE

**Dátum:** 2026-06-26  
**Munkaprojekt (deployolandó):** `D:\cursor\operativ-navigator_260614`  
**Biztonsági másolat:** `D:\cursor\Labor\operativ-navigator_260614_before_cleanup_20260626_201630\` (2125 fájl, robocopy OK)

## Aktív projektgyökér bizonyítás

`backend/server.js`:

| Route | Forrás |
|-------|--------|
| `/api/health` | `app.get('/api/health')` L2199 |
| `/public/` | `express.static(frontend/public)` L3683 |
| `/driver/` | `express.static(frontend/driver)` L3682 |
| `/admin` | `sendFile(frontend/admin/index.html)` L3657 |
| `/rent/public` | `sendFile(rent/public.html)` L3664 |
| `/rent/admin` | `sendFile(rent/admin.html)` L3667 |

`frontendDir` = `../frontend`, `rentDir` = `../frontend/rent`

## Rent Public runtime (érintetlen referencia)

| Fájl | SHA256 | Méret | Módosítva |
|------|--------|-------|-----------|
| `frontend/rent/public.html` | `1B5AE4BA6A6143D1F368B3F1A75816D88DBB9CBFD92ED6153F3ACDC99F236E7B` | 103512 | 2026-06-26 |

## Indítás

```powershell
cd D:\cursor\operativ-navigator_260614\backend
node server.js
```

## HTTP teszt (2026-06-26)

| URL | Status | Méret |
|-----|--------|-------|
| /api/health | 200 | 15 |
| /public/ | 200 | 11302 |
| /driver/ | 200 | 263839 |
| /admin | 200 | 394177 |
| /rent/public | 200 | 103512 |
| /rent/admin | 200 | 229736 |

## API smoke

`backend/tests/rent_api_smoke_test.ps1`: **41/41 PASS** (RENT-2026-0033)

## Ismert, nem blokkoló baseline megjegyzések

- `/public/` — opcionális `/api/stops?city=tata` 404 (korábbi mérés)
- `/driver/` — `/driver/audio/beep.mp3` 404 (korábbi mérés)

## Eredmény

**PASS** — mozgatás engedélyezve.

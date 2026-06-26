# PROJECT_FILE_INVENTORY (összefoglaló)

**Dátum:** 2026-06-26  
**Projekt:** `D:\cursor\operativ-navigator_260614`  
**Összes fájl:** 2127 (tisztítás előtt)

## Kategória összesítés (mozgatási jelöltek)

| Kategória | Fájl szám | Döntés |
|-----------|-----------|--------|
| E_TEST_AUDIT — `backend/audit/` | 31 | SAFE_MOVE |
| H_TEMP_OUTPUT — `backend/test-output/` | 97 | SAFE_MOVE |
| E_TEST_AUDIT — root `*_test*.mjs`, `*_run.mjs` | 7 | SAFE_MOVE |
| H_TEMP_OUTPUT — `tmp_rent_inquiries.json` | 1 | SAFE_MOVE |
| G_BACKUP_DUPLICATE — rent backup HTML + zip | 4 | SAFE_MOVE |
| **SAFE_MOVE összesen** | **~140** | karantén |
| Egyéb (runtime, config, data, docs, unknown) | ~1987 | KEEP |

## Rent Public runtime — KEEP (nem mozgatható)

| Fájl | Szerep |
|------|--------|
| `frontend/rent/public.html` | `/rent/public` aktív |
| `frontend/rent/index.html` | `/rent/` splash |
| `frontend/rent/admin.html` | `/rent/admin` |
| `frontend/rent/sw.js` | Service worker |
| `frontend/rent/booking_storage.js` | Local storage hook |
| `frontend/rent/manifest.webmanifest` | PWA |
| `frontend/rent/assets/*` | Splash assetek |

## Hivatkozásvizsgálat — backup HTML

`frontend/rent/*.html` és `*.js` fájlokban **nincs** hivatkozás a backup HTML-ekre.  
Csak `backend/test-output/` audit scriptek hivatkoznak rájuk — azok is karanténba kerülnek.

## Teljes CSV

A részletes `PROJECT_FILE_INVENTORY.csv` a mozgatás utáni manifesttel együtt készül (`CLEANUP_MOVE_MANIFEST.csv`).

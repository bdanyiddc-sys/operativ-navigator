# CLEANUP_BASELINE_AFTER

**Dátum:** 2026-06-26  
**Munkaprojekt:** `D:\cursor\operativ-navigator_260614`  
**Mozgatott fájlok:** 140 → karantén

## HTTP teszt

| URL | Előtte | Utána |
|-----|--------|-------|
| /api/health | 200 | 200 |
| /public/ | 200 | 200 |
| /driver/ | 200 | 200 |
| /admin | 200 | 200 |
| /rent/public | 200 | 200 |
| /rent/admin | 200 | 200 |

## API smoke

`backend/tests/rent_api_smoke_test.ps1`: **41/41 PASS** (RENT-2026-0034)

## Rent Public változatlan

| Fájl | SHA256 előtte | SHA256 utána |
|------|---------------|--------------|
| `frontend/rent/public.html` | `1B5AE4BA…F236E7B` | `1B5AE4BA…F236E7B` ✅ |

## Új hiba?

- Nincs új route 404
- Nincs alkalmazáslogika módosítás
- Backup HTML URL-ek (`/rent/public.pre-lab-backup.html` stb.) már nem elérhetők — **szándékos**, nem runtime route

## Eredmény

**PASS**

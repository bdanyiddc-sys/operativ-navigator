# CLEANUP_MOVE_PLAN

**Dátum:** 2026-06-26  
**Munkaprojekt:** `D:\cursor\operativ-navigator_260614`  
**Karantén cél:** `D:\cursor\Labor\_quarantine\operativ-navigator_260614_cleanup_20260626_201630\`  
**Baseline előtte:** PASS (`CLEANUP_BASELINE_BEFORE.md`)

## Mozgatási elv

- Csak **E_TEST_AUDIT**, **H_TEMP_OUTPUT**, **G_BACKUP_DUPLICATE**
- **Rent Public runtime érintetlen** — `public.html`, `index.html`, `admin.html`, `sw.js`, `booking_storage.js`, `assets/`
- `server.js` nem hivatkozik `backend/audit` vagy `backend/test-output` mappákra (grep: 0 találat)
- Service worker precache: `/rent/public`, `/rent/admin` — backup HTML-ek **nincsenek** benne

## SAFE_MOVE tétellista

| # | Régi hely | Kategória | Hivatkozás runtime? | Miért biztonságos? |
|---|-----------|-----------|---------------------|-------------------|
| 1 | `backend\audit\` (31 fájl) | E_TEST_AUDIT | Nem | Manuális audit scriptek, nem express.static |
| 2 | `backend\test-output\` (97 fájl) | H_TEMP_OUTPUT | Nem | Screenshot, log, tesztkimenet |
| 3 | `adapter_smoke_test.mjs` | E_TEST_AUDIT | Nem | Root teszt runner, nincs npm script |
| 4 | `bug_rc001_test.mjs` | E_TEST_AUDIT | Nem | — |
| 5 | `city_selection_debug_run.mjs` | E_TEST_AUDIT | Nem | — |
| 6 | `lkg_smoke_run.mjs` | E_TEST_AUDIT | Nem | — |
| 7 | `merge_test_run.mjs` | E_TEST_AUDIT | Nem | — |
| 8 | `patch_test_run.mjs` | E_TEST_AUDIT | Nem | — |
| 9 | `v30_regression_test.mjs` | E_TEST_AUDIT | Nem | — |
| 10 | `tmp_rent_inquiries.json` | H_TEMP_OUTPUT | Nem | Ideiglenes export |
| 11 | `frontend\rent\public.pre-lab-backup.html` | G_BACKUP_DUPLICATE | Nem (nem /rent/public) | Aktív: `public.html` |
| 12 | `frontend\rent\public.lab-proxy-validation.html` | G_BACKUP_DUPLICATE | Nem | LAB validáció másolat |
| 13 | `frontend\rent\public_lab_restore_test.html` | G_BACKUP_DUPLICATE | Nem | LAB restore másolat |
| 14 | `backup\fronted_rent_260625.zip` | G_BACKUP_DUPLICATE | Nem | Archív zip, nem runtime |

**Összesen:** ~140 fájl

## NEM mozgatandó (KEEP)

- `frontend/rent/public.html` és összes aktív Rent runtime
- `backend/tests/rent_api_smoke_test.ps1` — regressziós teszt
- `backend/server.js`, `package.json`, `render.yaml`
- `node_modules/`, `frontend/`, `backend/data/` (DB)
- `docs/`, `README.md`
- `I_UNKNOWN` kategória minden egyéb fájl

## Visszaállítás

```powershell
$q = "D:\cursor\Labor\_quarantine\operativ-navigator_260614_cleanup_20260626_201630"
$root = "D:\cursor\operativ-navigator_260614"
robocopy $q $root /E /MOV
```

Vagy manifest alapján fájlonként: `CLEANUP_MOVE_MANIFEST.csv`

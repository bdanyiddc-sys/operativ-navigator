# CLEANUP_MOVE_MANIFEST

**Dátum:** 2026-06-26  
**Mozgatott fájlok:** 140  
**Karantén:** `D:\cursor\Labor\_quarantine\operativ-navigator_260614_cleanup_20260626_201630\`

## Kategóriánként

| Kategória | Darab |
|-----------|-------|
| E_TEST_AUDIT (`backend/audit/` + root `*.mjs`) | 38 |
| H_TEMP_OUTPUT (`backend/test-output/` + tmp) | 98 |
| G_BACKUP_DUPLICATE (rent backup HTML + zip) | 4 |

## SHA256 ellenőrzés

Minden tételnél `sha256_before` = `sha256_after` (byte-azonos mozgatás).

## Teljes lista

`CLEANUP_MOVE_MANIFEST.csv` — 140 sor, oszlopok: old_path, new_path, sha256_before, sha256_after, size_bytes, category, reason, restore_command

## Visszaállítás (teljes)

```powershell
$q = "D:\cursor\Labor\_quarantine\operativ-navigator_260614_cleanup_20260626_201630"
$root = "D:\cursor\operativ-navigator_260614"
robocopy $q $root /E /MOV
```

## Visszaállítás (egy fájl)

Lásd `restore_command` oszlop a CSV-ben.

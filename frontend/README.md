# Operativ Navigator – Frontend

Egy Netlify projekt, három felület.

| Mappa | Útvonal | Szerep |
|-------|---------|--------|
| `public/` | `/public/` | Utasinformáció |
| `driver/` | `/driver/` | Sofőr PWA |
| `admin/` | `/admin/` | Admin felület |

## Konfiguráció

- **`opnav-config.js`** – éles Render API URL (`window.OPNAV_API_BASE`)
- **`netlify.toml`** – útvonalak és publish beállítás
- **`manifest.json`** + **`service-worker.js`** – Driver PWA

Részletes deploy: [DEPLOY.md](./DEPLOY.md)

## Local

| App | Port | API |
|-----|------|-----|
| Public | 3456 | localhost:3000 |
| Driver | 8000 | localhost:3000 |
| Admin (backend) | 3000 | localhost:3000 |

Teljes struktúra teszt: `npx serve -l 8888` a `frontend/` mappában.

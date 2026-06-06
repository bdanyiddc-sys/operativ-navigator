# Operativ Navigator – Deploy útmutató

Egy GitHub repo, egy Netlify frontend, egy Render backend.

## Repo struktúra

```
operativ-navigator/
├── frontend/          ← Netlify publish directory
│   ├── public/      ← Utas ( /public/ )
│   ├── driver/      ← Sofőr ( /driver/ )
│   ├── admin/       ← Admin ( /admin/ )
│   ├── manifest.json
│   ├── service-worker.js
│   ├── opnav-config.js
│   └── netlify.toml
└── backend/           ← Render root directory
    ├── server.js
    ├── package.json
    └── render.yaml
```

---

## 1. GitHub feltöltés

1. Klónozd vagy hozd létre a repót: `https://github.com/bdanyiddc-sys/operativ-navigator`
2. Másold a teljes mappastruktúrát ( `frontend/` + `backend/` ) a repo gyökerébe.
3. **Ne** töltsd fel: `node_modules/`, `*.db`, `.env`
4. Commit + push:

```bash
git add frontend backend
git commit -m "Deploy struktúra: frontend (Netlify) + backend (Render)"
git push origin main
```

---

## 2. Netlify (frontend)

1. [Netlify](https://app.netlify.com) → **Add new site** → **Import an existing project**
2. GitHub: `bdanyiddc-sys/operativ-navigator`
3. Beállítások:
   - **Base directory:** *(üres – repo gyökér)*
   - **Publish directory:** `frontend`
   - **Build command:** *(üres)*
4. Deploy.

### Elérési utak

| Felület | URL |
|---------|-----|
| Utas (Public) | `https://<domain>/public/` |
| Sofőr (Driver) | `https://<domain>/driver/` |
| Admin | `https://<domain>/admin/` |

A gyökér (`/`) automatikusan a `/public/`-ra irányít.

### PWA (Driver)

- iPhone Safari: **Megosztás → Hozzáadás a Főképernyőhöz**
- Android Chrome: **Install App** / telepítés prompt

---

## 3. Render (backend)

1. [Render](https://render.com) → **New → Web Service**
2. GitHub repo: `operativ-navigator`
3. Beállítások:
   - **Root Directory:** `backend`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
4. A `render.yaml` tartalmazza a SQLite persistent disk konfigurációt (`/var/data/events.db`).
5. Deploy után másold ki a URL-t, pl.:
   `https://operativ-navigator.onrender.com`

---

## 4. API_BASE átállítása (Render URL)

Élesben a frontend **nem** a Netlify domain API-ját hívja, hanem a Render backendet.

### Automatikus (alapértelmezett)

A `frontend/opnav-config.js` éles hoston beállítja:

```javascript
window.OPNAV_API_BASE = 'https://operativ-navigator.onrender.com';
```

Localhost-on (`localhost`, `127.0.0.1`) **nem** ír felül – minden frontend továbbra is `http://localhost:3000`-t használ.

### Manuális felülírás

Ha más Render URL-ed van, szerkeszd:

`frontend/opnav-config.js`

vagy injektáld HTML-ben deploy előtt:

```html
<script>window.OPNAV_API_BASE = 'https://YOUR-BACKEND.onrender.com';</script>
```

Minden frontend ezt a mintát használja:

```javascript
const API_BASE = window.OPNAV_API_BASE || getApiBase();
```

---

## 5. Local fejlesztés (változatlan)

| Felület | URL | API |
|---------|-----|-----|
| Backend + Admin | http://localhost:3000/admin.html | localhost:3000 |
| Driver | http://localhost:8000 | localhost:3000 |
| Public | http://localhost:3456 | localhost:3000 |

Backend indítás:

```bash
cd backend
npm install
npm start
```

Teljes Netlify struktúra lokálisan (opcionális):

```bash
cd frontend
npx serve -l 8888
# → http://localhost:8888/public/
# → http://localhost:8888/driver/
# → http://localhost:8888/admin/
```

---

## 6. Kézi Netlify feltöltés (tartalék)

Ha GitHub nélkül szeretnéd feltölteni a frontendet, használd:

`operativ-navigator-frontend.zip`

Netlify → **Deploy manually** → húzd be a zip tartalmát (a `frontend/` mappa tartalma).

---

## Ellenőrzőlista

- [ ] Render backend fut, `/api/health` OK
- [ ] `opnav-config.js` Render URL helyes
- [ ] `/public/` – utas térkép, foglalás
- [ ] `/driver/` – GPS, értesítések, PWA telepítés
- [ ] `/admin/` – térkép, foglalások, üzemeltetés
- [ ] CORS: backend `cors()` engedélyezi a Netlify origin-t

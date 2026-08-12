# Deploying the frontend

## The convention

Every app on this Pi follows the same split, and VoiceBite matches it:

```
<name>.billmill.dev   backend   Cloudflare Tunnel -> Pi -> localhost:<port>
<name>.web.app        frontend  Firebase Hosting (static build)
```

For VoiceBite:

| | |
|---|---|
| `https://voicebite.billmill.dev` | the API — Express under PM2 on port 3000 |
| `https://voicebite.web.app` | the app — this `web/` build on Firebase Hosting |

The backend never moves. Deploying the frontend does not touch the Pi.

## Deploying

```sh
cd web
npm run build                    # type-checks, then writes dist/
firebase deploy --only hosting   # goes to the "voicebite" site
```

That's it. `.env.production` sets `VITE_API_BASE=https://voicebite.billmill.dev`, so the
built bundle knows where the API is.

## The thing that will bite you

**The Firebase hostname comes from the SITE id, not the project id.**

This project is `voicebite-bpmiller`, but the Hosting site is `voicebite` — those are two
different namespaces. Getting them confused is what produced a "Can't reach the server"
banner on a completely healthy Pi: the browser was sending `Origin:
https://voicebite-bpmiller.web.app`, which wasn't in the server's allow-list, so every
request was blocked while `curl` from the Pi worked perfectly.

Firebase also serves each site at `<site-id>.firebaseapp.com`, so **both** hostnames need
to be in `ALLOWED_ORIGINS` in `server/.env`:

```
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,https://voicebite.web.app,https://voicebite.firebaseapp.com
```

Change the site and you must change that too, then `pm2 restart VoiceBite`.

**A rejected origin is logged**, so this is now a ten-second diagnosis rather than a hunt:

```sh
grep CORS /home/billy/VoiceBite/server/logs/voicebite.log
# -> origin: https://whatever.web.app   allowedOrigins: [ ... ]
```

## Multiple sites in one project

The project holds two Hosting sites. Only `voicebite` serves anything:

| Site | URL | State |
|---|---|---|
| `voicebite` | https://voicebite.web.app | live — the deploy target |
| `voicebite-bpmiller` | https://voicebite-bpmiller.web.app | **disabled** — returns "Site Not Found" |

`voicebite-bpmiller` is the project's default site, created automatically with the project.
Firebase **cannot delete a default site** (`Cannot delete default Hosting Site`), so it is
disabled instead — which takes it out of service just as completely.

The one thing to know: **`firebase deploy` re-enables a disabled site if it targets it.**
That can't happen by accident here, because `firebase.json` sets `"target": "app"` and
`.firebaserc` maps that to `voicebite`. Don't deploy with `--site voicebite-bpmiller` or
the old URL comes back.

To disable it again if it ever does:

```sh
firebase hosting:disable --site voicebite-bpmiller
```

## Two audiences, one deploy

`https://voicebite.web.app` serves both:

- **signed out** — demo mode, synthetic data generated in the browser relative to today
- **signed in** — the real log on the Pi, gated by a password

Only the second talks to the authenticated API, so a portfolio visitor never touches real
data and never needs a login.

## Local development

```sh
cd web && npm run dev     # http://localhost:5173
```

The dev server proxies `/api` to `localhost:3000`, so the browser sees a single origin and
CORS never applies. That's why a bad allow-list only ever shows up in production.

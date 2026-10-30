# Senior Master Carwash - Vercel version

One Vercel project = customer site + admin + API. Bookings are saved in your Turso database (tables are created automatically on first use).
Because everything is on the same address there is no CORS problem and no "your_api_address" to fill in.

```
public/   customer site (index.html) and admin (admin.html, admin-calendar.html) + their js/css, catalog.js (prices)
api/      [...path].js = the whole API (one function)
lib/      db.js = Turso database helper
```

## Deploy (about 10 minutes)
1. Put these files in a GitHub repo (keep the folders as they are). Import the repo in Vercel > Add New > Project. Leave all build settings empty. Deploy.
2. Connect Turso. Easiest: in the Vercel project open **Storage / Marketplace > Turso**, connect your database to this project (it adds the variables for you).
   Or add them yourself in Settings > Environment Variables:
   - `TURSO_DATABASE_URL` = your database URL, like `libsql://your-db-yourname.turso.io`
   - `TURSO_AUTH_TOKEN` = a token for that database (Turso dashboard > your database > Create token, or `turso db tokens create your-db`)
3. Project > **Settings > Environment Variables**, add:
   - `ADMIN_PASSWORD` = your admin password (8+ characters) - required
   - `MAX_PER_SLOT` = `10` (optional, default 10)
   - `ADMIN_HOST` = `admin.yourdomain.com` (optional, see below)
4. **Deployments > Redeploy** so the variables take effect.
5. Open your site. Admin is at `/admin.html`.

## Separate admin domain (optional)
1. Project > Settings > Domains: add `yourdomain.com` and `admin.yourdomain.com` to this same project.
2. Set `ADMIN_HOST` = `admin.yourdomain.com`. The admin API then answers only on that domain (404 on the customer domain).
3. To open admin straight from `admin.yourdomain.com/`, add this to `vercel.json`:
```
"rewrites": [ { "source": "/", "has": [ { "type": "host", "value": "admin.yourdomain.com" } ], "destination": "/admin.html" } ]
```
Both domains use the same database, so they are always connected.

## What it does
- Open 24 hours, one slot per hour, maximum cars per hour = `MAX_PER_SLOT` (10). Enforced in the database, so two customers can never take the last spot. Cancelling frees the spot.
- Customer page shows open spots for every hour, and My Bookings updates when admin confirms, completes or cancels.
- Admin: Bookings (Confirm / Mark completed with final amount / Cancel / Edit amount / Export CSV), Earnings (totals, graph per month or per year), Calendar (month view + 24-hour day view).

## Notes
- Times use Philippine time (UTC+8). Change with `TZ_OFFSET_HOURS` if needed.
- The AI chat reply is not included here; the page uses its built-in reply.
- You can delete the old customer project and the old API project once this one works, and move your domains here.

# Kinship Combat: put it on YOUR Cloudflare (free, browser only)

You need: a Cloudflare account (free) and the GitHub account that owns The-Kinship.
No command line, no installs. About 20 minutes. (Cloudflare changes button names now and
then; if one looks different, send me a screenshot.)

## 1. Make a free Cloudflare account
https://dash.cloudflare.com/sign-up  (use the Kinship email, so it's never tied to one person)

## 2. Put this folder on GitHub
1. On github.com (signed in as The-Kinship): New repository, name it `kinship-combat`, Public or Private, Create.
2. Unzip this folder on your computer. Click "uploading an existing file", drag in EVERYTHING
   from inside the folder (src, public, migrations, test, wrangler.jsonc, package.json, .gitignore).
3. Commit.

## 3. Make the database
1. Cloudflare dashboard > Storage & databases > D1 SQL database > Create database.
2. Name: `kinship-combat-db`. Create.
3. Copy the **Database ID** (a long code like 1a2b3c4d-....).
4. Open the database's **Console** tab. Open `migrations/0001_init.sql` from this folder, copy all of it,
   paste it into the console, and run it. (It makes two tables: rooms and rate_limits.)

## 4. Tell the project which database is yours
On GitHub, open `wrangler.jsonc`, click the pencil (edit), replace `PASTE-YOUR-DATABASE-ID-HERE`
with the ID you copied (keep the quote marks), Commit.

## 5. Connect and launch
1. Cloudflare dashboard > Workers & Pages > Create > Import a repository (connect GitHub, allow it
   to see `kinship-combat`).
2. Pick the repo. Leave the defaults (deploy command `npx wrangler deploy`). The project name must stay `kinship-combat`.
3. Save and Deploy. When it finishes you get an address like
   `https://kinship-combat.YOURNAME.workers.dev`.

## 6. Check it
Open the address. You should land on the Kinship Combat table. Create a room, then open the
invite link on a second device or private window and join.

## 7. Send me the address
I put it in the site's `COMBAT_URL` and the Kinship Combat banner on the home page goes live.

## Later changes
Edit any file on GitHub and commit. Cloudflare redeploys automatically in about a minute.

## Free limits (checked Oct 2026)
Workers Free: 100,000 requests/day; static files are free. D1 Free: 5 million rows read/day,
100,000 rows written/day, 5 GB. The table checks for updates every 2 seconds, so one open
player is roughly 1,800 requests an hour: about 55 player-hours a day. If a limit is hit, it
just resets at 00:00 UTC; nothing is lost.

## Good to know
- Rooms are capped at 500 total and 40 people each (set in `src/api.mjs`).
- The old site and this one have separate rooms; they do not share data.

# Meridian — Trip Planner

A shared trip planner that works anywhere in the world. Everyone on the trip
adds themselves, plans their hotels and stays, pins activities and photo spots
on the map, and sees each other's plans side by side to find days that overlap.
Deep hand-curated recommendations cover Japan, Korea, China, Thailand, the UK,
France, Italy, Spain, and Germany; everywhere else, the Explore tab pulls
nearby sights live from Wikipedia around wherever you're staying. Toggle which
countries the trip covers on the Checklist tab.

It's a plain website — one HTML file plus two small scripts. No build tools,
no server of your own to run.

## Sharing it with family & friends

The deployed site is all anyone needs — no setup on their end:

1. Send them `about.html` (the landing page) or straight to
   `index.html?demo=1` — a sandboxed **demo trip** they can safely poke at,
   living only in their browser.
2. When they're ready, they create a trip (or you send them your trip's
   **invite link** from the Trips menu) and follow the **First steps** card.

Privacy in one sentence: trip data is visible to anyone with that trip's
invite link and nobody else, so share links only with your group and keep
sensitive numbers (passports, bookings) out of notes. Anyone can download
their trip as JSON from the Trips menu.

## Trips and legs

- **Separate trips** — the **Trips** button in the header switches between
  trips or creates a new one. Friends who type the same trip name land in the
  same shared trip. Each trip has its own people, plans, dates, currency, and
  expenses.
- **Side-trip legs** — on the **Prep** tab, "+ Add leg" marks a date window as
  another country inside the same trip (say, four Korea days mid-Japan).
  Those days get flagged across the app and that country's checklist items
  switch on automatically.

## Try it right now

Open `index.html` in any browser. That's it. Your plans save automatically in
that browser.

## Put it online (free, ~2 minutes)

The easiest way is GitHub Pages, since the code already lives in this repo:

1. On GitHub, open this repository → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to "Deploy from a branch",
   pick your main branch and the `/ (root)` folder, and click **Save**.
3. After a minute your site is live at
   `https://<your-username>.github.io/Itinerary/`.
   Send that link to your friends.

Any time you change the files and push, the site updates itself.

## Turn on live sharing with friends (free, ~10 minutes)

Out of the box, each person's plans stay in their own browser and the header
shows "Saved to this browser only". To make everyone see each other's plans on
the same map, connect a free Firebase database:

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
   and sign in with a Google account.
2. Click **Create a project** (any name, e.g. "japan-trip"). You can turn off
   Google Analytics when asked — it's not needed.
3. In the left sidebar open **Build → Realtime Database**, click
   **Create database**, pick the location closest to you, and choose
   **Start in locked mode**.
4. Open the **Rules** tab, replace the contents with the following, and click
   **Publish**:

   ```json
   {
     "rules": {
       "trips": {
         "$trip": {
           ".read": true,
           ".write": true
         }
       }
     }
   }
   ```

   These rules allow access to a trip only if you know its exact ID — nobody
   can list all trips in the database. New trips get unguessable IDs, so the
   **Copy invite** link in the Trips menu is how friends get in. (If you used
   the older rules with `.read`/`.write` directly under `trips`, switch to
   these.)

5. Back on the **Data** tab, copy the database URL shown at the top — it looks
   like `https://japan-trip-default-rtdb.asia-southeast1.firebasedatabase.app`.
   (Pasting the console page's address from your browser bar works too — the
   site figures out the real database URL from it.)
6. Open `config.js` in this repo and paste that URL as the `firebaseUrl`
   value, then commit/push (or just save, if you're running it locally).

Reload the site and the "Saved to this browser only" note disappears.
Everyone who opens the site now shares the same trip — changes show up for
the others within about 20 seconds.

**A note on privacy:** those rules let anyone who discovers your database URL
read and edit the trip data. For a trip planner shared among friends that's
usually fine, but don't put anything sensitive in it (passport numbers,
booking references, etc.).

## Running the tests

`node tests/run.js` runs unit tests on the app's core functions plus
end-to-end flows (adding plans, transit, currency display, two-user sync) in
headless Chromium, with all external services mocked. It needs Playwright:
`npm i playwright && npx playwright install chromium`.

## The files

| File | What it is |
| --- | --- |
| `index.html` | The whole app — layout, styles, map, and planner logic. |
| `config.js` | The only file you edit: Firebase URL and trip name. |
| `storage.js` | Saves data to Firebase when configured, otherwise to the browser. |

## Getting a copy onto your computer

From a terminal (PowerShell on Windows):

```
git clone https://github.com/ZBelohlavek/Itinerary "C:\Users\Zacha\OneDrive\Desktop\Japan Trip"
```

Or on the GitHub page click **Code → Download ZIP** and unzip it into that
folder.

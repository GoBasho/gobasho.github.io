# Basho — Trip Planner

Named for Matsuo Basho, the wandering poet who walked Japan writing about
every stop — and for the Japanese word *basho*, "place."

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

1. Send them the site (or `about.html`, the landing page). First-time
   visitors get a welcome screen where they **create their own trip** —
   name it, pick a destination, done — or **paste an invite link** to join
   someone else's. A sandboxed demo trip is one click away for the curious.
2. The **First steps** card walks them through adding themselves, a stay,
   a plan, and copying their trip's invite link to share with each other.

Privacy in one sentence: trip data is visible to anyone with that trip's
invite link and nobody else, so share links only with your group and keep
sensitive numbers (passports, bookings) out of notes. Anyone can download
their trip as JSON from the Trips menu.

## Trains

The **Trains** tab plans the rail legs between your bases:

- **Journeys your stays imply** — every move from one base to the next (plus
  day trips) is worked out from your stays and listed with its distance and a
  rough travel time. Each one shows whether a train is already on the
  itinerary, and the sidebar nudges you about the ones that aren't.
- **Connection lookup** — search any two stations for a day, either "depart
  after" or "arrive by". Results show departure and arrival, duration, how
  many changes, and the trains by name, with high-speed services highlighted.
  One tap adds a connection to your itinerary as a transit plan, pinned to the
  arrival station.
- **No timetable data?** Departures come from [Transitous](https://transitous.org),
  a free community service over open GTFS feeds — coverage is strong in Japan,
  Korea, and Europe and patchier elsewhere. Where there's none, the tab offers
  a distance-based estimate you can still block into the day.

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
4. Enable invisible identities: in the Firebase console go to
   **Build → Authentication → Get started → Sign-in method** and enable
   **Anonymous**. Then register a web app (Project settings → General →
   Your apps → web) and put its `apiKey` into `config.js`. Nobody ever sees
   a login screen — each browser just gets a stable hidden identity.
5. Open the **Rules** tab, replace the contents with the following, and click
   **Publish** (only after step 4, or writes will start failing):

   ```json
   {
     "rules": {
       "trips": {
         "$trip": {
           ".read": "auth != null",
           "trip%3Ameta": { ".write": "auth != null" },
           "$record": {
             ".write": "auth != null && (!data.exists() || !data.child('uid').exists() || data.child('uid').val() === auth.uid || root.child('trips').child($trip).child('trip%3Ameta').child('ownerUid').val() === auth.uid)"
           }
         }
       },
       "users": {
         "$user": {
           ".read": "auth != null && auth.uid === $user",
           ".write": "auth != null && auth.uid === $user"
         }
       }
     }
   }
   ```

   The `users` block backs the account trip list: every trip you open is
   pinned to your identity at `users/<uid>/trips`, so signing in with
   Google on a new device brings your whole trip list with you (shown on
   the welcome screen and in the Trips menu). Each account can only read
   and write its own list. Without this block the app still works — the
   trip list just stays per-browser.

   The last clause lets a trip's creator remove stray travelers (the ✕ next
   to names in the sidebar). It only activates on trips created after the
   ownership feature, and requires the trip settings to have been saved in
   the new object format. Trips with no recorded owner (older trips, or
   local-only mode) show the ✕ to everyone; with these locked rules the
   database still refuses the write unless it comes from the trip's creator,
   and the app says so instead of pretending it worked.

   What these enforce: a trip is reachable only with its exact ID (no
   listing the database), only the app's signed-in visitors can read or
   write at all, anyone on the trip can edit the shared trip settings, and
   **each traveler's own record can only be modified by the browser that
   created it**. Records saved before this upgrade have no owner stamp yet;
   they become owned the next time that person saves anything.

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

## Optional: Google sign-in for editing from any device (~3 minutes)

Out of the box each browser gets its own invisible identity, so your plans
are only editable from the browser that created them. Turn on Google
sign-in and anyone can edit their plans from every device they sign in on
— phone, laptop, anywhere. Still free (Firebase's free tier covers 50,000
monthly users), and nobody is forced to sign in: anonymous stays the
default.

1. In the Firebase console: **Authentication → Sign-in method →
   Add new provider → Google** → enable it, pick your support email, save.
2. On that same Google panel, expand **Web SDK configuration** and copy the
   **Web client ID** (ends in `.apps.googleusercontent.com`). Paste it as
   the `googleClientId` value in `config.js` and push.
3. **Authentication → Settings → Authorized domains** → add the domain the
   site runs on (e.g. `your-username.github.io`). `localhost` is already
   allowed for local testing.

A "Sign in with Google" button then appears in everyone's profile window
(and the Trips menu). **Order matters the first time:** sign in first on
the device that already has your plans — that upgrades its invisible
identity to your Google account and keeps ownership of everything you've
written. After that, signing in on any other device gives it the same
identity automatically. (Sign in on a brand-new device first and it gets a
fresh identity that can't edit records made before — the app warns when
that happens.)

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
git clone https://github.com/GoBasho/gobasho.github.io "C:\Users\Zacha\OneDrive\Desktop\Japan Trip"
```

Or on the GitHub page click **Code → Download ZIP** and unzip it into that
folder.

# Meridian — Japan Trip Planner

A shared trip planner for Japan. Everyone on the trip adds themselves, plans
their hotels and stays, pins activities and photo spots on the map, and sees
each other's plans side by side to find days that overlap.

It's a plain website — one HTML file plus two small scripts. No build tools,
no server of your own to run.

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
         ".read": true,
         ".write": true
       }
     }
   }
   ```

5. Back on the **Data** tab, copy the database URL shown at the top — it looks
   like `https://japan-trip-default-rtdb.asia-southeast1.firebasedatabase.app`.
6. Open `config.js` in this repo and paste that URL as the `firebaseUrl`
   value, then commit/push (or just save, if you're running it locally).

Reload the site and the "Saved to this browser only" note disappears.
Everyone who opens the site now shares the same trip — changes show up for
the others within about 20 seconds.

**A note on privacy:** those rules let anyone who discovers your database URL
read and edit the trip data. For a trip planner shared among friends that's
usually fine, but don't put anything sensitive in it (passport numbers,
booking references, etc.).

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

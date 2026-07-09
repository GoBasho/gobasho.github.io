/*
 * Storage adapter for Meridian.
 *
 * The app talks to a tiny key/value API: get(key, shared), set(key, value,
 * shared), list(prefix, shared). "shared" data is the trip everyone sees;
 * non-shared data (your own profile pointer) always stays in this browser.
 *
 * Shared data goes to a Firebase Realtime Database when config.js provides
 * one; otherwise it falls back to localStorage so the planner still works
 * for a single person with zero setup.
 *
 * config.js accepts EITHER the database's own URL
 * (https://<name>.firebaseio.com or https://<name>.<region>.firebasedatabase.app)
 * OR a Firebase console link (https://console.firebase.google.com/...) —
 * for console links the database name is extracted and Firebase itself is
 * asked for the correct regional address on first load, then cached.
 */
(function () {
  const cfg = window.MERIDIAN_CONFIG || {};
  const raw = String(cfg.firebaseUrl || "").trim();
  const defaultTrip = cfg.tripId || "our-japan-trip";
  // the active trip is a per-browser choice; config.js only sets the default
  let tripId = defaultTrip;
  try { tripId = localStorage.getItem("meridian:active-trip") || defaultTrip; } catch {}

  // Firebase paths can't contain . $ # [ ] or /, so keys are URI-encoded
  // (with "." encoded too, since encodeURIComponent leaves it alone).
  function encodeKey(k) {
    return encodeURIComponent(k).replace(/\./g, "%2E");
  }
  function decodeKey(k) {
    return decodeURIComponent(k);
  }

  const LS_PREFIX = "meridian:" + tripId + ":";
  function localGet(key) {
    const v = localStorage.getItem(LS_PREFIX + key);
    return v === null ? null : { key, value: v };
  }
  function localSet(key, value) {
    localStorage.setItem(LS_PREFIX + key, value);
    return { key, value };
  }
  function localList(prefix) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX + prefix)) keys.push(k.slice(LS_PREFIX.length));
    }
    return { keys };
  }

  /* ---- work out the real database URL from whatever was pasted ---- */
  let dbUrl = null; // e.g. "https://name.firebaseio.com", no trailing slash
  let mode = "local";

  function originOf(u) {
    const m = u.match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : null;
  }
  function consoleDbName(u) {
    let m = u.match(/console\.firebase\.google\.com\/.*?\bdatabase\/([A-Za-z0-9-]+)/i);
    if (m) return m[1];
    m = u.match(/console\.firebase\.google\.com\/(?:u\/\d+\/)?project\/([A-Za-z0-9-]+)/i);
    if (m) return m[1] + "-default-rtdb";
    return null;
  }

  const ready = (async function init() {
    if (!raw) return;
    const origin = originOf(raw);
    if (origin && /(\.firebaseio\.com|\.firebasedatabase\.app)$/i.test(origin) ||
        /^http:\/\/localhost[:/]/.test(raw)) {
      dbUrl = (origin || raw).replace(/\/+$/, "");
      mode = "shared";
      return;
    }
    const dbName = consoleDbName(raw);
    if (!dbName) return; // unrecognized — stay local rather than guess
    const cached = localStorage.getItem("meridian:resolved-db:" + dbName);
    if (cached) { dbUrl = cached; mode = "shared"; return; }
    // ask the default (US) endpoint; if the database lives elsewhere,
    // Firebase's error message contains the correct regional URL
    const guess = "https://" + dbName + ".firebaseio.com";
    try {
      const res = await fetch(guess + "/.json?shallow=true");
      const body = await res.text();
      if (res.ok) dbUrl = guess;
      else {
        const m = body.match(/https:\/\/[a-z0-9.-]+\.firebasedatabase\.app/i);
        if (m) dbUrl = m[0];
        else if (res.status === 401 || /permission/i.test(body)) dbUrl = guess; // right host, locked rules
      }
    } catch { /* offline or blocked — stay local this session */ }
    if (dbUrl) {
      localStorage.setItem("meridian:resolved-db:" + dbName, dbUrl);
      mode = "shared";
    }
  })();

  /* ---- Firebase REST operations ---- */
  function base() {
    return dbUrl + "/trips/" + encodeKey(tripId);
  }
  async function fbGet(key) {
    const res = await fetch(base() + "/" + encodeKey(key) + ".json");
    if (!res.ok) throw new Error("Sync read failed (" + res.status + ")");
    const value = await res.json();
    return value === null ? null : { key, value };
  }
  async function fbSet(key, value) {
    const res = await fetch(base() + "/" + encodeKey(key) + ".json", {
      method: "PUT",
      body: JSON.stringify(value)
    });
    if (!res.ok) throw new Error("Sync write failed (" + res.status + ")");
    return { key, value };
  }
  async function fbList(prefix) {
    const res = await fetch(base() + ".json?shallow=true");
    if (!res.ok) throw new Error("Sync list failed (" + res.status + ")");
    const obj = (await res.json()) || {};
    return { keys: Object.keys(obj).map(decodeKey).filter((k) => k.startsWith(prefix)) };
  }

  window.storage = {
    get mode() { return mode; },
    get tripId() { return tripId; },
    /* pick another trip for this browser (takes effect on reload) */
    switchTrip(id) {
      try { localStorage.setItem("meridian:active-trip", id); } catch {}
    },
    /* every trip id present in the database (or this browser, in local mode) */
    async listTrips() {
      await ready;
      if (mode === "shared") {
        const res = await fetch(dbUrl + "/trips.json?shallow=true");
        if (!res.ok) throw new Error("Trip list failed (" + res.status + ")");
        const obj = (await res.json()) || {};
        return Object.keys(obj).map(decodeKey);
      }
      const ids = new Set();
      for (let i = 0; i < localStorage.length; i++) {
        const m = (localStorage.key(i) || "").match(/^meridian:(.+):trip:meta$/);
        if (m) ids.add(m[1]);
      }
      return [...ids];
    },
    /* read/write a key in a trip other than the active one */
    async getFrom(tid, key) {
      await ready;
      if (mode === "shared") {
        const res = await fetch(dbUrl + "/trips/" + encodeKey(tid) + "/" + encodeKey(key) + ".json");
        if (!res.ok) return null;
        const value = await res.json();
        return value === null ? null : { key, value };
      }
      const v = localStorage.getItem("meridian:" + tid + ":" + key);
      return v === null ? null : { key, value: v };
    },
    async putIn(tid, key, value) {
      await ready;
      if (mode === "shared") {
        const res = await fetch(dbUrl + "/trips/" + encodeKey(tid) + "/" + encodeKey(key) + ".json", {
          method: "PUT", body: JSON.stringify(value)
        });
        if (!res.ok) throw new Error("Trip write failed (" + res.status + ")");
        return { key, value };
      }
      localStorage.setItem("meridian:" + tid + ":" + key, value);
      return { key, value };
    },
    async get(key, shared) {
      await ready;
      return shared && mode === "shared" ? fbGet(key) : localGet(key);
    },
    /* fetch every key under the trip in ONE request — the sync poll uses this
       instead of a list call followed by a get per traveler */
    async getAll(prefix, shared) {
      await ready;
      if (shared && mode === "shared") {
        const res = await fetch(base() + ".json");
        if (!res.ok) throw new Error("Sync read failed (" + res.status + ")");
        const obj = (await res.json()) || {};
        const out = {};
        for (const k of Object.keys(obj)) {
          const dk = decodeKey(k);
          if (dk.startsWith(prefix)) out[dk] = obj[k];
        }
        return out;
      }
      const out = {};
      for (const k of localList(prefix).keys) out[k] = localStorage.getItem(LS_PREFIX + k);
      return out;
    },
    async set(key, value, shared) {
      await ready;
      return shared && mode === "shared" ? fbSet(key, value) : localSet(key, value);
    },
    async list(prefix, shared) {
      await ready;
      return shared && mode === "shared" ? fbList(prefix) : localList(prefix);
    }
  };
})();

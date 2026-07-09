/*
 * Storage adapter for Meridian.
 *
 * The app talks to a tiny key/value API: get(key, shared), set(key, value,
 * shared), list(prefix, shared). "shared" data is the trip everyone sees;
 * non-shared data (your own profile pointer) always stays in this browser.
 *
 * Shared data goes to a Firebase Realtime Database when config.js provides
 * a firebaseUrl; otherwise it falls back to localStorage so the planner
 * still works for a single person with zero setup.
 */
(function () {
  const cfg = window.MERIDIAN_CONFIG || {};
  const dbUrl = String(cfg.firebaseUrl || "").replace(/\/+$/, "");
  const tripId = cfg.tripId || "our-japan-trip";
  const useFirebase = /^https:\/\//.test(dbUrl) || /^http:\/\/localhost[:/]/.test(dbUrl);

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

  const base = dbUrl + "/trips/" + encodeKey(tripId);
  async function fbGet(key) {
    const res = await fetch(base + "/" + encodeKey(key) + ".json");
    if (!res.ok) throw new Error("Sync read failed (" + res.status + ")");
    const value = await res.json();
    return value === null ? null : { key, value };
  }
  async function fbSet(key, value) {
    const res = await fetch(base + "/" + encodeKey(key) + ".json", {
      method: "PUT",
      body: JSON.stringify(value)
    });
    if (!res.ok) throw new Error("Sync write failed (" + res.status + ")");
    return { key, value };
  }
  async function fbList(prefix) {
    const res = await fetch(base + ".json?shallow=true");
    if (!res.ok) throw new Error("Sync list failed (" + res.status + ")");
    const obj = (await res.json()) || {};
    return { keys: Object.keys(obj).map(decodeKey).filter((k) => k.startsWith(prefix)) };
  }

  window.storage = {
    mode: useFirebase ? "shared" : "local",
    async get(key, shared) {
      return shared && useFirebase ? fbGet(key) : localGet(key);
    },
    async set(key, value, shared) {
      return shared && useFirebase ? fbSet(key, value) : localSet(key, value);
    },
    async list(prefix, shared) {
      return shared && useFirebase ? fbList(prefix) : localList(prefix);
    }
  };
})();

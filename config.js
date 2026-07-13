/*
 * Meridian configuration — the only file you ever need to edit.
 *
 * SHARING WITH FRIENDS (optional, ~10 minutes, free):
 * Out of the box the planner saves everything in your own browser only.
 * To let everyone on the trip see each other's plans live, hook up a free
 * Firebase Realtime Database and paste its URL below. Full step-by-step
 * instructions are in README.md.
 */
window.MERIDIAN_CONFIG = {
  // Paste your Firebase Realtime Database URL here to turn on live sharing —
  // either the database URL itself (shown at the top of the Data tab, e.g.
  // "https://our-japan-trip-default-rtdb.asia-southeast1.firebasedatabase.app")
  // or simply the console page link (console.firebase.google.com/...) — both work.
  // Leave as "" to keep everything local to each person's browser.
  firebaseUrl: "https://gojapan-2e7da-default-rtdb.firebaseio.com",

  // Web API key (public identifier, not a secret) — enables invisible
  // anonymous sign-in so database rules can enforce per-person ownership.
  apiKey: "AIzaSyAbY_uK-revIDNRSaycqfkdO5NJoETZ1V0",

  // OPTIONAL: Google sign-in, so each person can edit their plans from any
  // device they sign in on. Three steps in the Firebase console (~3 min):
  //   1. Authentication → Sign-in method → Add new provider → Google → enable.
  //   2. On that Google panel, expand "Web SDK configuration" and copy the
  //      Web client ID (ends in .apps.googleusercontent.com) here.
  //   3. Authentication → Settings → Authorized domains → add the domain the
  //      site runs on (e.g. zbelohlavek.github.io).
  // Leave as "" to keep invisible per-browser identities only.
  googleClientId: "",

  // A name that keeps your trip's data separate from anything else in the
  // database. Change it if you ever want to start a fresh trip.
  tripId: "our-japan-trip"
};

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

  // A name that keeps your trip's data separate from anything else in the
  // database. Change it if you ever want to start a fresh trip.
  tripId: "our-japan-trip"
};

#!/usr/bin/env node
/*
 * Meridian test suite: unit tests on the app's pure functions plus
 * end-to-end flows in headless Chromium, with Firebase, Photon,
 * Wikipedia, and exchange-rate APIs mocked locally.
 *
 * Run from the repo root:  node tests/run.js
 * Needs Playwright with Chromium (npm i playwright && npx playwright install chromium).
 */
const http = require("http"), fs = require("fs"), pth = require("path");
let chromium;
for (const p of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
  try { chromium = require(p).chromium; break; } catch {}
}
if (!chromium) { console.error("Playwright not found — npm i playwright && npx playwright install chromium"); process.exit(1); }

const ROOT = pth.join(__dirname, "..");
const MIME = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".png":"image/png" };
const site = http.createServer((req, res) => {
  const f = pth.join(ROOT, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(f, (err, data) => {
    if (err) { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", MIME[pth.extname(f)] || "text/plain");
    res.end(data);
  });
});

// minimal Firebase Realtime DB REST mock
const db = {};
const fb = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.end();
  const u = new URL(req.url, "http://x");
  const path = u.pathname.replace(/\.json$/, "");
  if (req.method === "PUT") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => { db[path] = JSON.parse(body); res.end(JSON.stringify(db[path])); });
  } else if (u.searchParams.get("shallow") === "true") {
    const kids = {};
    for (const k of Object.keys(db)) if (k.startsWith(path + "/")) kids[k.slice(path.length + 1).split("/")[0]] = true;
    res.end(Object.keys(kids).length ? JSON.stringify(kids) : "null");
  } else if (db[path] !== undefined) res.end(JSON.stringify(db[path]));
  else {
    const kids = {};
    for (const k of Object.keys(db)) if (k.startsWith(path + "/")) kids[k.slice(path.length + 1)] = db[k];
    res.end(Object.keys(kids).length ? JSON.stringify(kids) : "null");
  }
});

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}

async function newPage(browser, tripId, opts = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", e => { fail++; console.log("  FAIL pageerror: " + e.message); });
  await page.route("**/config.js", r => r.fulfill({ contentType: "application/javascript",
    body: `window.MERIDIAN_CONFIG={firebaseUrl:"${opts.shared ? "https://mock-rtdb.firebaseio.com" : ""}",tripId:"${tripId}"};` }));
  await page.route("https://mock-rtdb.firebaseio.com/**", async r => {
    const u = new URL(r.request().url());
    const res = await fetch("http://localhost:18898" + u.pathname + u.search,
      { method: r.request().method(), body: r.request().postData() || undefined });
    r.fulfill({ status: res.status, contentType: "application/json", body: await res.text() });
  });
  await page.route("https://open.er-api.com/**", r => r.fulfill({ contentType: "application/json",
    body: JSON.stringify({ result: "success", rates: { USD: 0.0068, EUR: 0.0060, JPY: 1 } }) }));
  await page.route("https://photon.komoot.io/**", r => r.fulfill({ contentType: "application/json", body: '{"features":[]}' }));
  await page.route("https://en.wikipedia.org/**", r => r.fulfill({ contentType: "application/json", body: '{"query":{"pages":{}}}' }));
  return page;
}

async function setupProfile(page, name) {
  await page.waitForSelector("#profileScrim.show");
  await page.fill("#profileName", name);
  await page.click(".swatch-grid button");
  await page.click("#profileSave");
  await page.waitForTimeout(300);
}

(async () => {
  await new Promise(r => site.listen(18899, r));
  await new Promise(r => fb.listen(18898, r));
  const browser = await chromium.launch();

  console.log("\n== unit tests (pure functions in page context) ==");
  {
    const page = await newPage(browser, "unit-test");
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#profileScrim.show");
    const u = await page.evaluate(() => {
      const r = {};
      r.haversineTokyoKyoto = haversine({lat:35.6762,lng:139.6503},{lat:35.0116,lng:135.7681});
      r.legWalk = classifyLeg(1.0).mode; r.legLocal = classifyLeg(5).mode;
      r.legRegional = classifyLeg(50).mode; r.legShink = classifyLeg(400).mode;
      r.isoRoundTrip = iso(parseISO("2026-09-08"));
      r.slug = slugTrip("Korea 2027!!");
      r.parseCostClean = parseCost("12,000"); r.parseCostEmpty = parseCost("");
      r.window = actWindow({date:"", flex:{type:"range", start:"2026-09-10", end:"2026-09-12"}});
      r.flexLbl = flexLabel({flex:{type:"options", days:["2026-09-09","2026-09-11"]}});
      r.wikiCat = [wikiCategory("buddhist temple in kyoto"), wikiCategory("public park"), wikiCategory("street market")];
      r.esc = esc('<b>&"');
      r.curatedLocal = (state.trip.countries=["JP"], curatedMatches("tower").every(x=>x.lng>100));
      r.curatedFallback = curatedMatches("tower of london").some(x=>x.label==="Tower of London");
      // expense math: A pays 9000 for all, B pays 3000 for [A,B] → B owes A 3000
      state.people = { A:{name:"A", expenses:[{id:"1",desc:"d",amount:9000,for:null}]},
                      B:{name:"B", expenses:[{id:"2",desc:"t",amount:3000,for:["A","B"]}]} };
      const bal = expenseBalances();
      r.settle = bal.transfers.map(t=>t.join("/")).join(";");
      // interests: tagging and Wikipedia matching
      r.tagPark = autoTag({name:"Tokyo Disneyland", blurb:"theme park", cat:"Sightseeing"}).includes("themepark");
      r.tagBeach = autoTag({name:"Kabira Bay", blurb:"turquoise lagoon beach", cat:"Nature"}).includes("beach");
      r.wikiHit = wikiMatches("buddhist temple in the mountains", ["temple","food"]).join(",");
      r.wikiMiss = wikiMatches("office tower", ["food"]).length;
      r.eventCost = CAT_COST["Event / show"] > 0;
      r.linkified = /<a href="https:\/\/x.jp"/.test(linkify(esc("book https://x.jp now")));
      // merge suggestions: two nearby acts on different days
      state.people = { A:{name:"A", activities:[
        {id:"x", date:"2026-09-08", location:{lat:35.69,lng:139.79}, time:"15:00"},
        {id:"y", date:"2026-09-10", location:{lat:35.66,lng:139.70}, time:""}]} };
      const s = mergeSuggestions(state.people.A);
      r.sugg = s.length===1 && mergeDirection(s[0])==="d1";  // keep the timed one anchored
      return r;
    });
    check("haversine Tokyo→Kyoto ≈ 366km", Math.abs(u.haversineTokyoKyoto - 366) < 12, u.haversineTokyoKyoto);
    check("classifyLeg boundaries", u.legWalk==="walk" && u.legLocal==="local" && u.legRegional==="regional" && u.legShink==="shink");
    check("iso() is timezone-safe", u.isoRoundTrip === "2026-09-08", u.isoRoundTrip);
    check("slugTrip", u.slug === "korea-2027", u.slug);
    check("parseCost", u.parseCostClean === 12000 && u.parseCostEmpty === "");
    check("actWindow enumerates range", u.window.join(",") === "2026-09-10,2026-09-11,2026-09-12", u.window);
    check("flexLabel options", u.flexLbl === "Sep 9 or Sep 11", u.flexLbl);
    check("wikiCategory mapping", u.wikiCat.join("|") === "Culture|Nature|Food & drink", u.wikiCat);
    check("esc escapes html", u.esc === "&lt;b&gt;&amp;&quot;");
    check("curated search prefers home region", u.curatedLocal === true);
    check("curated search falls back globally", u.curatedFallback === true);
    check("expense settlement B→A ¥3000", u.settle === "B/A/3000", u.settle);
    check("merge suggestion keeps timed day", u.sugg === true);
    check("autoTag theme parks & beaches", u.tagPark && u.tagBeach);
    check("wikiMatches finds interest in description", u.wikiHit === "Temples & shrines", u.wikiHit);
    check("wikiMatches ignores non-matches", u.wikiMiss === 0);
    check("Event category has a default cost", u.eventCost === true);
    check("notes linkify is safe", u.linkified === true);
    await page.context().close();
  }

  console.log("\n== storage adapter (local mode) ==");
  {
    const page = await newPage(browser, "store-test");
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    const s = await page.evaluate(async () => {
      const r = {};
      await window.storage.set("weird:key/with.chars$#[]", "v1", true);
      r.roundTrip = (await window.storage.get("weird:key/with.chars$#[]", true)).value;
      r.list = (await window.storage.list("weird:", true)).keys;
      r.getAll = await window.storage.getAll("weird:", true);
      r.mode = window.storage.mode;
      return r;
    });
    check("weird keys round-trip", s.roundTrip === "v1");
    check("list decodes keys", s.list.length === 1 && s.list[0].startsWith("weird:key"));
    check("getAll returns map", Object.values(s.getAll)[0] === "v1");
    check("local mode without firebase", s.mode === "local");
    await page.context().close();
  }

  console.log("\n== e2e: core flow, transit, dual currency ==");
  {
    const page = await newPage(browser, "flow-test", { shared: true });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(page, "Zach");
    await page.fill("#tripStart", "2026-09-07");
    await page.fill("#tripEnd", "2026-09-16");
    // activity via curated search
    await page.click("#addActivity");
    await page.fill("#locInput", "fushimi");
    await page.waitForTimeout(150);
    await page.click(".loc-opt");
    await page.fill("#actDate", "2026-09-08");
    await page.fill("#actCost", "0");
    await page.click("#itemSave");
    await page.waitForTimeout(300);
    check("activity added", /Fushimi/.test(await page.textContent("#railList")));
    // transit leg with cost
    await page.click("#addTransit");
    await page.fill("#itemName", "Nozomi 24");
    await page.fill("#transFrom", "Tokyo Station");
    await page.fill("#transTo", "Kyoto Station");
    await page.fill("#locInput", "kyoto station");
    await page.waitForTimeout(600);
    await page.click("#pickOnMap"); // no geocoder hit in tests: place on map instead
    await page.waitForTimeout(200);
    await page.mouse.click(640, 400);
    await page.waitForTimeout(300);
    await page.fill("#actDate", "2026-09-08");
    await page.fill("#actTime", "09:10");
    await page.fill("#actCost", "13500");
    await page.click("#itemSave");
    await page.waitForTimeout(400);
    const rail = await page.textContent("#railList");
    check("transit in rail with route", /Nozomi 24/.test(rail) && /Tokyo Station → Kyoto Station/.test(rail));
    await page.click(".tab[data-view=itinerary]");
    await page.waitForTimeout(400);
    const itin = await page.textContent("#itineraryInner");
    check("transit tagged in itinerary", /Transit/.test(itin) && /Nozomi 24/.test(itin));
    check("manual transit suppresses auto fares", !/· ~¥/.test(itin.split("Nozomi")[0]));
    check("dual currency on day cost", /≈\s?\$/.test(itin));
    // second currency switch to EUR
    await page.click(".tab[data-view=exp]");
    await page.waitForTimeout(300);
    await page.selectOption("#dispCur", "EUR");
    await page.waitForTimeout(300);
    await page.click(".tab[data-view=itinerary]");
    await page.waitForTimeout(300);
    check("display currency preference applies", /≈\s?€/.test(await page.textContent("#itineraryInner")));
    // persistence through the firebase mock
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    check("everything survives reload", /Nozomi 24/.test(await page.textContent("#railList")));
    await page.context().close();
  }

  console.log("\n== e2e: stay search & map region filter ==");
  {
    const page = await newPage(browser, "region-test");
    let photonURL = "";
    await page.route("https://photon.komoot.io/**", r => { photonURL = r.request().url(); r.fulfill({ contentType: "application/json", body: '{"features":[]}' }); }, { times: 99 });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(page, "Zach");
    // stay search: no curated attractions, hotel/place tags requested
    await page.click("#addStay");
    await page.fill("#locInput", "fushimi");
    await page.waitForTimeout(700);
    check("stay search hides curated attractions", !(await page.$(".loc-suggest .loc-opt")));
    check("stay search asks for hotels/places", /osm_tag=tourism%3Ahotel/.test(photonURL) && /osm_tag=place/.test(photonURL));
    await page.click("#itemCancel");
    // transit search asks for stations
    await page.click("#addTransit");
    await page.fill("#locInput", "shinagawa");
    await page.waitForTimeout(700);
    check("transit search asks for stations", /osm_tag=railway%3Astation/.test(photonURL));
    await page.click("#itemCancel");
    // map filter: Tokyo pin shows on a Japan-home trip, Paris pin hidden with a note
    await page.evaluate(async () => {
      state.trip.countries = ["JP"];
      const rec = state.people[state.me.name];
      rec.activities.push(
        { id:"t1", title:"Senso-ji", location:{lat:35.7148,lng:139.7967}, date:"", flex:null },
        { id:"p1", title:"Louvre", location:{lat:48.8606,lng:2.3376}, date:"", flex:null });
      await saveMe(); render();
    });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => ({
      markers: markerLayer.getLayers().length,
      note: document.getElementById("legendFar").textContent
    }));
    check("far pins filtered off the map", m.markers === 1, m.markers);
    check("legend explains hidden pins", /1 plan outside Japan/.test(m.note), m.note);
    await page.context().close();
  }

  console.log("\n== e2e: two-user sync ==");
  {
    const a = await newPage(browser, "sync-test", { shared: true });
    await a.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(a, "Zach");
    const b = await newPage(browser, "sync-test", { shared: true });
    await b.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(b, "Alex");
    await b.waitForTimeout(600);
    check("friend sees traveler through shared store", /Zach/.test(await b.textContent("#peopleList")));
    await a.context().close(); await b.context().close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); site.close(); fb.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SUITE CRASHED:", e); process.exit(1); });

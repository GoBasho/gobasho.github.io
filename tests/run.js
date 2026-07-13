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
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = pth.join(ROOT, p);
  fs.readFile(f, (err, data) => {
    if (err) { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", MIME[pth.extname(f)] || "text/plain");
    res.end(data);
  });
});

// minimal Firebase Realtime DB REST mock
const db = {};
let denyWrites = false;  // simulates security rules refusing writes (401)
// real Firebase stores no empty arrays/objects — they simply vanish.
// Mimic that, or bugs like "fresh traveler record has no stays array" hide.
function prune(v) {
  if (Array.isArray(v)) { const a = v.map(prune).filter(x => x !== undefined); return a.length ? a : undefined; }
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) { const p = prune(v[k]); if (p !== undefined) o[k] = p; }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}
const fb = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.end();
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__deny") { denyWrites = u.searchParams.get("w") === "1"; return res.end("ok"); }
  const path = u.pathname.replace(/\.json$/, "");
  if (req.method === "PUT") {
    if (denyWrites) { res.statusCode = 401; return res.end('{"error":"Permission denied"}'); }
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      const v = prune(JSON.parse(body));
      if (v === undefined) delete db[path]; else db[path] = v;
      res.end(JSON.stringify(v === undefined ? null : v));
    });
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
  // block service workers so they can't serve the real config.js over our mocks
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", e => { fail++; console.log("  FAIL pageerror: " + e.message); });
  await page.route("**/config.js", r => r.fulfill({ contentType: "application/javascript",
    body: `window.MERIDIAN_CONFIG={firebaseUrl:"${opts.shared ? "https://mock-rtdb.firebaseio.com" : ""}",tripId:"${tripId}",apiKey:"AIza-test"};` }));
  // most tests simulate a returning visitor who already picked this trip
  // (set-if-unset so in-app trip switches survive reloads)
  if (!opts.firstRun) await page.addInitScript(t => {
    if (!localStorage.getItem("meridian:active-trip")) localStorage.setItem("meridian:active-trip", t);
  }, tripId);
  await page.route("https://mock-rtdb.firebaseio.com/**", async r => {
    const u = new URL(r.request().url());
    if (/(^|[?&])auth=tok-test/.test(u.search)) page._authSeen = true;
    const res = await fetch("http://localhost:18898" + u.pathname + u.search,
      { method: r.request().method(), body: r.request().postData() || undefined });
    r.fulfill({ status: res.status, contentType: "application/json", body: await res.text() });
  });
  await page.route("https://identitytoolkit.googleapis.com/**", r => r.fulfill({ contentType: "application/json",
    body: JSON.stringify({ idToken: "tok-test", refreshToken: "ref-test", localId: "uid-test", expiresIn: "3600" }) }));
  await page.route("https://securetoken.googleapis.com/**", r => r.fulfill({ contentType: "application/json",
    body: JSON.stringify({ id_token: "tok-test", refresh_token: "ref-test", user_id: "uid-test", expires_in: "3600" }) }));
  await page.route("https://open.er-api.com/**", r => r.fulfill({ contentType: "application/json",
    body: JSON.stringify({ result: "success", rates: { USD: 0.0068, EUR: 0.0060, JPY: 1 } }) }));
  await page.route("https://photon.komoot.io/**", r => r.fulfill({ contentType: "application/json", body: '{"features":[]}' }));
  await page.route("https://en.wikipedia.org/**", r => r.fulfill({ contentType: "application/json", body: '{"query":{"pages":{}}}' }));
  await page.route("https://api.open-meteo.com/**", r => {
    const u = new URL(r.request().url());
    const days = [];
    let d = new Date(u.searchParams.get("start_date") + "T00:00:00");
    const end = new Date(u.searchParams.get("end_date") + "T00:00:00");
    while (d <= end && days.length < 20) { days.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ daily: {
      time: days, weather_code: days.map(() => 0),
      temperature_2m_max: days.map(() => 22), temperature_2m_min: days.map(() => 14) } }) });
  });
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
      // day-plan ideas: 3 unscheduled Tokyo spots cluster; a Kyoto one stays out;
      // the scheduled Sep 8 Tokyo activity should attract the cluster to Sep 8
      state.trip = {title:"T", start:"2026-09-07", end:"2026-09-12", countries:["JP"]};
      state.people = { A:{name:"A", stays:[], dayTrips:{}, activities:[
        {id:"s1", title:"Sumo", date:"2026-09-08", location:{lat:35.6966,lng:139.7932}},
        {id:"u1", title:"Pokemon Center", date:"", flex:{type:"range",start:"2026-09-07",end:"2026-09-12"}, location:{lat:35.6617,lng:139.7003}},
        {id:"u2", title:"Shibuya Sky", date:"", flex:{type:"range",start:"2026-09-07",end:"2026-09-12"}, location:{lat:35.6580,lng:139.7016}},
        {id:"u3", title:"Meiji Shrine", date:"", flex:{type:"options",days:["2026-09-08","2026-09-10"]}, location:{lat:35.6764,lng:139.6993}},
        {id:"u4", title:"Kinkaku-ji", date:"", flex:{type:"range",start:"2026-09-07",end:"2026-09-12"}, location:{lat:35.0394,lng:135.7292}}
      ]} };
      const ideas = dayPlanIdeas(state.people.A);
      r.ideaCount = ideas.length;                       // Tokyo cluster only (Kyoto is a lone item)
      r.ideaSize = ideas[0] && ideas[0].cluster.length; // 3
      r.ideaTopDay = ideas[0] && ideas[0].options[0].d; // Sep 8, pulled by the sumo anchor
      r.ideaAnchorFlag = ideas[0] && ideas[0].options[0].nearExisting;
      // merge suggestions: two nearby acts on different days
      state.people = { A:{name:"A", activities:[
        {id:"x", date:"2026-09-08", location:{lat:35.69,lng:139.79}, time:"15:00"},
        {id:"y", date:"2026-09-10", location:{lat:35.66,lng:139.70}, time:""}]} };
      const s = mergeSuggestions(state.people.A);
      r.sugg = s.length===1 && mergeDirection(s[0])==="d1";  // keep the timed one anchored
      // planning intelligence: coverage, overlaps, conflicts, countdown
      state.trip = {title:"T", start:"2026-09-07", end:"2026-09-12"};
      r.nights = nightsBetween("2026-09-07","2026-09-10");
      const cov = {name:"C", stays:[{start:"2026-09-07",end:"2026-09-09"},{start:"2026-09-10",end:"2026-09-12"}]};
      r.gaps = stayGaps(cov).map(g=>g.start+"/"+g.end).join(";");     // the night of Sep 9 only
      r.gapsQuietWhenNoStays = stayGaps({name:"D", stays:[]}).length; // no nagging a blank slate
      r.overlap = stayOverlaps({stays:[{start:"2026-09-07",end:"2026-09-10",city:"A"},{start:"2026-09-09",end:"2026-09-12",city:"B"}]}).length;
      r.backToBackOk = stayOverlaps({stays:[{start:"2026-09-07",end:"2026-09-09"},{start:"2026-09-09",end:"2026-09-12"}]}).length;
      const cfl = timeConflicts({activities:[
        {date:"2026-09-08", time:"14:00", durationH:"2", title:"teamLab"},
        {date:"2026-09-08", time:"15:00", title:"Sumo"},
        {date:"2026-09-08", time:"19:00", title:"Dinner"}]});
      r.conflicts = cfl.length===1 && cfl[0][0].title==="teamLab" && cfl[0][1].title==="Sumo";
      const fut = new Date(); fut.setDate(fut.getDate()+10);
      state.trip = {start: iso(fut), end: iso(fut)};
      r.countdownAhead = tripCountdown();
      state.trip = {start: iso(new Date()), end: iso(new Date())};
      r.countdownDuring = tripCountdown();
      // explore expansion: offset geometry and season awareness
      r.destKm = haversine({lat:43,lng:141}, destOffset({lat:43,lng:141}, 10, 45));
      r.skiInAugust = seasonCheck("Niseko ski resort", "2027-08-05");
      r.skiInJanuary = seasonCheck("Niseko ski resort", "2027-01-15");
      r.beachInJanuary = seasonCheck("Shirahama beach", "2027-01-15");
      state.trip = {start:"2027-07-30", end:"2027-08-02"};   // no date → trip months decide
      r.fireworksJulyTrip = seasonCheck("Lake Toya fireworks");
      state.trip = {start:"2027-11-01", end:"2027-11-04"};
      r.fireworksNovTrip = seasonCheck("Lake Toya fireworks");
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
    check("day ideas: one Tokyo cluster of 3", u.ideaCount === 1 && u.ideaSize === 3, {n:u.ideaCount, size:u.ideaSize});
    check("day ideas: anchored to the sumo day", u.ideaTopDay === "2026-09-08" && u.ideaAnchorFlag === true, u.ideaTopDay);
    check("autoTag theme parks & beaches", u.tagPark && u.tagBeach);
    check("wikiMatches finds interest in description", u.wikiHit === "Temples & shrines", u.wikiHit);
    check("wikiMatches ignores non-matches", u.wikiMiss === 0);
    check("Event category has a default cost", u.eventCost === true);
    check("notes linkify is safe", u.linkified === true);
    check("nightsBetween counts stay length", u.nights === 3, u.nights);
    check("stayGaps flags the uncovered night", u.gaps === "2026-09-09/2026-09-09", u.gaps);
    check("stayGaps is quiet before any stay exists", u.gapsQuietWhenNoStays === 0);
    check("stayOverlaps catches double-booked dates", u.overlap === 1);
    check("back-to-back checkout/checkin is not an overlap", u.backToBackOk === 0);
    check("timeConflicts flags the colliding pair only", u.conflicts === true);
    check("countdown before the trip", u.countdownAhead === "10 days to go", u.countdownAhead);
    check("countdown during the trip", u.countdownDuring === "Day 1 of 1", u.countdownDuring);
    check("destOffset lands the requested distance away", Math.abs(u.destKm - 10) < 0.2, u.destKm);
    check("ski hill flagged out of season in August", u.skiInAugust === "ski season is Dec–Apr", u.skiInAugust);
    check("ski hill fine in January", u.skiInJanuary === null);
    check("beach flagged in January", /beach season/.test(u.beachInJanuary), u.beachInJanuary);
    check("trip months decide when no date given", u.fireworksJulyTrip === null && /fireworks/.test(u.fireworksNovTrip));
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

  console.log("\n== e2e: day-plan ideas ==");
  {
    const page = await newPage(browser, "idea-test");
    await page.addInitScript(() => {
      const P = "meridian:idea-test:";
      localStorage.setItem(P+"me", JSON.stringify({name:"Zach", color:"#c8483c"}));
      localStorage.setItem(P+"person:Zach", JSON.stringify({ name:"Zach", color:"#c8483c", stays:[], dayTrips:{}, interests:[], updated:Date.now(), activities:[
        {id:"u1", title:"Pokemon Center", date:"", flex:{type:"range",start:"2026-09-07",end:"2026-09-12"}, location:{lat:35.6617,lng:139.7003}, category:"Shopping", time:"", notes:""},
        {id:"u2", title:"Shibuya Sky", date:"", flex:{type:"range",start:"2026-09-07",end:"2026-09-12"}, location:{lat:35.6580,lng:139.7016}, category:"Sightseeing", time:"", notes:""},
        {id:"u3", title:"Meiji Shrine", date:"", flex:{type:"options",days:["2026-09-08","2026-09-10"]}, location:{lat:35.6764,lng:139.6993}, category:"Culture", time:"", notes:""}
      ]}));
      localStorage.setItem(P+"trip:meta", JSON.stringify({title:"T", start:"2026-09-07", end:"2026-09-12", countries:["JP"]}));
    });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    check("rail hint counts day ideas", /day-planning idea/.test(await page.textContent("#railList")));
    await page.click(".tab[data-view=itinerary]");
    await page.waitForTimeout(400);
    const card = await page.textContent(".sug-card");
    check("idea card lists the cluster", /Pokemon Center/.test(card) && /Shibuya Sky/.test(card) && /Meiji Shrine/.test(card));
    check("idea card proposes a day", /Do these Sep/.test(card));
    await page.click("[data-dayidea].on");
    await page.waitForTimeout(500);
    const acts = await page.evaluate(() => state.people.Zach.activities.map(a => a.date));
    check("one click schedules the whole cluster", acts.filter(d => d === acts[0] && d).length === 3, acts);
    check("cards clear once planned", !(await page.$(".sug-card")));
    await page.context().close();
  }

  console.log("\n== e2e: weather, joins, comments, undo, digest, lanes ==");
  {
    const page = await newPage(browser, "v2-test");
    await page.addInitScript(() => {
      const P = "meridian:v2-test:";
      const pad = n => String(n).padStart(2, "0");
      const fmt = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      const t0 = fmt(new Date());
      const t5 = (d => { d.setDate(d.getDate() + 5); return fmt(d); })(new Date());
      localStorage.setItem(P + "me", JSON.stringify({ name: "Zach", color: "#c8483c" }));
      localStorage.setItem(P + "person:Zach", JSON.stringify({ name: "Zach", color: "#c8483c", stays: [], dayTrips: {}, interests: [], updated: Date.now(), activities: [
        { id: "z1", title: "Morning Fish Market", date: t0, time: "08:00", location: { lat: 35.66, lng: 139.77 }, category: "Food & drink", notes: "" },
        { id: "z2", title: "Evening Bar Crawl", date: t0, time: "19:00", location: { lat: 35.66, lng: 139.70 }, category: "Nightlife", notes: "" }] }));
      localStorage.setItem(P + "person:Alex", JSON.stringify({ name: "Alex", color: "#2e5e7e", stays: [], dayTrips: {}, interests: [], updated: Date.now() + 60000, activities: [
        { id: "x1", title: "Ghibli Museum", date: t0, time: "", location: { lat: 35.696, lng: 139.570 }, category: "Culture", notes: "" }] }));
      localStorage.setItem(P + "trip:meta", JSON.stringify({ title: "T", start: t0, end: t5, countries: ["JP"] }));
      localStorage.setItem(P + "last-seen", "1");
    });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    check("weather icons on the date strip", (await page.textContent("#dateStrip")).includes("☀️"));
    check("digest names who changed", /Since your last visit: Alex/.test(await page.textContent("#railList")));
    await page.hover('.item:has-text("Ghibli")');
    await page.click('.item:has-text("Ghibli") .ijoin');
    await page.waitForTimeout(400);
    check("joining marks the plan", /1 in/.test(await page.textContent('.item:has-text("Ghibli")')));
    await page.click(".tab[data-view=itinerary]");
    await page.waitForTimeout(400);
    check("joined plan lands in my day", /Ghibli Museum[\s\S]*with Alex/.test(await page.textContent("#itineraryInner")));
    await page.hover('.item:has-text("Ghibli")');
    await page.click('.item:has-text("Ghibli") .icmt');
    await page.fill("#cmText", "Book tickets early!");
    await page.click("#cmPost");
    await page.waitForTimeout(300);
    check("comment posts", /Book tickets early!/.test(await page.textContent("#cmList")));
    await page.click("#cmClose");
    await page.hover('.item:has-text("Morning Fish Market")');
    await page.click('.item:has-text("Morning Fish Market") .idel');
    await page.waitForTimeout(300);
    check("delete is immediate", !/Fish Market/.test(await page.textContent("#railList")));
    await page.click("#undoBtn");
    await page.waitForTimeout(300);
    check("undo restores it", /Fish Market/.test(await page.textContent("#railList")));
    await page.click(".tab[data-view=prep]");
    await page.waitForTimeout(400);
    const lanes = await page.$$eval(".prep-lane", els => els.map(e => e.textContent));
    check("prep board shows time lanes", lanes.includes("Morning") && lanes.includes("Evening"), lanes);
    await page.context().close();
  }

  console.log("\n== e2e: invites, unguessable ids, duplication, PWA ==");
  {
    const page = await newPage(browser, "inv-test");
    await page.goto("http://localhost:18899/?trip=secret-abc12", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    check("invite link switches trip", await page.evaluate(() => window.storage.tripId) === "secret-abc12");
    check("invite recorded as known", await page.evaluate(() => (JSON.parse(localStorage.getItem("meridian:known-trips")) || []).includes("secret-abc12")));
    await setupProfile(page, "Zach");
    await page.click("#tripsBtn");
    await page.waitForTimeout(400);
    await page.fill("#tmName", "Osaka Test");
    await page.click("#tmGo");
    await page.waitForTimeout(1200);
    const tid = await page.evaluate(() => window.storage.tripId);
    check("new trip id is unguessable", /^osaka-test-[a-z0-9]{5}$/.test(tid), tid);
    await page.click("#tripsBtn");
    await page.waitForTimeout(400);
    await page.click("#tmDup");
    await page.waitForTimeout(1200);
    const dup = await page.evaluate(() => ({ id: window.storage.tripId, title: state.trip.title }));
    check("duplicate copies the trip", /copy/.test(dup.title) && dup.id !== tid, dup);
    await page.context().close();
    // service worker check needs an unblocked context (and no reloads after)
    const swCtx = await browser.newContext();
    const swPage = await swCtx.newPage();
    await swPage.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    check("service worker registers", await swPage.evaluate(() =>
      Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise(r => setTimeout(() => r(false), 8000))])));
    await swCtx.close();
  }

  console.log("\n== e2e: today mode, bookings, packing, budget, polls, seasonal ==");
  {
    const page = await newPage(browser, "trip-day");
    await page.addInitScript(() => {
      const P = "meridian:trip-day:";
      const pad = n => String(n).padStart(2, "0");
      const fmt = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      const t0 = fmt(new Date());
      const t5 = (d => { d.setDate(d.getDate() + 5); return fmt(d); })(new Date());
      localStorage.setItem(P + "me", JSON.stringify({ name: "Zach", color: "#c8483c" }));
      localStorage.setItem(P + "person:Zach", JSON.stringify({ name: "Zach", color: "#c8483c", stays: [], dayTrips: {}, interests: [], updated: Date.now(), activities: [
        { id: "t1", title: "Ski Lesson", date: t0, time: "09:00", location: { lat: 42.85, lng: 140.70 }, category: "Nature", booking: "needed", notes: "" },
        { id: "t2", title: "Onsen Soak", date: t0, time: "18:00", location: { lat: 42.86, lng: 140.71 }, category: "Culture", notes: "" }] }));
      localStorage.setItem(P + "trip:meta", JSON.stringify({ title: "T", start: t0, end: t5, countries: ["JP"], budget: 100000 }));
    });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    check("Today tab appears during the trip", await page.$eval("#todayTab", el => el.style.display !== "none"));
    check("booking reminder in rail", /1 plan still needs booking/.test(await page.textContent("#railList")));
    await page.click("#todayTab");
    await page.waitForTimeout(400);
    const td = await page.textContent("#todayInner");
    check("today lists the day's stops", /Ski Lesson/.test(td) && /Onsen Soak/.test(td));
    check("today flags the booking", /needs booking/.test(td));
    check("navigate-day link built", await page.$eval("#todayInner a[href*='google.com/maps/dir']", el => /origin=42.85/.test(el.href)));
    await page.click("[data-tdone='t1']");
    await page.waitForTimeout(300);
    check("done sticks", await page.evaluate(() => state.people.Zach.activities[0].status === "done"));
    await page.click("[data-tskip='t2']");
    await page.waitForTimeout(300);
    check("skipped moves to its own list", /Skipped today/.test(await page.textContent("#todayInner")));
    await page.click("[data-treme='t2']");
    await page.waitForTimeout(300);
    check("reschedule returns it to the flexible pool", await page.evaluate(() =>
      state.people.Zach.activities[1].date === "" && state.people.Zach.activities[1].flex.type === "range"));
    // packing: ski trip detected from activity titles
    await page.click(".tab[data-view=check]");
    await page.waitForTimeout(400);
    const ck = await page.textContent("#checkInner");
    check("packing suggests ski gear", /Ski jacket & pants/.test(ck) && /Goggles/.test(ck));
    await page.click("[data-pack='pgoggles']");
    await page.waitForTimeout(300);
    check("packing tick persists to record", await page.evaluate(() => state.people.Zach.packing.pgoggles === true));
    // budget bars
    await page.click(".tab[data-view=exp]");
    await page.waitForTimeout(400);
    const exp = await page.textContent("#expInner");
    check("budget bars render", /Planned \(estimates\)/.test(exp) && /Spent \(your share\)/.test(exp));
    // polls
    await page.click(".tab[data-view=coord]");
    await page.waitForTimeout(300);
    await page.fill("#pollQ", "Otaru or Sapporo?");
    await page.fill("#pollOpts", "Otaru, Sapporo");
    await page.click("#pollAdd");
    await page.waitForTimeout(400);
    await page.click("[data-pollby][data-opt='0']");
    await page.waitForTimeout(400);
    const coord = await page.textContent("#coordInner");
    check("poll created and voted", /Otaru or Sapporo\?/.test(coord) && /1 vote/.test(coord) && /Zach/.test(coord));
    // seasonal note when in season (only assert when today is in a JP window)
    const seasonal = await page.evaluate(() => seasonalNotes());
    const m = new Date().getMonth() + 1;
    if ([12, 1, 2].includes(m)) check("seasonal: powder note in winter", seasonal.some(n => /powder/i.test(n)), seasonal);
    else check("seasonal function returns array", Array.isArray(seasonal));
    await page.context().close();
  }

  console.log("\n== e2e: smarter stays, transit times, explore radius ==");
  {
    const page = await newPage(browser, "smart-test");
    // Photon: stations for transit queries; nothing for stays (forces Nominatim merge)
    await page.route("https://photon.komoot.io/**", r => {
      const u = new URL(r.request().url());
      const q = (u.searchParams.get("q") || "").toLowerCase();
      const feat = (name, lat, lng, key, val) => ({ properties: { name, osm_key: key, osm_value: val, city: "Sapporo", countrycode: "JP" }, geometry: { coordinates: [lng, lat] } });
      let features = [];
      if (/station/.test(q)) features = [feat(q.includes("otaru") ? "Otaru Station" : "Sapporo Station", q.includes("otaru") ? 43.1971 : 43.0686, q.includes("otaru") ? 140.9946 : 141.3508, "railway", "station")];
      page._lastPhoton = u.href;
      r.fulfill({ contentType: "application/json", body: JSON.stringify({ features }) });
    });
    await page.route("https://nominatim.openstreetmap.org/**", r => r.fulfill({ contentType: "application/json",
      body: JSON.stringify([{ display_name: "3 Chome-7 Kita 5 Jonishi, Chuo Ward, Sapporo", lat: "43.068", lon: "141.35" }]) }));
    await page.route("https://api.transitous.org/**", r => r.fulfill({ contentType: "application/json",
      body: JSON.stringify({ itineraries: [
        { startTime: "2026-12-05T09:12:00+09:00", endTime: "2026-12-05T09:58:00+09:00", legs: [{ routeShortName: "Airport Rapid" }] },
        { startTime: "2026-12-05T09:40:00+09:00", endTime: "2026-12-05T10:26:00+09:00", legs: [{ routeShortName: "Local 342" }] }
      ] }) }));
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(page, "Zach");
    await page.fill("#tripStart", "2026-12-01");
    await page.fill("#tripEnd", "2026-12-10");
    // stay by street address (Nominatim merge path)
    await page.click("#addStay");
    await page.fill("#locInput", "3 Chome-7 Kita 5 Jonishi Sapporo");
    await page.waitForTimeout(700);
    check("stay search returns street addresses", /Kita 5 Jonishi/.test(await page.textContent("#locSuggest")));
    await page.click(".loc-opt");
    await page.fill("#stayStart", "2026-12-01");
    await page.fill("#stayEnd", "2026-12-10");
    await page.click("#itemSave");
    await page.waitForTimeout(400);
    // transit purely by from → to, with live times
    await page.click("#addTransit");
    await page.fill("#transFrom", "Sapporo Station");
    await page.fill("#transTo", "Otaru Station");
    await page.fill("#actDate", "2026-12-05");
    await page.click("#transFind");
    await page.waitForTimeout(600);
    check("connections listed", /09:12 → 09:58/.test(await page.textContent("#transTimes")));
    check("photon carries map-center bias", /lat=-?\d/.test(page._lastPhoton) && /lon=-?\d/.test(page._lastPhoton));
    await page.click(".trans-opt");
    await page.waitForTimeout(200);
    check("tapping a connection fills time/duration/name", await page.evaluate(() =>
      document.getElementById("actTime").value === "09:12" && document.getElementById("itemName").value === "Airport Rapid"));
    await page.click("#itemSave");
    await page.waitForTimeout(500);
    const tr = await page.evaluate(() => state.people.Zach.activities.find(a => a.transit));
    check("transit saved with auto arrival pin", !!tr && !!tr.location && Math.abs(tr.location.lat - 43.1971) < 0.01);
    // explore radius: Sapporo stay must not surface Tokyo at 25 km, but Otaru appears at 100 km
    await page.click(".tab[data-view=explore]");
    await page.waitForTimeout(600);
    let exp = await page.textContent("#exploreInner");
    check("25 km: no Tokyo or Korea recommendations", !/Senso-ji|Gyeongbokgung|Shibuya/.test(exp));
    check("25 km: farther-afield browser hidden", !/Farther afield|Photo spots farther/.test(exp));
    await page.click("[data-radius='100']");
    await page.waitForTimeout(600);
    exp = await page.textContent("#exploreInner");
    check("100 km: Otaru & Niseko surface, Tokyo still absent", /Otaru Canal/.test(exp) && /Niseko/.test(exp) && !/Senso-ji/.test(exp));
    await page.click("[data-radius='any']");
    await page.waitForTimeout(600);
    exp = await page.textContent("#exploreInner");
    check("anywhere: the far-flung browser returns", /Farther afield|Photo spots farther/.test(exp));
    await page.context().close();
  }

  console.log("\n== e2e: first-run welcome ==");
  {
    // brand-new visitor: welcome screen, not someone else's trip
    const page = await newPage(browser, "our-japan-trip", { shared: true, firstRun: true });
    db["/trips/fam-abc12/trip%3Ameta"] = JSON.stringify({ title: "Family Reunion", start: "", end: "" });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    check("welcome shows for new visitors", await page.$eval("#welcomeScrim", el => el.classList.contains("show")));
    check("profile modal held back", !(await page.$eval("#profileScrim", el => el.classList.contains("show"))));
    // create their own trip
    await page.fill("#wName", "Family Reunion 2027");
    await page.selectOption("#wHome", "GB");
    await page.click("#wCreate");
    await page.waitForTimeout(1200);
    const t = await page.evaluate(() => ({ id: window.storage.tripId, title: state.trip.title }));
    check("own trip created with unguessable id", /^family-reunion-2027-[a-z0-9]{5}$/.test(t.id) && t.title === "Family Reunion 2027", t);
    check("profile modal follows creation", await page.$eval("#profileScrim", el => el.classList.contains("show")));
    await page.context().close();
    // second visitor joins by pasting an invite link on the welcome screen
    const p2 = await newPage(browser, "our-japan-trip", { shared: true, firstRun: true });
    await p2.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await p2.waitForTimeout(600);
    await p2.fill("#wJoin", "https://example.com/Itinerary/?trip=fam-abc12");
    await p2.click("#wJoinBtn");
    await p2.waitForTimeout(1200);
    check("pasted invite link joins the trip", await p2.evaluate(() => window.storage.tripId) === "fam-abc12");
    await p2.context().close();
    // returning visitor with a profile skips the welcome
    const p3 = await newPage(browser, "our-japan-trip", { shared: true, firstRun: true });
    await p3.addInitScript(() => localStorage.setItem("meridian:our-japan-trip:me", JSON.stringify({ name: "Zach", color: "#c8483c" })));
    await p3.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await p3.waitForTimeout(700);
    check("returning visitor skips welcome", !(await p3.$eval("#welcomeScrim", el => el.classList.contains("show"))));
    await p3.context().close();
  }

  console.log("\n== e2e: demo trip, first steps, name collision, export ==");
  {
    // ?demo=1 seeds a sandboxed sample trip
    const page = await newPage(browser, "ignored", { shared: true });
    await page.goto("http://localhost:18899/?demo=1", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const demo = await page.evaluate(() => ({
      trip: window.storage.tripId, mode: window.storage.mode,
      people: Object.keys(state.people).sort().join(","),
      title: state.trip.title
    }));
    check("demo link opens the demo trip", demo.trip === "demo-tour" && demo.title === "Japan — Demo Trip");
    check("demo is sandboxed (local even with firebase config)", demo.mode === "local");
    check("demo has sample travelers", demo.people === "Kae,Ren");
    check("demo banner shows", /Demo trip — sandboxed/.test(await page.textContent("#railList")));
    check("demo data feeds the idea engine", await page.evaluate(() => dayPlanIdeas(state.people.Kae).length >= 1));
    // name collision: taking Kae's name asks for confirmation
    let dialogMsg = "";
    page.on("dialog", d => { dialogMsg = d.message(); d.dismiss(); });
    await page.fill("#profileName", "Kae");
    await page.click("#profileSave");
    await page.waitForTimeout(300);
    check("name collision warns", /already a traveler/.test(dialogMsg));
    // first steps card + export
    await page.fill("#profileName", "Zach");
    await page.click("#profileSave");
    await page.waitForTimeout(400);
    const steps = await page.textContent(".steps-card");
    check("first steps card tracks progress", /✓ Add yourself/.test(steps) && /Add a stay/.test(steps));
    await page.click("#tripsBtn");
    await page.waitForTimeout(300);
    const [dl] = await Promise.all([ page.waitForEvent("download"), page.click("#tmExport") ]);
    const json = JSON.parse(require("fs").readFileSync(await dl.path(), "utf8"));
    check("trip data exports as JSON", json.trip === "demo-tour" && !!json.data["person:Kae"]);
    await page.context().close();
  }

  console.log("\n== e2e: dark mode & mobile layout ==");
  {
    const page = await newPage(browser, "theme-test");
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(page, "Zach");
    const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.click("#themeBtn");
    const t1 = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      tiles: baseTiles._url,
      metaColor: document.querySelector('meta[name="theme-color"]').content
    }));
    check("toggle flips theme", t1.theme !== t0);
    check("map tiles follow theme", t1.tiles.includes(t1.theme === "dark" ? "dark_all" : "light_all"));
    check("meta theme-color follows", t1.theme === "dark" ? t1.metaColor === "#13161d" : t1.metaColor === "#f4f5f2");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    check("theme persists across reload", await page.evaluate(t => document.documentElement.dataset.theme === t, t1.theme));
    await page.context().close();

    // mobile viewport
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const m = await ctx.newPage();
    m.on("pageerror", e => { fail++; console.log("  FAIL mobile pageerror: " + e.message); });
    await m.route("**/config.js", r => r.fulfill({ contentType: "application/javascript",
      body: 'window.MERIDIAN_CONFIG={firebaseUrl:"",tripId:"mob-test"};' }));
    await m.addInitScript(() => localStorage.setItem("meridian:active-trip", "mob-test"));
    await m.route("https://open.er-api.com/**", r => r.fulfill({ contentType: "application/json", body: '{"rates":{}}' }));
    await m.route("https://photon.komoot.io/**", r => r.fulfill({ contentType: "application/json", body: '{"features":[]}' }));
    await m.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(m, "Zach");
    const mob = await m.evaluate(() => ({
      noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
      tripsVisible: !!document.getElementById("tripsBtn").offsetParent,
      themeVisible: !!document.getElementById("themeBtn").offsetParent,
      tabsScrollable: (d => d.scrollWidth >= d.clientWidth)(document.getElementById("tabs")),
      mapHeight: document.getElementById("stageMap").getBoundingClientRect().height
    }));
    check("no horizontal overflow on phone", mob.noHScroll);
    check("Trips + theme buttons visible on phone", mob.tripsVisible && mob.themeVisible);
    check("map has sensible phone height", mob.mapHeight >= 300);
    await m.click("#addActivity");
    await m.waitForTimeout(300);
    const sheet = await m.evaluate(() => {
      const r = document.querySelector("#itemScrim .modal").getBoundingClientRect();
      return { width: r.width, bottom: Math.round(r.bottom), vh: window.innerHeight };
    });
    check("modal is a full-width bottom sheet", sheet.width >= 388 && Math.abs(sheet.bottom - sheet.vh) < 3, sheet);
    await ctx.close();
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
    check("anonymous identity established", await a.evaluate(() => window.storage.uid) === "uid-test");
    check("auth token rides on database requests", a._authSeen === true);
    const rec = JSON.parse(await a.evaluate(async () => (await window.storage.get("person:Zach", true)).value));
    check("record stamped with owner uid", rec.uid === "uid-test");
    check("records stored as objects for rules", await (async () => {
      const res = await fetch("http://localhost:18898/trips/sync-test/person%3AZach.json");
      return typeof (await res.json()) === "object";
    })());
    await a.context().close(); await b.context().close();
  }

  console.log("\n== e2e: new-computer / new-trip stay & activity add ==");
  {
    // reproduces the reported failure: a brand-new trip (empty meta dates)
    // opened on a fresh browser, adding a stay then an activity
    const page = await newPage(browser, "our-japan-trip", { shared: true, firstRun: true });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await page.fill("#wName", "Ski Trip");
    await page.selectOption("#wHome", "JP");
    await page.click("#wCreate");
    await page.waitForTimeout(1200);
    await setupProfile(page, "Mom");
    // a fresh trip has no dates — the stay form must still offer usable defaults
    const prefill = await page.evaluate(() => {
      openItem("stay");
      return { start: document.getElementById("stayStart").value, end: document.getElementById("stayEnd").value };
    });
    check("new trip: stay form dates default to the trip window", !!prefill.start && !!prefill.end, prefill);
    await page.evaluate(() => document.getElementById("itemScrim").classList.remove("show"));
    // add a stay by picking a map point (no geocoder needed)
    await page.evaluate(() => {
      openItem("stay");
      state.pendingLoc = { lat: 43.06, lng: 141.35, label: "Sapporo Grand Hotel" };
      document.getElementById("locInput").value = "Sapporo Grand Hotel";
      document.getElementById("stayStart").value = "2026-12-01";
      document.getElementById("stayEnd").value = "2026-12-05";
    });
    await page.click("#itemSave");
    await page.waitForTimeout(500);
    check("new-trip stay lands in the record", await page.evaluate(() => state.people.Mom.stays.length === 1));
    const tid = await page.evaluate(() => window.storage.tripId);
    check("new-trip stay persisted to the database", await page.evaluate(async (t) => {
      const res = await fetch("http://localhost:18898/trips/" + t + "/person%3AMom.json");
      const p = await res.json(); return (p.stays || []).length === 1;
    }, tid));
    // add an activity
    await page.evaluate(() => {
      openItem("activity");
      state.pendingLoc = { lat: 43.07, lng: 141.34, label: "Odori Park" };
      document.getElementById("itemName").value = "Odori Park";
      document.getElementById("actDate").value = "2026-12-02";
    });
    await page.click("#itemSave");
    await page.waitForTimeout(500);
    check("new-trip activity lands in the record", await page.evaluate(() => state.people.Mom.activities.length === 1));
    await page.context().close();
  }

  console.log("\n== e2e: planning intelligence & polish upgrade ==");
  {
    // trip five days out, so the glance shows a countdown
    const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const [d0, d1, d2, d4, d5] = [day(5), day(6), day(7), day(9), day(10)];
    // d5 has no stay and no plans — the itinerary should nudge toward Explore there
    db["/trips/upg-test/trip%3Ameta"] = JSON.stringify({ title: "Upgrade", start: d0, end: d5, home: "JP", countries: ["JP"] });
    const page = await newPage(browser, "upg-test", { shared: true });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(page, "Zach");
    await page.evaluate(([d0, d1, d2, d4]) => {
      const me = state.people.Zach;
      me.stays = [
        { id: "s1", city: "Tokyo", hotelName: "Tokyo Inn", location: { lat: 35.68, lng: 139.76 }, start: d0, end: d1, cost: 12000 },
        { id: "s2", city: "Kyoto", hotelName: "Kyoto Inn", location: { lat: 35.01, lng: 135.77 }, start: d2, end: d4, cost: 15000 }];
      me.activities = [
        { id: "a1", title: "teamLab", date: d0, time: "14:00", durationH: "2", category: "Culture", location: { lat: 35.65, lng: 139.79 } },
        { id: "a2", title: "Sumo", date: d0, time: "15:00", category: "Event / show", location: { lat: 35.70, lng: 139.79 } }];
      return saveMe().then(() => render());
    }, [d0, d1, d2, d4]);
    const glance = await page.textContent(".trip-glance");
    check("glance: countdown + headcount + cost", /5 days to go/.test(glance) && /1 traveler/.test(glance) && /2 plans/.test(glance) && /~/.test(glance), glance);
    const rail = await page.textContent("#railList");
    check("stay gap hint names the uncovered night", /No stay booked the night of/.test(rail), rail.slice(0, 400));
    check("time conflict hint names both plans", /teamLab \(14:00\) overlaps Sumo \(15:00\)/.test(rail));
    check("stay rows show nights and total", /1 night · ~/.test(rail) && /2 nights · ~/.test(rail));
    // tapping the gap hint opens the stay form pre-filled with the gap
    await page.evaluate(() => [...document.querySelectorAll(".rail-hint")].find(h => /No stay booked/.test(h.textContent)).click());
    check("gap hint pre-fills the stay form", await page.evaluate(([d1, d2]) =>
      document.getElementById("itemScrim").classList.contains("show") &&
      document.getElementById("stayStart").value === d1 &&
      document.getElementById("stayEnd").value === d2, [d1, d2]));
    // Escape closes the modal
    await page.keyboard.press("Escape");
    check("Escape closes the open modal", !(await page.$eval("#itemScrim", el => el.classList.contains("show"))));
    // itinerary: the empty day between stays gets a nudge toward Explore
    await page.evaluate(() => setView("itinerary"));
    await page.waitForTimeout(300);
    const itin = await page.textContent("#itineraryInner");
    check("empty day gets a nudge", /Nothing planned yet/.test(itin));
    await page.click("[data-explore]");
    check("nudge jumps to Explore", await page.evaluate(() => state.view === "explore"));
    await page.context().close();
    // welcome screen writes real trip dates into the new trip
    const w = await newPage(browser, "our-japan-trip", { shared: true, firstRun: true });
    await w.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await w.waitForTimeout(600);
    await w.fill("#wName", "Dated Trip");
    await w.fill("#wStart", "2027-03-01");
    await w.fill("#wEnd", "2027-03-08");
    await w.click("#wCreate");
    await w.waitForTimeout(1200);
    check("welcome dates land in the shared trip", await w.evaluate(() =>
      state.trip.start === "2027-03-01" && state.trip.end === "2027-03-08"));
    await w.context().close();
  }

  console.log("\n== e2e: first stay after a reload (Firebase drops empty arrays) ==");
  {
    // profile-only record → reload → the record returns without stays/activities
    // keys (Firebase prunes empty arrays) → first Save must still work
    db["/trips/fresh-rec/trip%3Ameta"] = JSON.stringify({ title: "Japan 2026", start: "2026-12-13", end: "2027-01-13", home: "JP", countries: ["JP"] });
    const page = await newPage(browser, "fresh-rec", { shared: true });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(page, "Zach");
    check("mock mimics Firebase: empty arrays vanish from the stored record", await (async () => {
      const res = await fetch("http://localhost:18898/trips/fresh-rec/person%3AZach.json");
      const p = await res.json(); return !!p && !("stays" in p) && !("activities" in p);
    })());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      openItem("stay");
      state.pendingLoc = { lat: 43.06, lng: 141.35, label: "Sapporo Grand Hotel" };
      document.getElementById("locInput").value = "Sapporo Grand Hotel";
      document.getElementById("stayStart").value = "2026-12-14";
      document.getElementById("stayEnd").value = "2026-12-18";
    });
    await page.click("#itemSave");
    await page.waitForTimeout(400);
    check("first stay saves after a reload", await page.evaluate(() => state.people.Zach.stays.length === 1));
    check("save confirms with a toast, not silence", /Stay added/.test(await page.textContent("#notice")));
    check("explore quick-add works on a plan-less record", await page.evaluate(async () => {
      await addRecommendation({ name: "Odori Park", lat: 43.06, lng: 141.35, cat: "Nature" }, "2026-12-15");
      return state.people.Zach.activities.length === 1;
    }));
    await page.context().close();
  }

  console.log("\n== e2e: expanded Explore — radius rings, more results, seasons ==");
  {
    // an August trip based in Niseko: rural, thin curation, ski hills nearby
    db["/trips/explore-test/trip%3Ameta"] = JSON.stringify({ title: "Powder Scouting", start: "2027-08-02", end: "2027-08-08", home: "JP", countries: ["JP"] });
    const page = await newPage(browser, "explore-test", { shared: true });
    // synthetic Wikipedia: every geosearch circle returns the same 15 pages
    // (dedupe should collapse them), one being a ski hill — out of season in August
    let geoCalls = 0, geoUrl = "";
    await page.route("https://en.wikipedia.org/**", r => {
      const u = r.request().url();
      if (!/generator=geosearch/.test(u)) return r.fulfill({ contentType: "application/json", body: '{"query":{"pages":{}}}' });
      geoCalls++; geoUrl = u;
      const pages = { "1": { title: "Konbu Ski Area", description: "ski area in Hokkaido", coordinates: [{ lat: 42.81, lon: 140.69 }] } };
      for (let i = 2; i <= 15; i++) pages[String(i)] = { title: "Annupuri Spot " + i, description: "scenic viewpoint", coordinates: [{ lat: 42.8 + i * 0.001, lon: 140.68 }] };
      r.fulfill({ contentType: "application/json", body: JSON.stringify({ query: { pages } }) });
    });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(page, "Zach");
    await page.evaluate(() => {
      const me = state.people.Zach;
      me.stays = [{ id: "s1", city: "Niseko", hotelName: "Powder Lodge", location: { lat: 42.80, lng: 140.68 }, start: "2027-08-02", end: "2027-08-08" }];
      return saveMe().then(() => setView("explore"));
    });
    await page.waitForSelector(".wiki-near .rec-card", { timeout: 8000 });
    check("radius honored: a ring of geosearches, not one 10 km circle", geoCalls >= 7, geoCalls);
    check("coordinate/thumbnail limits requested (the old 10-result cap)", /colimit=50/.test(geoUrl) && /pilimit=50/.test(geoUrl));
    const cards = await page.$$eval(".wiki-near .rec-card", els => els.map(e => ({
      name: e.querySelector(".rec-name").textContent,
      off: !!e.querySelector(".rec-off"),
      hidden: e.style.display === "none"
    })));
    check("results deduped across circles, all kept", cards.length === 15, cards.length);
    check("out-of-season ski hill sinks to the bottom, labeled",
      cards[cards.length - 1].name === "Konbu Ski Area" && cards[cards.length - 1].off);
    check("in-season spots carry no label", cards.slice(0, 3).every(c => !c.off));
    check("first dozen visible, the rest folded", cards.filter(c => !c.hidden).length === 12 && cards.filter(c => c.hidden).length === 3, cards.filter(c => !c.hidden).length);
    await page.click(".wiki-more");
    check("Show more reveals the rest", await page.$$eval(".wiki-near .rec-card", els => els.every(e => e.style.display !== "none")));
    await page.context().close();
  }

  console.log("\n== e2e: a refused write is kept and retried, not lost ==");
  {
    const page = await newPage(browser, "deny-test", { shared: true });
    await page.goto("http://localhost:18899/", { waitUntil: "domcontentloaded" });
    await setupProfile(page, "Pat");
    let warned = "";
    page.on("dialog", d => d.dismiss());
    // now make the database reject writes, as locked security rules would for
    // an unauthenticated or wrong-owner browser, and add a stay
    await fetch("http://localhost:18898/__deny?w=1");
    warned = await page.evaluate(async () => {
      openItem("stay");
      state.pendingLoc = { lat: 35.68, lng: 139.76, label: "Tokyo Hotel" };
      document.getElementById("stayStart").value = "2026-12-01";
      document.getElementById("stayEnd").value = "2026-12-03";
      await saveItem();
      return document.getElementById("notice").textContent;
    });
    check("refused write keeps the stay locally", await page.evaluate(() => state.people.Pat.stays.length === 1));
    check("refused write is announced, not silent", /refused|Couldn't reach/.test(warned), warned);
    check("refused write is queued for retry", await page.evaluate(() => state._resaveMe === true));
    // recover: writes allowed again, the queued save should land on next poll
    await fetch("http://localhost:18898/__deny?w=0");
    await page.evaluate(async () => { await saveMe(); });
    check("recovered write persists to the database", await page.evaluate(async () => {
      const res = await fetch("http://localhost:18898/trips/deny-test/person%3APat.json");
      const p = await res.json(); return (p.stays || []).length === 1;
    }));
    check("retry flag clears after success", await page.evaluate(() => state._resaveMe === false));
    await page.context().close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); site.close(); fb.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SUITE CRASHED:", e); process.exit(1); });

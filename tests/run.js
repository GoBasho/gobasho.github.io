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

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); site.close(); fb.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SUITE CRASHED:", e); process.exit(1); });

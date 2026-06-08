// Roam — Travel Planner Proxy Server v2
// Run: ANTHROPIC_API_KEY=sk-ant-... node server.js
// No npm install needed — pure Node.js built-ins only

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY || "YOUR_API_KEY_HERE";
const PORT    = process.env.PORT || 3001;

const MIME = {
  ".html": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "RoamPlanner/2.0" } }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ raw: d }); }
      });
    }).on("error", reject);
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": buf.length } },
      (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

// ── Step 1: Get weather context via Open-Meteo (free, no key needed) ─────────
// Uses geocoding + climate normals endpoint for monthly averages

async function getWeatherContext(destination, month) {
  try {
    // Geocode the destination
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`;
    const geo = await httpsGet(geoUrl);
    if (!geo.results || !geo.results[0]) return null;

    const { latitude, longitude, name, country } = geo.results[0];

    // Map month name to number
    const monthMap = { january:1, february:2, march:3, april:4, may:5, june:6,
                       july:7, august:8, september:9, october:10, november:11, december:12 };
    const monthNum = monthMap[(month || "").toLowerCase()] || new Date().getMonth() + 1;

    // Fetch historical climate normals (past 10 years) for that lat/lon
    // open-meteo daily historical — get ~30 days for that month from last year
    const year = new Date().getFullYear() - 1;
    const mm = String(monthNum).padStart(2, "0");
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    const startDate = `${year}-${mm}-01`;
    const endDate   = `${year}-${mm}-${daysInMonth}`;

    const wxUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max&timezone=auto`;
    const wx = await httpsGet(wxUrl);

    if (!wx.daily) return { name, country, latitude, longitude, noData: true };

    const temps_max = wx.daily.temperature_2m_max || [];
    const temps_min = wx.daily.temperature_2m_min || [];
    const precip    = wx.daily.precipitation_sum  || [];
    const wind      = wx.daily.windspeed_10m_max  || [];

    const avg = arr => arr.length ? (arr.reduce((a,b) => a + (b||0), 0) / arr.length).toFixed(1) : null;
    const sum = arr => arr.reduce((a,b) => a + (b||0), 0).toFixed(0);

    const rainyDays = precip.filter(p => p > 2).length;
    const avgMaxC   = avg(temps_max);
    const avgMinC   = avg(temps_min);
    const totalPrecip = sum(precip);
    const avgWind   = avg(wind);

    // Classify conditions
    let weatherSummary, outdoorRisk;
    if (rainyDays >= 18)      { weatherSummary = "very wet — frequent heavy rain";    outdoorRisk = "high"; }
    else if (rainyDays >= 10) { weatherSummary = "mixed — expect several rainy days"; outdoorRisk = "medium"; }
    else if (rainyDays >= 4)  { weatherSummary = "mostly dry with occasional showers"; outdoorRisk = "low"; }
    else                      { weatherSummary = "dry and sunny";                      outdoorRisk = "minimal"; }

    let tempDesc;
    const midC = ((parseFloat(avgMaxC) + parseFloat(avgMinC)) / 2);
    if (midC >= 28)      tempDesc = "hot";
    else if (midC >= 20) tempDesc = "warm";
    else if (midC >= 12) tempDesc = "mild";
    else if (midC >= 4)  tempDesc = "cool";
    else                 tempDesc = "cold";

    return {
      name, country, latitude, longitude,
      month, avgMaxC, avgMinC, totalPrecipMm: totalPrecip,
      rainyDays, avgWindKph: avgWind,
      weatherSummary, outdoorRisk, tempDesc,
      hemisphere: latitude < 0 ? "southern" : "northern",
    };
  } catch (err) {
    console.error("Weather fetch error:", err.message);
    return null;
  }
}

// ── Step 2: Build the smart prompt ───────────────────────────────────────────

function buildPrompt(req, wx) {
  const { dest, from, days, month, who, interests, pace, budget, notes } = req;

  const wxBlock = wx && !wx.noData ? `
REAL WEATHER DATA for ${wx.name}, ${wx.country} in ${month}:
- Average high: ${wx.avgMaxC}°C / Average low: ${wx.avgMinC}°C
- Conditions: ${wx.weatherSummary}
- Rainy days last ${month}: ${wx.rainyDays} out of ${new Date(new Date().getFullYear()-1, ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf((month||'').toLowerCase())+1, 0).getDate()} days
- Total precipitation: ${wx.totalPrecipMm}mm
- Outdoor risk level: ${outdoorRiskLabel(wx.outdoorRisk)}
- Temperature feel: ${wx.tempDesc}` : `
WEATHER NOTE: Could not fetch live data. Use your knowledge of ${dest} in ${month} — be explicit about typical conditions and adjust accordingly.`;

  return `You are an expert local travel planner. Your plans must be GEOGRAPHICALLY LOGICAL, WEATHER-AWARE, and REALISTICALLY TIMED.
${wxBlock}

TRIP DETAILS:
- Destination: ${dest}
- Departing from: ${from || "unspecified"}
- Duration: ${days} days
- Month: ${month || "unspecified"}
- Travelling as: ${who || "travellers"}
- Interests: ${(interests||[]).join(", ") || "general sightseeing"}
- Pace: ${pace || "balanced"}
- Budget: ${budget || "mid-range"}
- Notes: ${notes || "none"}

STRICT RULES — violating any of these makes the plan unusable:

GEOGRAPHY:
1. Each day must stay within ONE neighbourhood or zone. Name the zone in the day title.
2. Morning → Afternoon → Evening must flow logically — each stop within 10-15 min walk or one metro stop of the previous.
3. Never send someone from north to south and back in the same day.
4. Assign indoor-heavy days to the rainiest/hottest/coldest days, outdoor days to the best weather windows.

TIMING:
5. Morning block starts 8:00–9:30am. Include exact start time.
6. Afternoon block starts 12:30–2:00pm. Include transit note from morning if needed.
7. Evening block starts 6:30–8:00pm. Include exact restaurant name, what to order, approx cost.
8. Respect actual opening hours (museums often closed Mondays, markets often early morning only).
9. If something needs advance booking, say so explicitly with how far ahead.

SPECIFICITY:
10. Name every place: restaurant name, street name, viewpoint name, transit line number.
11. Include entry costs, queue tips, best seats/tables, what NOT to miss inside.
12. NEVER say "visit a museum" — say "spend 90 min at the Topkapi Palace Harem wing (opens 9am, ₺500 extra, book online 2 days ahead, last entry 4:30pm)".

WEATHER LOGIC:
13. If outdoor risk is HIGH: keep outdoor activities short (under 45 min), front-load them before rain typically arrives, schedule covered alternatives.
14. If outdoor risk is MEDIUM: mention backup indoor options for outdoor morning slots.
15. If it's HOT (>30°C): avoid midday outdoor exposure 12–3pm, schedule siestas or indoor breaks.
16. State weather reality plainly — "July is brutal here, start by 7:30am before the heat".

PACKING LIST — generate a genuinely useful, specific list. Not generic. Examples:
- "Slip-on shoes — you'll remove them at every temple" not just "comfortable shoes"
- "Portable umbrella — afternoon showers hit daily in ${month}" not just "rain gear"
- Organise into: Clothing, Footwear, Documents & Money, Health & Comfort, Tech, Extras

Return ONLY raw JSON (no markdown fences, no explanation). Schema:

{
  "destination": "City, Country",
  "zone": "Main area(s) covered",
  "tripSummary": "One vivid sentence — specific, not generic",
  "weatherNote": "2 sentences: honest assessment of conditions and how the plan accounts for them",
  "highlights": ["3 to 5 short phrases"],
  "days": [
    {
      "dayNumber": 1,
      "title": "Neighbourhood name + evocative detail",
      "zone": "District/neighbourhood name",
      "weatherFlag": "sunny|mixed|indoor-day|hot-day|rainy-day",
      "morning": {
        "time": "8:30am",
        "activity": "Short name",
        "detail": "3 sentences: what, where exactly, practical info (cost, tip, timing)",
        "walkFromPrev": null
      },
      "afternoon": {
        "time": "1:00pm",
        "activity": "Short name",
        "detail": "3 sentences",
        "walkFromPrev": "7 min walk south on Rue de Rivoli"
      },
      "evening": {
        "time": "7:30pm",
        "activity": "Dinner at [Restaurant Name]",
        "detail": "3 sentences: cuisine, what to order, cost per head, reservation note",
        "walkFromPrev": "10 min walk or metro line 1 to Châtelet"
      },
      "insiderTip": "One hyper-local tip you'd only know from living there"
    }
  ],
  "packingList": {
    "clothing": ["item with specific reason"],
    "footwear": ["item with specific reason"],
    "documentsAndMoney": ["item with specific reason"],
    "healthAndComfort": ["item with specific reason"],
    "tech": ["item with specific reason"],
    "extras": ["item with specific reason"]
  }
}`;
}

function outdoorRiskLabel(r) {
  return { high: "HIGH — plan indoor fallbacks", medium: "MEDIUM — have a plan B", low: "LOW — mostly fine", minimal: "MINIMAL — great outdoor weather" }[r] || r;
}

// ── Step 3: Call Claude ───────────────────────────────────────────────────────

async function callClaude(prompt) {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 6000,
    messages: [{ role: "user", content: prompt }],
  });

  const result = await httpsPost(
    "api.anthropic.com",
    "/v1/messages",
    {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    payload
  );

  if (result.status !== 200) {
    console.error(`Claude API ${result.status}:`, result.body);
    throw new Error(`Claude API error ${result.status}: ${result.body}`);
  }

  const data = JSON.parse(result.body);
  return data.content.map(b => b.type === "text" ? b.text : "").join("");
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── POST /api/plan ──
  if (req.method === "POST" && req.url === "/api/plan") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      let tripReq;
      try { tripReq = JSON.parse(body); }
      catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      try {
        console.log(`[plan] ${tripReq.dest}, ${tripReq.days} days, ${tripReq.month}`);

        // Step 1: fetch weather
        const wx = await getWeatherContext(tripReq.dest, tripReq.month);
        if (wx) console.log(`[weather] ${wx.name}: ${wx.weatherSummary}, ${wx.tempDesc}`);
        else    console.log(`[weather] no data — using model knowledge`);

        // Step 2: build prompt and call Claude
        const prompt = buildPrompt(tripReq, wx);
        const raw    = await callClaude(prompt);

        // Step 3: clean and parse
        const clean = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const plan  = JSON.parse(clean);

        // Attach live weather data to response
        plan._weatherData = wx;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(plan));

      } catch (err) {
        console.error("[error]", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Serve static files ──
  const filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n✈  Roam v2 running at http://localhost:${PORT}\n`);
  if (API_KEY === "YOUR_API_KEY_HERE")
    console.warn("⚠  No API key. Set ANTHROPIC_API_KEY env var or edit server.js line 10\n");
});

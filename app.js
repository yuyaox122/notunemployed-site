// bell — PWA front end. No framework, no build step: this file is served as-is by
// GitHub Pages, which is the whole reason the project needs no node toolchain.
//
// Paste the key printed by `python3 -m bell.notify keys` here.
const VAPID_PUBLIC_KEY = "BKB1-4MLVE0uGXfpcSvxeOdtcKjagW0rREYZxwT3Q3NrDGuB1FmktBkZlJaFNn6Rz1zJriZ1p8dIBSWioyn0N2I";

const $ = (id) => document.getElementById(id);

// ---- facets -----------------------------------------------------------------
// The classifier has always computed `stage` x `desk`; until Round 57 the feed threw
// both away and the app could only offer three booleans over 193 rows. `null` is a
// real value in both dimensions and gets a chip of its own: a `weak` row is exactly
// one whose desk could not be named, and hiding it behind "no filter" would make the
// most uncertain rows the hardest to look at deliberately.
const FACETS = {
  stage: { order: ["spring", "intern", "placement", "graduate", "null"],
           name: { spring: "Spring week", intern: "Internship",
                   placement: "Placement", graduate: "Graduate",
                   "null": "stage unclear" } },
  desk:  { order: ["quant", "markets", "engineering", "commodities", "null"],
           name: { quant: "Quant", markets: "Markets", engineering: "Engineering",
                   commodities: "Commodities", "null": "desk unclear" } },
};

const state = {
  items: [], q: "", uk: true, strong: true, hideDone: true, onlyNew: false,
  stage: new Set(), desk: new Set(), firm: new Set(),
  sort: "opened", panel: false, allFirms: false, view: "list",
};

// ---- per-viewer state -------------------------------------------------------
// localStorage is the right home for this: it is one person's working set, it must
// survive a redeploy of feed.json, and it must never leave the device. Every access
// is wrapped because a private window or blocked site data makes the accessor itself
// throw, and a tracker that white-screens because someone has cookies off is worse
// than one with no memory.
const KEY = "bell.marks.v1";
const CHECKED_KEY = "bell.checked.v1";
const FILTER_KEY = "bell.filters.v1";
const VISIT_KEY = "bell.lastvisit.v1";

function readJSON(k, fallback) {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch (_) { return fallback; }
}
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

let marks = readJSON(KEY, {});
function saveMarks() { writeJSON(KEY, marks); }
function markKey(i) { return i.url || (i.firm + "|" + i.title); }

// When you last looked at a firm bell cannot see for you. Per-viewer, local, and the
// only state in this app that represents a promise you made to yourself rather than
// something bell observed.
let checked = readJSON(CHECKED_KEY, {});
function markChecked(firm) {
  checked[firm] = Date.now();
  writeJSON(CHECKED_KEY, checked);
  renderBlind(window.__blind || []);
}
const STALE_DAYS = 7;
function daysSince(ts) { return ts ? (Date.now() - ts) / 86400000 : null; }
function mark(i, how) {
  const k = markKey(i);
  if (marks[k] === how) delete marks[k]; else marks[k] = how;
  saveMarks(); render();
}

// "New" means new TO YOU, not new to bell. Read once at startup and held for the
// session: refreshing the feed every 60 s must not make the badges you have not
// looked at yet disappear from under you.
const lastVisit = readJSON(VISIT_KEY, null);
writeJSON(VISIT_KEY, new Date().toISOString());
function isNew(i) { return lastVisit ? (i.first_seen_at || "") > lastVisit : false; }

// Filters persist. Coming back to a tracker and finding it reset to "everything" is
// how you end up scrolling past the one row you were watching for.
(function restoreFilters() {
  const f = readJSON(FILTER_KEY, null);
  if (!f) return;
  for (const k of ["uk", "strong", "hideDone", "onlyNew", "panel", "allFirms"])
    if (typeof f[k] === "boolean") state[k] = f[k];
  if (typeof f.sort === "string") state.sort = f.sort;
  for (const k of ["stage", "desk", "firm"])
    if (Array.isArray(f[k])) state[k] = new Set(f[k]);
})();
function saveFilters() {
  writeJSON(FILTER_KEY, {
    uk: state.uk, strong: state.strong, hideDone: state.hideDone,
    onlyNew: state.onlyNew, panel: state.panel, allFirms: state.allFirms,
    sort: state.sort, stage: [...state.stage], desk: [...state.desk],
    firm: [...state.firm],
  });
}

// ---- time -------------------------------------------------------------------
// Seconds are the honest unit to store and a terrible one to read. 1274 -> "21 min".
function dur(s) {
  if (s == null) return "—";
  if (s < 90) return Math.round(s) + "s";
  if (s < 5400) return Math.round(s / 60) + " min";
  if (s < 172800) return (s / 3600).toFixed(1) + " h";
  return Math.round(s / 86400) + " days";
}

const REL = [[31536000,"y"],[2592000,"mo"],[604800,"w"],[86400,"d"],[3600,"h"],[60,"m"]];
function ago(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  for (const [sec, u] of REL) if (s >= sec) return Math.floor(s / sec) + u + " ago";
  return "just now";
}

// A board that states "2026-09-04" has told us the day and not the minute. Rendering
// that as "2d ago" implies a precision it never gave; throwing it away and showing
// "seen 4h ago" discards something true. It gets its own label.
function day(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-GB",
    { day: "numeric", month: "short", timeZone: "UTC" });
}

// A date we did not get from the source is labelled as such. Showing "22m ago" for a
// Workday row means "we first saw it 22 minutes ago", not "it opened 22 minutes ago",
// and presenting the second as the first is the kind of quiet lie that makes a tracker
// untrustworthy the first time someone checks.
function when(i) {
  if (i.date_basis === "unknown") return "date unknown";
  if (i.date_basis === "published_date") return "published " + day(i.opened_at);
  const a = ago(i.opened_at || i.first_seen_at);
  return i.date_basis === "published" ? a : "seen " + a;
}

// Did the board state when this opened, at any precision? A `first seen` row has a
// date, but it is OURS — it says when we looked, not when the firm published — so it
// cannot be sorted or grouped alongside dates the firm stated.
function stated(i) {
  return i.date_basis === "published" || i.date_basis === "published_date";
}

// The date a given sort actually orders by, so the day headings cannot disagree with
// the order beneath them.
function sortDate(i) {
  if (state.sort === "found") return i.first_seen_at || "";
  return (i.date_basis === "unknown" ? "" : (i.opened_at || i.first_seen_at || ""));
}

const DAY = 86400000;
function bucket(iso) {
  if (!iso) return "Date unknown";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "Date unknown";
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const d = (midnight.getTime() - t) / DAY;
  if (d < 0) return "Today";
  if (d < 1) return "Yesterday";
  if (d < 7) return "Earlier this week";
  if (d < 30) return "This month";
  return "Older";
}

// ---- routing -------------------------------------------------------------------
// The hash IS the view. Three reasons it is worth the twenty lines: a filtered view
// becomes a link you can send someone ("#/desk/quant" is the quant list), the back
// button works, and reloading keeps you where you were. A single-page app that
// silently discards the browser's own navigation is worse than a set of static pages.
function readHash() {
  const h = (location.hash || "").replace(/^#\/?/, "");
  const [head, ...rest] = h.split("/").map(decodeURIComponent);
  const arg = rest.join("/");
  state.stage.clear(); state.desk.clear(); state.firm.clear();
  if (head === "calendar" || head === "browse") { state.view = head; return; }
  state.view = "list";
  if (head === "desk" && arg) state.desk.add(arg);
  else if (head === "stage" && arg) state.stage.add(arg);
  else if (head === "firm" && arg) state.firm.add(arg);
}

function writeHash() {
  let h = "#/";
  if (state.view !== "list") h = "#/" + state.view;
  else if (state.desk.size === 1 && !state.stage.size && !state.firm.size)
    h = "#/desk/" + encodeURIComponent([...state.desk][0]);
  else if (state.stage.size === 1 && !state.desk.size && !state.firm.size)
    h = "#/stage/" + encodeURIComponent([...state.stage][0]);
  else if (state.firm.size === 1 && !state.desk.size && !state.stage.size)
    h = "#/firm/" + encodeURIComponent([...state.firm][0]);
  if (location.hash !== h) history.replaceState(null, "", h);
}

function setView(v) {
  state.view = v;
  saveFilters();
  location.hash = v === "list" ? "#/" : "#/" + v;
  renderAll();
}

// ---- filtering ---------------------------------------------------------------
// `skip` names a facet to ignore. Counting a chip against every filter EXCEPT its own
// group is what stops the panel becoming a maze of dead ends: "Graduate 59" means 59
// more rows if you tap it, not 0 because the current selection already excludes them.
function matches(i, skip) {
  if (skip !== "uk" && state.uk && !i.uk) return false;
  if (skip !== "strong" && state.strong && i.strength !== "strong") return false;
  if (skip !== "hideDone" && state.hideDone && marks[markKey(i)]) return false;
  if (skip !== "onlyNew" && state.onlyNew && !isNew(i)) return false;
  if (skip !== "stage" && state.stage.size && !state.stage.has(String(i.stage)))
    return false;
  if (skip !== "desk" && state.desk.size && !state.desk.has(String(i.desk)))
    return false;
  if (skip !== "firm" && state.firm.size && !state.firm.has(i.firm)) return false;
  if (skip !== "q" && state.q) {
    const hay = (i.firm + " " + i.title + " " + (i.location || "")).toLowerCase();
    if (!state.q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}

function counts(key) {
  const out = new Map();
  for (const i of state.items) {
    if (!matches(i, key)) continue;
    const v = String(i[key]);
    out.set(v, (out.get(v) || 0) + 1);
  }
  return out;
}

function activeFilters() {
  const out = [];
  if (state.uk) out.push(["uk", "UK only"]);
  if (state.strong) out.push(["strong", "Strong only"]);
  if (state.hideDone) out.push(["hideDone", "Hiding marked"]);
  if (state.onlyNew) out.push(["onlyNew", "New to me"]);
  for (const k of ["stage", "desk"])
    for (const v of state[k]) out.push([k + ":" + v, FACETS[k].name[v] || v]);
  for (const v of state.firm) out.push(["firm:" + v, v]);
  if (state.q) out.push(["q", `"${state.q}"`]);
  return out;
}

function clearFilters() {
  state.uk = state.strong = state.hideDone = state.onlyNew = false;
  state.stage.clear(); state.desk.clear(); state.firm.clear();
  state.q = ""; $("q").value = "";
  saveFilters(); renderAll();
}

function dropFilter(id) {
  const [k, v] = id.split(/:(.+)/);
  if (v === undefined) { state[k] = k === "q" ? ($("q").value = "") : false; }
  else state[k].delete(v);
  saveFilters(); renderAll();
}

// ---- chips -------------------------------------------------------------------
function chipRow(el, key) {
  const c = counts(key);
  const order = FACETS[key].order;
  el.innerHTML = order.map(v => {
    const n = c.get(v) || 0;
    const on = state[key].has(v);
    // Zero-count chips are shown disabled rather than hidden. "Commodities 0" is
    // information — it says bell is looking and found none — and a facet list that
    // silently reshapes itself is impossible to trust.
    return `<button class="chip" data-facet="${key}" data-v="${esc(v)}"
      aria-pressed="${on}" ${n === 0 && !on ? "disabled" : ""}
      >${esc(FACETS[key].name[v] || v)}<u>${n}</u></button>`;
  }).join("");
}

const FIRM_SHOWN = 10;
function firmRow(el) {
  const c = [...counts("firm").entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const selected = c.filter(([f]) => state.firm.has(f));
  const rest = c.filter(([f]) => !state.firm.has(f));
  const shown = state.allFirms ? [...selected, ...rest]
                               : [...selected, ...rest.slice(0, FIRM_SHOWN)];
  const hidden = c.length - shown.length;
  el.innerHTML = shown.map(([f, n]) =>
    `<button class="chip" data-facet="firm" data-v="${esc(f)}"
      aria-pressed="${state.firm.has(f)}">${esc(f)}<u>${n}</u></button>`).join("")
    + (hidden > 0 || state.allFirms
        ? `<button class="chip" id="fMoreFirms">${state.allFirms
            ? "fewer" : "+" + hidden + " more"}</button>` : "");
}

// ---- render ------------------------------------------------------------------
function renderAll() {
  for (const b of $("views").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
  const isList = state.view === "list";
  for (const id of ["stats", "list", "gaps", "blindwrap"]) $(id).hidden = !isList;
  $("searchbar").hidden = !isList;
  $("browse").hidden = state.view !== "browse";
  $("calendar").hidden = state.view !== "calendar";
  document.querySelector(".resbar").hidden = !isList;
  if (!isList) {
    $("panel").hidden = true;
    $("empty").hidden = true;
    if (state.view === "browse") renderBrowse();
    else renderCalendar();
    return;
  }
  chipRow($("fStage"), "stage");
  chipRow($("fDesk"), "desk");
  firmRow($("fFirm"));
  for (const [id, k] of [["fUK","uk"],["fStrong","strong"],["fHide","hideDone"],
                         ["fNew","onlyNew"]])
    $(id).setAttribute("aria-pressed", String(state[k]));
  $("panel").hidden = !state.panel;
  $("fFilters").setAttribute("aria-expanded", String(state.panel));
  const n = activeFilters().length;
  $("fFilters").innerHTML = "Filters" + (n ? ` <b>${n}</b>` : "");
  $("sort").value = state.sort;
  render();
  writeHash();
}

function render() {
  const items = state.items.filter(i => matches(i));

  if (state.sort === "found")
    items.sort((a, b) => (b.first_seen_at || "").localeCompare(a.first_seen_at || ""));
  else if (state.sort === "firm")
    items.sort((a, b) => a.firm.localeCompare(b.firm) || a.title.localeCompare(b.title));
  else
    // "Newest opening" means by the date the BOARD stated. feed.py's order ranks a
    // stated timestamp above a stated day above "when we happened to look", which is
    // right for a flat list (Round 32: a cold-start row has no defensible position in
    // a recency ranking) and wrong under day headings — grouping a rank order by date
    // produced "Earlier this week, This month, Older, Today". So the rows the board
    // dated are sorted by that date, and the rows it did not are held back into one
    // group at the end rather than being given a position they have not earned.
    items.sort((a, b) => (stated(a) === stated(b))
      ? (b.opened_at || "").localeCompare(a.opened_at || "")
      : (stated(a) ? -1 : 1));

  // Every narrowing filter is shown as a removable pill, including the three that are
  // on by default. "37 of 193" with no visible reason is the single most confusing
  // thing a filtered list can do.
  const af = activeFilters();
  $("pills").innerHTML = af.map(([id, label]) =>
    `<span class="pill">${esc(label)}<button data-drop="${esc(id)}"
      aria-label="Remove filter ${esc(label)}">&times;</button></span>`).join(" ");
  $("fClear").hidden = af.length === 0;
  $("resCount").textContent = items.length === state.items.length
    ? `${items.length} open`
    : `${items.length} of ${state.items.length}`;
  const done = state.items.filter(i => marks[markKey(i)]).length;
  $("doneCount").textContent = done ? `${done} marked` : "";

  $("empty").hidden = items.length > 0;
  if (!items.length) {
    $("empty").innerHTML = state.items.length
      ? `Nothing matches those filters.<br><button class="linkish"
           id="emptyClear">clear filters</button>`
      : "No feed yet. Run: python3 -m bell.feed";
    const ec = $("emptyClear");
    if (ec) ec.addEventListener("click", clearFilters);
  }

  // Grouped by day for the two date sorts, flat for A–Z. A heading that does not match
  // the sort order is worse than no heading.
  const groups = [];
  if (state.sort === "firm") {
    groups.push([null, items]);
  } else {
    const undated = state.sort === "opened" ? items.filter(i => !stated(i)) : [];
    const dated = state.sort === "opened" ? items.filter(stated) : items;
    let cur = null;
    for (const i of dated) {
      const b = bucket(sortDate(i));
      if (!cur || cur[0] !== b) { cur = [b, []]; groups.push(cur); }
      cur[1].push(i);
    }
    if (undated.length) groups.push(["No publish date from the board", undated]);
  }
  $("list").innerHTML = groups.map(([label, rows]) =>
    (label ? `<div class="dayhead">${esc(label)} <span
       style="font-weight:400;text-transform:none;letter-spacing:0">${rows.length}</span></div>` : "")
    + "<ul>" + rows.map(row).join("") + "</ul>").join("");
}

function row(i) {
  const dl = i.deadline
    ? `<span class="tag dl">closes ${String(i.deadline).slice(0, 10)}</span>` : "";
  const uk = i.uk ? `<span class="tag uk">UK</span>` : "";
  const nw = isNew(i) ? `<span class="tag newt">new</span>` : "";
  const weak = i.strength === "weak"
    ? `<span class="tag weakt">weak — desk unclear</span>` : "";
  // The facets are shown on the row as well as in the panel, so the thing you filtered
  // by is visible in the result rather than only in the control that produced it.
  const fac = ["stage", "desk"].map(k => i[k]
    ? `<span class="tag facet">${esc(FACETS[k].name[i[k]] || i[k])}</span>` : "").join("");
  // An inferred open date is stated as such rather than quietly displayed as fact.
  const exact = i.opened_exact ? ""
    : `<span class="tag">${
        i.date_basis === "unknown" ? "no publish date from this board"
        : i.date_basis === "published_date" ? "board stated the day, not the time"
        : "date is when we first saw it"}</span>`;
  const m = marks[markKey(i)];
  const k = encodeURIComponent(markKey(i));
  const u = safeUrl(i.url);
  return `<li class="item ${i.strength} ${m ? "marked " + m : ""} ${
      isNew(i) ? "isnew" : ""}">
    <div class="row1">
      <span class="firm">${esc(i.firm)}</span>
      <span class="when">${when(i)}</span>
    </div>
    <div class="title">${u ? `<a href="${esc(u)}" target="_blank"
        rel="noopener noreferrer">${esc(i.title)}</a>` : esc(i.title)}</div>
    <div class="meta">
      <span>${esc(i.location || "location not stated")}</span>
      ${uk}${nw}${fac}${dl}${weak}${exact}
      ${m ? `<span class="tag done">${m}</span>` : ""}
    </div>
    <div class="acts">
      <button data-k="${k}" data-how="applied"
        aria-pressed="${m === "applied"}">applied</button>
      <button data-k="${k}" data-how="dismissed"
        aria-pressed="${m === "dismissed"}">not for me</button>
    </div></li>`;
}

// ---- browse ---------------------------------------------------------------------
// Desk and stage as places you can go, not only switches you can flip. The counts are
// computed with no filters applied, because a browse page is what you look at BEFORE
// deciding what to narrow to — showing 0 next to "Commodities" because UK-only
// happens to be on would be answering a question nobody asked.
function renderBrowse() {
  const all = state.items;
  const tally = (key) => {
    const m = new Map();
    for (const i of all) m.set(String(i[key]), (m.get(String(i[key])) || 0) + 1);
    return m;
  };
  const card = (kind, v, label, n, sub) =>
    `<button class="bcard${n ? "" : " zero"}" data-go="${kind}/${esc(v)}"
       ${n ? "" : "disabled"}><em>${n}</em><b>${esc(label)}</b>
       <i>${esc(sub)}</i></button>`;

  const desks = tally("desk"), stages = tally("stage");
  const firms = [...tally("firm").entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const uk = (key, v) => all.filter(i => String(i[key]) === v && i.uk).length;

  $("browse").innerHTML =
    `<h2 class="sec">By desk</h2><div class="bgrid">`
    + FACETS.desk.order.map(v => card("desk", v, FACETS.desk.name[v],
        desks.get(v) || 0, `${uk("desk", v)} in the UK`)).join("")
    + `</div><h2 class="sec">By stage</h2><div class="bgrid">`
    + FACETS.stage.order.map(v => card("stage", v, FACETS.stage.name[v],
        stages.get(v) || 0, `${uk("stage", v)} in the UK`)).join("")
    + `</div><h2 class="sec">By firm — ${firms.length} with something open</h2>`
    + `<div class="bgrid">`
    + firms.map(([f, n]) => card("firm", f, f, n,
        `${uk("firm", f)} in the UK`)).join("")
    + `</div>`;
}

// ---- calendar --------------------------------------------------------------------
// The cycle, not just the dates. A board publishes a deadline only if the firm chose
// to, and these roles close when full anyway — so "open, and has been for 128 days"
// is the number that actually decides whether to apply tonight.
function renderCalendar() {
  const c = window.__cal || {};
  if (!c.tracks) { $("calendar").innerHTML = "<div class='empty'>No calendar.</div>"; return; }
  const track = (t) => `<div class="track ${esc(t.phase)}">
      <div class="row1"><b>${esc(t.name)}</b>
        <span class="when">${esc(t.runs || "")}</span></div>
      <div class="who">${esc(t.who || "")}</div>
      <div class="says">${esc(t.says)}${t.urgent ? " — apply now" : ""}</div>
      ${t.closes_note ? `<div class="who">${esc(t.closes_note)}</div>` : ""}
    </div>`;
  const dl = (d) => `<div class="dl"><b>${esc(d.deadline)}</b>
      <span class="left">${d.days_left}d left</span>
      <span class="firm">${esc(d.firm)}</span>
      <span>${(function(){ const u = safeUrl(d.url);
        return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"
          >${esc(d.title)}</a>` : esc(d.title); })()}</span></div>`;

  $("calendar").innerHTML =
    (c.facts || []).map(f => `<div class="fact">${esc(f)}</div>`).join("")
    + `<h2 class="sec">${esc(c.cycle || "")} — where each track is</h2>`
    + (c.tracks || []).map(track).join("")
    + ((c.months || []).length
        ? `<h2 class="sec">What to do next</h2>`
          + c.months.map(m => `<div class="month"><b>${esc(m.month)}</b>
              <span>${esc(m.do)}</span></div>`).join("") : "")
    + `<h2 class="sec">Stated deadlines — ${c.n_deadlines || 0}</h2>`
    + ((c.deadlines || []).length
        ? c.deadlines.map(dl).join("")
        : `<div class="who" style="padding:8px 0">None stated in the next 180 days.</div>`)
    + `<div class="who" style="margin-top:10px">${esc(c.note || "")}</div>`;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// esc() makes a string safe as TEXT. It does not make it safe as a URL: entity-encoding
// leaves "javascript:alert(1)" intact, and it is a perfectly valid href. Every title,
// location and link in this page originates from a third-party API we do not control,
// so the scheme is checked rather than assumed.
function safeUrl(u) {
  if (!u) return "";
  // Deliberately a scheme test rather than `new URL()`. Three reasons:
  //   * URL is unavailable in some JS engines (JavaScriptCore, which the test
  //     harness uses), and depending on it makes this function untestable here
  //   * a throw inside URL() fails closed, silently blocking every legitimate
  //     link in a way indistinguishable from "the feed has no URLs"
  //   * the rule we actually want is one line and readable at a glance
  // Leading control characters and whitespace are stripped first, because browsers
  // ignore them when resolving an href - a newline before "javascript:" is live.
  var t = String(u).replace(/^[\u0000-\u0020]+/, "");
  return /^https?:\/\//i.test(t) ? t : "";
}

function renderStats(d) {
  const c = d.counts;
  // "can't see" sits in the same row, at the same size, as the results. A tracker
  // that shows 197 openings and hides the 13 firms it cannot read is telling you
  // something true in a way that leaves you with a false impression.
  //
  // Three tiles are buttons, because a number you can act on beats a number you have
  // to go and find the control for.
  const tiles = [
    ["open", c.items, "", null],
    ["strong", c.strong, "", "strong"],
    ["UK", c.uk, "", "uk"],
    ["new 24h", c.seen_24h, "", null],
    ["firms watched", c.firms, "", null],
    ["can't see", c.firms_blind, " blind", "blind"],
    ["tracked", c.postings_tracked, "", null],
  ];
  // A silent cap is the same failure as a silent polling gap: the page shows 400 and
  // says nothing about the rest. `counts.truncated` has always been in the feed and
  // only the tests read it. Round 62.
  if (c.truncated) {
    tiles.splice(1, 0, ["not shown", `+${Math.max(0, (c.total || 0) - c.items)}`,
                        " blind", null]);
  }
  $("stats").innerHTML = tiles.filter(([, v]) => v != null).map(([k, v, cls, act]) =>
    act ? `<button class="stat${cls}" data-act="${act}" aria-pressed="${
            act === "blind" ? "false" : String(state[act])
          }"><b>${v}</b><i>${esc(k)}</i></button>`
        : `<div class="stat${cls}"><b>${v}</b><i>${esc(k)}</i></div>`).join("");

  // "208764s" is a true number that nobody can read, and a mean blended across a
  // 60-second tier and a 15-minute one describes no configuration that exists. The
  // headline claim is about tier A, so tier A is reported on its own and the rest
  // are shown beside it rather than averaged into it.
  const dt = d.detection || {};
  const byTier = dt.by_tier || {};
  const TIER = { A: "fast tier, polled every minute", B: "long tail, every 15 min",
                 C: "best-effort boards", D: "page watchers" };
  const a = byTier.A;
  const others = Object.keys(byTier).filter(t => t !== "A").sort()
    .map(t => `${t} ${dur(byTier[t].mean_latency_s)} (${byTier[t].sampled})`);
  $("lat").textContent = a
    ? ` Detection latency, fast tier: ${dur(a.mean_latency_s)} mean over `
      + `${a.sampled} posting${a.sampled === 1 ? "" : "s"}.`
      + (others.length ? ` Other tiers — ${others.join(", ")}.` : "")
    : " No fast-tier detections measured yet, so the headline latency is unproven."
      + (others.length ? ` Slower tiers so far — ${others.join(", ")}.` : "");
  // A gap is "we were not looking", which is not the same as "nothing opened" — the
  // same distinction the blind-spot list exists to make. On 6 Sept the poller lost
  // 41 minutes to a sleeping laptop and the site said nothing.
  const w = dt.watch || {};
  if (w.longest_gap_s >= 300) {
    $("lat").textContent += ` Not watching for ${dur(w.blind_s)} of the last `
      + `${w.hours}h (longest gap ${dur(w.longest_gap_s)}).`;
  }
  $("lat").title = Object.entries(TIER)
    .filter(([t]) => byTier[t]).map(([t, why]) => `${t}: ${why}`).join(" · ");

  // Coverage gaps are shown as prominently as results. A tracker that is quiet
  // because it is not looking is worse than one that is quiet because nothing opened.
  const g = d.gaps || [];
  $("gaps").innerHTML = !g.length ? "" : `<div class="gaps">
    <h2>${g.length} coverage gap${g.length > 1 ? "s" : ""} — watched but silent</h2>
    <ul>${g.map(x => `<li><b>${esc(x.firm)}</b> — ${esc(x.reason)}</li>`).join("")}</ul>
    <div style="margin-top:6px;opacity:.8">These firms may still be hiring somewhere
      this tracker cannot see. Check them by hand.</div></div>`;
}

function renderBlind(bs) {
  window.__blind = bs;
  if (!bs.length) { $("blindwrap").hidden = true; return; }
  $("blindwrap").hidden = false;
  const watched = bs.filter(b => b.kind === "watched");
  const manual  = bs.filter(b => b.kind !== "watched");
  $("blindcount").textContent = `${bs.length} blind spot${bs.length > 1 ? "s" : ""}`;

  const brow = (b) => {
    const d = daysSince(checked[b.firm]);
    const stale = d === null || d > STALE_DAYS;
    const seen = d === null ? "never checked"
               : d < 1 ? "checked today"
               : `checked ${Math.floor(d)}d ago`;
    const link = safeUrl(b.url);
    return `<div class="bs">
      <div class="why"><b>${link ? `<a href="${esc(link)}" target="_blank"
        rel="noopener noreferrer">${esc(b.firm)}</a>` : esc(b.firm)}</b>
        — ${esc(b.why)}</div>
      <div class="chk"><span class="${stale ? "stale" : ""}">${seen}</span>
        <button data-firm="${esc(b.firm)}">mark checked</button></div>
    </div>`;
  };

  $("blind").innerHTML =
    (watched.length ? `<h3>Page-watched — bell tells you the page changed, not what</h3>`
      + watched.map(brow).join("") : "")
    + (manual.length ? `<h3>Manual — bell cannot see these at all</h3>`
      + manual.map(brow).join("") : "")
    + `<div style="margin-top:10px;color:var(--muted)">During a rolling cycle the cost of
       forgetting a spring week is the whole opportunity. Anything unchecked for
       ${STALE_DAYS} days is flagged.</div>`;
}

async function load() {
  try {
    // CONDITIONAL GET, for the same reason every adapter does it: a poll that finds
    // nothing should cost no payload. This asked for the opposite twice over — the
    // `?t=` buster made every request a distinct URL so no validator could match, and
    // `no-store` told the browser not to revalidate either. 122 KB, sixty times an
    // hour, on the phone this exists to notify: 181 MB a day.
    //
    // `no-cache` means "revalidate", not "do not cache". GitHub Pages serves ETag and
    // Last-Modified, and ADR-008 measures the feed changing 2.1 times a day — so
    // essentially every one of these is now a 304 with an empty body. Round 62.
    const r = await fetch("feed.json", { cache: "no-cache" });
    if (r.status === 304) return;          // nothing changed; keep what is rendered
    const d = await r.json();
    state.items = d.items || [];
    renderStats(d);
    renderBlind(d.blindspots || []);
    window.__cal = d.calendar || {};
    $("gen").textContent = "updated " + ago(d.generated_at);
    renderAll();
  } catch (e) {
    $("gen").textContent = "could not load feed.json";
    $("empty").hidden = false;
    $("empty").textContent = "No feed yet. Run: python3 -m bell.feed";
  }
}

// ---- events ------------------------------------------------------------------
function toggle(id, key) {
  $(id).addEventListener("click", () => {
    state[key] = !state[key];
    saveFilters(); renderAll();
  });
}
toggle("fUK", "uk");
toggle("fStrong", "strong");
toggle("fHide", "hideDone");
toggle("fNew", "onlyNew");

$("views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setView(b.dataset.view);
});

$("browse").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-go]");
  if (!b) return;
  location.hash = "#/" + b.dataset.go;      // hashchange re-renders
});

window.addEventListener("hashchange", () => { readHash(); renderAll(); });

$("fFilters").addEventListener("click", () => {
  state.panel = !state.panel; saveFilters(); renderAll();
});
$("fClear").addEventListener("click", clearFilters);
$("sort").addEventListener("change", e => {
  state.sort = e.target.value; saveFilters(); render();
});

// Delegated, because the panel is re-rendered wholesale on every change.
$("panel").addEventListener("click", (e) => {
  if (e.target.closest("#fMoreFirms")) {
    state.allFirms = !state.allFirms; saveFilters(); renderAll(); return;
  }
  const c = e.target.closest("button[data-facet]");
  if (!c) return;
  const set = state[c.dataset.facet];
  if (set.has(c.dataset.v)) set.delete(c.dataset.v); else set.add(c.dataset.v);
  saveFilters(); renderAll();
});

$("pills").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-drop]");
  if (b) dropFilter(b.dataset.drop);
});

$("stats").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  if (b.dataset.act === "blind") {
    $("blindwrap").open = true;
    $("blindwrap").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  state[b.dataset.act] = !state[b.dataset.act];
  saveFilters(); renderAll();
});

// Delegated, because the list is re-rendered wholesale on every filter change.
$("list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-k]");
  if (!b) return;
  const key = decodeURIComponent(b.dataset.k);
  const item = state.items.find(i => markKey(i) === key);
  if (item) mark(item, b.dataset.how);
});

$("blind").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-firm]");
  if (b) markChecked(b.dataset.firm);
});

let qt = null;
$("q").addEventListener("input", e => {
  state.q = e.target.value.trim().toLowerCase();
  clearTimeout(qt); qt = setTimeout(renderAll, 90);
});

// "/" focuses search, Escape clears it. Cheap on a laptop, invisible on a phone.
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("q")) {
    e.preventDefault(); $("q").focus();
  } else if (e.key === "Escape" && document.activeElement === $("q")) {
    $("q").value = ""; state.q = ""; renderAll();
  }
});

// ---- push subscription -----------------------------------------------------
const urlB64 = (b64) => {
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
};

$("fNotify").addEventListener("click", async () => {
  const note = $("note");
  if (!VAPID_PUBLIC_KEY) {
    note.textContent = "Set VAPID_PUBLIC_KEY in app.js first "
      + "(python3 -m bell.notify keys).";
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    note.textContent = "This browser has no Web Push. On iOS you must Add to Home "
      + "Screen and open it from the icon — push does not exist in a Safari tab.";
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    // Must run INSIDE the click handler — iOS fails silently otherwise.
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { note.textContent = "Permission denied."; return; }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64(VAPID_PUBLIC_KEY),
    });
    const json = JSON.stringify(sub.toJSON(), null, 1);

    // Hand it straight to bell if this origin will take it. `python3 -m bell.notify
    // serve` accepts POST /sub on localhost; GitHub Pages is static and will not,
    // so the manual path below stays as the fallback rather than the default. The
    // copy-and-carry step is why no push had ever reached a device.
    let posted = false;
    try {
      const r = await fetch("sub", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: json,
      });
      posted = r.ok;
    } catch (_) { /* static host: fall through */ }

    if (posted) {
      note.innerHTML = "Subscribed — bell has this device. Prove it end to end with "
        + "<code>python3 -m bell.notify test</code>.";
      return;
    }
    // Static host. Show the JSON as selectable text as well as copying it: the
    // clipboard API is refused often enough on iOS that a promise nobody awaited is
    // not a delivery mechanism.
    await navigator.clipboard?.writeText(json).catch(() => {});
    note.innerHTML = "Subscribed in the browser, but this origin is static so bell "
      + "does not have it yet. It is on your clipboard, and here:"
      + `<textarea readonly rows="4" onclick="this.select()"
           style="width:100%;margin-top:6px;font:11px/1.4 ui-monospace,monospace;
                  border:1px solid var(--line);border-radius:8px;padding:6px;
                  background:var(--bg);color:var(--ink)">${esc(json)}</textarea>`
      + "Save it as <code>subs/phone.json</code> in the repo, or run "
      + "<code>python3 -m bell.notify addsub --file phone.json</code>.";
  } catch (e) {
    note.textContent = "Subscribe failed: " + e.message;
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
readHash();
load();
setInterval(load, 60000);

/*
 * FHIRView — a read-only, Compass-style query lab for FHIR R4 servers.
 *
 * Safety rules this file keeps (check them, they are short):
 *   1. Only GET requests. There is exactly one function that talks to the network: fhirGet().
 *   2. The token lives in one variable (conn.token) and is sent only as an Authorization header to the
 *      connected base URL. It is never written to storage, URLs, the DOM, the console or the clipboard.
 *   3. Server data is rendered with textContent / createElement only — never innerHTML.
 *   4. Links from the server (paging) are followed only if they point at the connected base URL.
 *   5. Query history is stored in localStorage WITHOUT the base URL (tenant segments stay private).
 * The Content-Security-Policy in index.html additionally limits where the browser may connect.
 */
"use strict";

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

/** createElement with safe attributes and text-only children. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

// Readable query-string encoding: encode, then restore characters that are safe and common in FHIR.
function enc(v) {
  return encodeURIComponent(v)
    .replace(/%2C/gi, ",").replace(/%3A/gi, ":").replace(/%7C/gi, "|").replace(/%2F/gi, "/");
}
function dec(v) {
  try { return decodeURIComponent(v.replace(/\+/g, " ")); } catch { return v; }
}

// ---------------------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------------------

const SERVERS = {
  medblocks: { prefix: "https://challenge.fhir.medblocks.com/", label: "Medblocks challenge" },
  hapi: { base: "https://hapi.fhir.org/baseR4", label: "HAPI public test server" },
};

/** @type {{kind:string, base:string, token:string, host:string, software:string, fhirVersion:string, types:Map<string,any>}|null} */
let conn = null;

const GLOBAL_PARAMS = [
  { name: "_id", type: "token", documentation: "Logical id of the resource" },
  { name: "_lastUpdated", type: "date", documentation: "When the resource last changed on the server" },
  { name: "_tag", type: "token", documentation: "Tags in meta.tag (system|code)" },
  { name: "_profile", type: "uri", documentation: "Profiles the resource claims in meta.profile" },
  { name: "_security", type: "token", documentation: "Security labels in meta.security" },
  { name: "_has", type: "special", documentation: "Reverse chaining, e.g. _has:Observation:patient:code=1234-5" },
];

const COMMON_TYPES = [
  "Patient", "Practitioner", "PractitionerRole", "Organization", "Location", "Encounter", "Appointment",
  "Observation", "Condition", "MedicationRequest", "AllergyIntolerance", "Procedure", "Immunization",
  "DiagnosticReport", "ServiceRequest", "DocumentReference", "CarePlan", "Claim",
];

/**
 * The only network function. GET only, to the connected base only.
 * @param {string} pathOrUrl "Patient?name=x" (relative to base) or an absolute URL from the server
 */
async function fhirGet(pathOrUrl) {
  if (!conn) throw new Error("Not connected");
  let url;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    // Servers (HAPI behind a proxy) often send http:// links even when you called https://.
    url = pathOrUrl.replace(/^http:\/\//i, "https://");
    if (!url.startsWith(conn.base + "/") && !url.startsWith(conn.base + "?") && url !== conn.base) {
      throw new Error("That link points outside the connected server, so it was not followed.");
    }
  } else {
    url = `${conn.base}/${pathOrUrl.replace(/^\/+/, "")}`;
  }
  const headers = { Accept: "application/fhir+json" };
  if (conn.token) headers.Authorization = `Bearer ${conn.token}`;

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { method: "GET", headers, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    throw new Error("The request could not be sent (network error, CORS, or blocked by this page's security policy).");
  }
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  const bytes = new TextEncoder().encode(text).length;
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { url, rel: relative(url), status: res.status, ok: res.ok, ms, bytes, json, text };
}

/** URL shown to the user: the base (and its tenant segment) is never displayed. */
function relative(url) {
  if (conn && url.startsWith(conn.base)) return url.slice(conn.base.length).replace(/^\/?/, "");
  return url;
}

function parseCapability(cap) {
  const types = new Map();
  const rest = (cap.rest || []).find((r) => r.mode === "server") || (cap.rest || [])[0] || {};
  for (const r of rest.resource || []) {
    types.set(r.type, {
      type: r.type,
      params: [...(r.searchParam || []).map((p) => ({ name: p.name, type: p.type, documentation: p.documentation || "" })), ...GLOBAL_PARAMS]
        .filter((p, i, arr) => arr.findIndex((q) => q.name === p.name) === i)
        .sort((a, b) => a.name.localeCompare(b.name)),
      includes: (r.searchInclude || []).filter((x) => x && x !== "*"),
      revincludes: (r.searchRevInclude || []).filter((x) => x && x !== "*"),
    });
  }
  return types;
}

async function connect(ev) {
  ev.preventDefault();
  const kind = document.querySelector('input[name="server"]:checked').value;
  const err = $("connect-error");
  err.hidden = true;
  let base, token = "";
  if (kind === "hapi") {
    base = SERVERS.hapi.base;
  } else {
    base = $("base-url").value.trim().replace(/\/+$/, "");
    token = $("token").value.trim().replace(/^Bearer\s+/i, "");
    if (!base.startsWith(SERVERS.medblocks.prefix)) {
      return showConnectError(`The base URL must start with ${SERVERS.medblocks.prefix}`);
    }
    if (!token) return showConnectError("Paste your bearer token.");
  }
  const btn = $("connect-btn");
  btn.disabled = true; btn.textContent = "Connecting…";
  conn = { kind, base, token, host: new URL(base).host, software: "", fhirVersion: "", types: new Map() };
  try {
    const r = await fhirGet("metadata");
    if (r.status === 401 || r.status === 403) throw new Error("The server refused the token (" + r.status + "). Check the base URL and token.");
    if (!r.ok || !r.json || r.json.resourceType !== "CapabilityStatement") {
      throw new Error(`The server did not return a CapabilityStatement (HTTP ${r.status}).`);
    }
    conn.types = parseCapability(r.json);
    conn.software = [r.json.software?.name, r.json.software?.version].filter(Boolean).join(" ");
    conn.fhirVersion = r.json.fhirVersion || "";
    $("token").value = ""; // the only copy is now conn.token
    enterWorkspace();
  } catch (e) {
    conn = null;
    showConnectError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Connect";
  }
}

function showConnectError(msg) {
  const err = $("connect-error");
  err.textContent = msg;
  err.hidden = false;
}

function disconnect() {
  conn = null;
  state = freshState(null);
  last = null;
  navStack.length = 0;
  counts.clear();
  $("workspace").hidden = true;
  $("connect-view").hidden = false;
  $("disconnect").hidden = true;
  $("conn-status").textContent = "Not connected";
  $("conn-status").classList.remove("on");
  clear($("results"));
  $("results").append(h("p", { class: "empty", text: "Pick a resource type on the left, then Find." }));
}

// ---------------------------------------------------------------------------------------------
// Workspace: sidebar
// ---------------------------------------------------------------------------------------------

const counts = new Map();

function enterWorkspace() {
  $("connect-view").hidden = true;
  $("workspace").hidden = false;
  $("disconnect").hidden = false;
  const st = $("conn-status");
  st.textContent = `● Connected · ${conn.host}${conn.kind === "medblocks" ? " (tenant hidden)" : ""}` +
    (conn.software ? ` · ${conn.software}` : "") + (conn.fhirVersion ? ` · FHIR ${conn.fhirVersion}` : "");
  st.classList.add("on");
  renderSidebar();
  renderExamples();
  renderHistory();
  selectType(conn.types.has("Patient") ? "Patient" : [...conn.types.keys()][0], true);
}

function renderSidebar() {
  const filter = $("type-filter").value.trim().toLowerCase();
  const common = COMMON_TYPES.filter((t) => conn.types.has(t));
  const all = [...conn.types.keys()].sort();
  for (const [listId, items] of [["types-common", common], ["types-all", all]]) {
    const ul = $(listId);
    clear(ul);
    for (const t of items) {
      if (filter && !t.toLowerCase().includes(filter)) continue;
      const c = counts.get(t);
      ul.append(h("li", null,
        h("button", {
          class: "type" + (state.type === t ? " active" : ""),
          "aria-current": state.type === t ? "true" : null,
          onclick: () => selectType(t, true),
        }, h("span", { class: "tname", text: t }), h("span", { class: "tcount", text: c === undefined ? "" : c === null ? "?" : c.toLocaleString() }))));
    }
  }
}

async function countType(t) {
  try {
    const r = await fhirGet(`${t}?_summary=count`);
    counts.set(t, r.ok && r.json && typeof r.json.total === "number" ? r.json.total : null);
  } catch { counts.set(t, null); }
  renderSidebar();
}

let countAllArmed = false;
async function countAll() {
  const btn = $("count-all");
  const types = [...conn.types.keys()].filter((t) => !counts.has(t));
  if (!types.length) return toast("All types are counted.");
  if (!countAllArmed) {
    countAllArmed = true;
    btn.textContent = `Sure? ${types.length} requests`;
    setTimeout(() => { countAllArmed = false; btn.textContent = "Count all"; }, 4000);
    return;
  }
  countAllArmed = false;
  btn.disabled = true;
  let i = 0;
  const worker = async () => {
    while (i < types.length && conn) {
      const t = types[i++];
      btn.textContent = `Counting ${i}/${types.length}`;
      await countType(t);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  btn.disabled = false;
  btn.textContent = "Count all";
}

// ---------------------------------------------------------------------------------------------
// Query state and builder
// ---------------------------------------------------------------------------------------------

function freshState(type) {
  return { type, filters: [], elements: "", summaryTrue: false, sort: "", sortDir: "", count: 20, includes: new Set(), revincludes: new Set() };
}
let state = freshState(null);

const PREFIX_TYPES = new Set(["date", "number", "quantity"]);
const PREFIXES = ["", "eq", "ne", "gt", "lt", "ge", "le", "sa", "eb", "ap"];
const MODIFIERS = {
  string: ["", "exact", "contains", "missing"],
  token: ["", "text", "not", "missing", "of-type"],
  reference: ["", "missing", "identifier"],
  date: ["", "missing"], number: ["", "missing"], quantity: ["", "missing"],
  uri: ["", "below", "above", "missing"],
};

function typeInfo() { return conn?.types.get(state.type); }
function paramInfo(name) {
  const base = name && name.startsWith("_has:") ? "_has" : name;
  return typeInfo()?.params.find((p) => p.name === base);
}

function selectType(t, run) {
  state = freshState(t);
  navStack.length = 0;
  renderBuilder();
  renderSidebar();
  $("current-type").textContent = t;
  if (!counts.has(t)) countType(t);
  if (run) runQuery();
}

function renderBuilder() {
  const info = typeInfo();
  // filters
  const box = $("filters");
  clear(box);
  state.filters.forEach((f, idx) => box.append(filterRow(f, idx)));

  // params datalist (shared)
  let dl = $("param-list");
  if (!dl) { dl = h("datalist", { id: "param-list" }); document.body.append(dl); }
  clear(dl);
  for (const p of info?.params || []) dl.append(h("option", { value: p.name, label: `${p.type}${p.documentation ? " · " + p.documentation.slice(0, 80) : ""}` }));

  $("elements").value = state.elements;
  $("summary-true").checked = state.summaryTrue;
  $("count").value = state.count;

  const sort = $("sort");
  clear(sort);
  sort.append(h("option", { value: "", text: "— none —" }));
  for (const p of (info?.params || []).filter((p) => !["special", "composite"].includes(p.type) && p.name !== "_has")) {
    sort.append(h("option", { value: p.name, text: p.name }));
  }
  sort.value = state.sort;
  $("sort-dir").value = state.sortDir;

  renderMulti("include-list", "include-box", "Include", info?.includes || [], state.includes);
  renderMulti("revinclude-list", "revinclude-box", "Rev-include", info?.revincludes || [], state.revincludes);
  updateRaw();
}

function renderMulti(listId, boxId, label, options, set) {
  const list = $(listId);
  clear(list);
  if (!options.length) list.append(h("p", { class: "muted small", text: "The server lists none for this type." }));
  for (const o of options) {
    const id = `${listId}-${o}`;
    list.append(h("label", { class: "check", for: id },
      h("input", { type: "checkbox", id, checked: set.has(o), onchange: (e) => { e.target.checked ? set.add(o) : set.delete(o); summaryLabel(); updateRaw(); } }),
      " ", o));
  }
  const summaryLabel = () => {
    $(boxId).querySelector("summary").textContent = set.size ? `${label}: ${[...set].join(", ")}` : `${label}: none`;
  };
  summaryLabel();
}

function filterRow(f, idx) {
  const info = () => paramInfo(f.param);
  const mod = h("select", { "aria-label": "Modifier" });
  const pre = h("select", { "aria-label": "Prefix" });
  const val = h("input", { value: f.value, spellcheck: "false", placeholder: "value", "aria-label": "Value" });
  const param = h("input", { list: "param-list", value: f.param, spellcheck: "false", placeholder: "parameter", "aria-label": "Search parameter" });
  const hint = h("span", { class: "phint" });

  const refresh = () => {
    const p = info();
    const t = p?.type || "string";
    clear(mod);
    const mods = [...(MODIFIERS[t] || [""])];
    if (f.modifier && !mods.includes(f.modifier)) mods.push(f.modifier); // keep what was typed in the raw query
    for (const m of mods) mod.append(h("option", { value: m, text: m ? ":" + m : "—" }));
    mod.value = f.modifier || "";
    clear(pre);
    for (const x of PREFIXES) pre.append(h("option", { value: x, text: x || "=" }));
    pre.value = f.prefix || "";
    pre.hidden = !PREFIX_TYPES.has(t) || f.modifier === "missing";
    val.placeholder = f.modifier === "missing" ? "true or false" : placeholderFor(t, f.param);
    hint.textContent = p ? p.type : f.param ? "not listed for this type" : "";
    hint.title = p?.documentation || "";
    hint.classList.toggle("warn", Boolean(f.param) && !p);
  };
  param.addEventListener("input", () => { f.param = param.value.trim(); refresh(); updateRaw(); });
  mod.addEventListener("change", () => { f.modifier = mod.value; refresh(); updateRaw(); });
  pre.addEventListener("change", () => { f.prefix = pre.value; updateRaw(); });
  val.addEventListener("input", () => { f.value = val.value; updateRaw(); });
  refresh();
  return h("div", { class: "frow" }, param, mod, pre, val, hint,
    h("button", { class: "btn tiny ghost", "aria-label": "Remove filter", title: "Remove", onclick: () => { state.filters.splice(idx, 1); renderBuilder(); } }, "✕"));
}

function placeholderFor(type, name) {
  if (type === "date") return "2026-11-20";
  if (type === "token") return name === "gender" ? "female" : "system|code or code";
  if (type === "reference") return "Patient/123";
  if (type === "number") return "5";
  if (type === "quantity") return "5.4|http://unitsofmeasure.org|mg";
  return "text";
}

/** The query (type + query string) the builder describes. */
function buildQuery(s = state, opts = {}) {
  const parts = [];
  for (const f of s.filters) {
    if (!f.param) continue;
    const name = f.param + (f.modifier ? ":" + f.modifier : "");
    const value = (f.prefix && f.modifier !== "missing" ? f.prefix : "") + (f.value ?? "");
    parts.push(`${name}=${enc(value)}`);
  }
  const hasIncludes = s.includes.size + s.revincludes.size > 0;
  const elements = opts.elements !== undefined ? opts.elements : s.elements;
  if (elements && !opts.noProjection) parts.push(`_elements=${enc(qualifyElements(elements, s.type, hasIncludes))}`);
  if ((opts.summaryTrue ?? s.summaryTrue) && !opts.noProjection) parts.push("_summary=true");
  if (s.sort) parts.push(`_sort=${s.sortDir}${s.sort}`);
  if (s.count) parts.push(`_count=${s.count}`);
  if (!opts.noIncludes) {
    for (const i of s.includes) parts.push(`_include=${enc(i)}`);
    for (const i of s.revincludes) parts.push(`_revinclude=${enc(i)}`);
  }
  return `${s.type}${parts.length ? "?" + parts.join("&") : ""}`;
}

/**
 * With _include/_revinclude, HAPI applies an unqualified _elements to every resource in the Bundle, so
 * results come back trimmed in unexpected ways. Qualifying each element (Patient.name) avoids that.
 */
function qualifyElements(elements, type, hasIncludes) {
  const items = elements.split(",").map((x) => x.trim()).filter(Boolean);
  if (!hasIncludes) return items.join(",");
  return items.map((x) => (x.includes(".") ? x : `${type}.${x}`)).join(",");
}

function updateRaw() {
  if (!state.type) return;
  $("raw").value = buildQuery();
  const hasIncludes = state.includes.size + state.revincludes.size > 0;
  $("builder-note").textContent = hasIncludes && state.elements
    ? `_elements qualified as ${state.type}.… because of includes (HAPI quirk)` : "";
}

/** Parses "Type?a=b&c=d" back into the builder. Unknown things become filter rows. */
function parseRaw(raw) {
  raw = raw.trim().replace(/^\[base\]\/?/, "");
  if (conn && raw.startsWith(conn.base)) raw = raw.slice(conn.base.length).replace(/^\//, "");
  const [path, qs = ""] = raw.split("?");
  const type = path.split("/")[0];
  if (!conn.types.has(type)) throw new Error(`"${type}" is not a resource type this server lists.`);
  const s = freshState(type);
  s.count = 0;
  for (const pair of qs.split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const name = dec(eq < 0 ? pair : pair.slice(0, eq));
    const value = dec(eq < 0 ? "" : pair.slice(eq + 1));
    if (name === "_elements") s.elements = value.split(",").map((x) => x.replace(new RegExp(`^${type}\\.`), "")).join(",");
    else if (name === "_summary" && value === "true") s.summaryTrue = true;
    else if (name === "_sort") { s.sortDir = value.startsWith("-") ? "-" : ""; s.sort = value.replace(/^-/, ""); }
    else if (name === "_count") s.count = Number(value) || 20;
    else if (name === "_include") s.includes.add(value);
    else if (name === "_revinclude") s.revincludes.add(value);
    else {
      const hasChain = name.startsWith("_has:");
      const param = hasChain ? name : name.split(":")[0];
      const modifier = hasChain || !name.includes(":") ? "" : name.slice(param.length + 1);
      const ptype = conn.types.get(type)?.params.find((p) => p.name === param)?.type;
      let prefix = "", v = value;
      const m = PREFIX_TYPES.has(ptype) && modifier !== "missing" ? /^(eq|ne|gt|lt|ge|le|sa|eb|ap)(.*)$/.exec(value) : null;
      if (m) { prefix = m[1]; v = m[2]; }
      s.filters.push({ param, modifier, prefix, value: v });
    }
  }
  if (!s.count) s.count = 20;
  return { state: s, isRead: /^[A-Za-z]+\/[^/?]+$/.test(path) ? path : null };
}

// ---------------------------------------------------------------------------------------------
// Running queries
// ---------------------------------------------------------------------------------------------

/** @type {null|{r:any, query:string, kind:'search'|'read'|'page'}} */
let last = null;
const navStack = [];
let running = false;

async function runQuery() {
  if (!conn || !state.type || running) return;
  const query = buildQuery();
  pushHistory(query);
  await load(query, "search");
}

async function runRaw() {
  try {
    const { state: s, isRead } = parseRaw($("raw").value);
    if (isRead) { await openRef(isRead, false); return; }
    state = s;
    renderBuilder();
    renderSidebar();
    $("current-type").textContent = s.type;
    await runQuery();
  } catch (e) {
    toast(e.message);
  }
}

async function load(pathOrUrl, kind) {
  running = true;
  const btn = $("run");
  btn.disabled = true; btn.textContent = "Finding…";
  $("results").classList.add("loading");
  try {
    const r = await fhirGet(pathOrUrl);
    last = { r, query: r.rel, kind };
    render();
  } catch (e) {
    toast(e.message);
  } finally {
    running = false;
    btn.disabled = false; btn.textContent = "Find";
    $("results").classList.remove("loading");
  }
}

async function openRef(ref, push = true) {
  if (push && last) navStack.push(last);
  await load(ref, "read");
}

function goBack() {
  const prev = navStack.pop();
  if (prev) { last = prev; render(); }
}

async function page(rel) {
  const link = last?.r.json?.link?.find((l) => l.relation === rel || (rel === "previous" && l.relation === "prev"));
  if (!link) return;
  await load(link.url, "page");
}

async function countTotal() {
  if (!state.type) return;
  const q = buildQuery(state, { noProjection: true, noIncludes: true }).replace(/([?&])_count=\d+&?/, "$1").replace(/[?&]$/, "");
  const r = await fhirGet(q + (q.includes("?") ? "&" : "?") + "_summary=count").catch((e) => { toast(e.message); return null; });
  if (r?.ok && typeof r.json?.total === "number") toast(`${r.json.total.toLocaleString()} ${state.type} resources match (${r.ms} ms)`);
  else if (r) toast(`Count failed (HTTP ${r.status})`);
}

// ---------------------------------------------------------------------------------------------
// Rendering results
// ---------------------------------------------------------------------------------------------

let view = "list";

function entriesOf(json) {
  if (!json) return { matches: [], includes: [], outcomes: [] };
  if (json.resourceType !== "Bundle") return { matches: json.resourceType === "OperationOutcome" ? [] : [json], includes: [], outcomes: json.resourceType === "OperationOutcome" ? [json] : [] };
  const matches = [], includes = [], outcomes = [];
  for (const e of json.entry || []) {
    if (!e.resource) continue;
    if (e.search?.mode === "outcome" || e.resource.resourceType === "OperationOutcome") outcomes.push(e.resource);
    else if (e.search?.mode === "include") includes.push(e.resource);
    else matches.push(e.resource);
  }
  return { matches, includes, outcomes };
}

function render() {
  const { r } = last;
  renderReqLine(r);
  renderExplain();
  const out = $("results");
  clear(out);
  $("back").hidden = navStack.length === 0;
  const links = r.json?.link || [];
  $("next").disabled = !links.some((l) => l.relation === "next");
  $("prev").disabled = !links.some((l) => l.relation === "previous" || l.relation === "prev");

  if (!r.json) {
    out.append(h("p", { class: "error", text: `HTTP ${r.status}: the server did not return JSON.` }), h("pre", { class: "json", text: r.text.slice(0, 4000) }));
    return;
  }
  const { matches, includes, outcomes } = entriesOf(r.json);
  for (const o of outcomes) out.append(outcomeBox(o, r.status));
  if (r.json.resourceType === "Bundle") {
    const total = typeof r.json.total === "number" ? ` of ${r.json.total.toLocaleString()}` : "";
    const off = Number(/[?&](?:_offset|_getpagesoffset)=(\d+)/.exec(r.url)?.[1] || 0);
    const range = matches.length ? (off ? `${off + 1}–${off + matches.length}` : `${matches.length}`) : "0";
    out.append(h("p", { class: "muted small", text: `${off ? "Showing " : ""}${range}${total}${off ? "" : " shown"}${includes.length ? ` · ${includes.length} included` : ""}` }));
  }
  updateElementChips(matches);

  if (view === "json") {
    out.append(h("pre", { class: "json", text: JSON.stringify(r.json, null, 2) }));
    return;
  }
  if (!matches.length && !outcomes.length) out.append(h("p", { class: "empty", text: "No resources matched." }));
  if (view === "table") {
    if (matches.length) out.append(table(matches));
    if (includes.length) out.append(h("h3", { class: "inc-h", text: `Included (${includes.length})` }), table(includes));
    return;
  }
  matches.forEach((res, i) => out.append(docCard(res, i === 0 && matches.length === 1)));
  if (includes.length) {
    out.append(h("h3", { class: "inc-h", text: `Included (${includes.length})` }));
    includes.forEach((res) => out.append(docCard(res, false)));
  }
}

function renderReqLine(r) {
  const el = $("reqline");
  clear(el);
  el.hidden = false;
  el.append(
    h("span", { class: "method", text: "GET" }),
    h("code", { class: "rel", text: "[base]/" + r.rel, title: "The base URL is hidden so screenshots don't reveal your tenant" }),
    h("span", { class: "stat " + (r.ok ? "ok" : "bad"), text: String(r.status) }),
    h("span", { text: `${r.ms} ms` }),
    h("span", { text: fmtBytes(r.bytes) }),
  );
}

function outcomeBox(o, status) {
  return h("div", { class: "outcome" },
    h("strong", { text: `OperationOutcome (HTTP ${status})` }),
    h("ul", null, (o.issue || []).map((i) => h("li", { text: `${i.severity || ""} ${i.code || ""}: ${i.diagnostics || i.details?.text || ""}` }))));
}

// --- summaries -------------------------------------------------------------------------------

const cc = (c) => !c ? "" : Array.isArray(c) ? cc(c[0]) : c.text || c.coding?.[0]?.display || c.coding?.[0]?.code || "";
const nm = (n) => {
  const x = Array.isArray(n) ? n.find((y) => y.use === "official") || n[0] : n;
  if (!x) return "";
  return x.text || [...(x.prefix || []), ...(x.given || []), x.family].filter(Boolean).join(" ");
};
const dt = (v) => (typeof v === "string" ? v.replace("T", " ").replace(/:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)?$/, "") : "");
function qty(q) { return q ? `${q.value ?? ""} ${q.unit || q.code || ""}`.trim() : ""; }
function obsValue(o) {
  if (o.valueQuantity) return qty(o.valueQuantity);
  if (o.valueCodeableConcept) return cc(o.valueCodeableConcept);
  if (o.valueString) return o.valueString;
  if (o.valueBoolean !== undefined) return String(o.valueBoolean);
  if (o.valueInteger !== undefined) return String(o.valueInteger);
  if (o.component?.length) return o.component.map((c) => c.valueQuantity?.value ?? cc(c.valueCodeableConcept)).join(" / ") + (o.component[0]?.valueQuantity?.unit ? " " + o.component[0].valueQuantity.unit : "");
  return o.dataAbsentReason ? "(absent)" : "";
}

function summarize(r) {
  switch (r.resourceType) {
    case "Patient": return [nm(r.name), r.gender, r.birthDate, r.identifier?.[0]?.value].filter(Boolean).join(" · ");
    case "Practitioner": case "RelatedPerson": return [nm(r.name), r.gender].filter(Boolean).join(" · ");
    case "Organization": case "Location": return [r.name, r.address?.[0]?.city].filter(Boolean).join(" · ");
    case "Observation": return [cc(r.code), obsValue(r), dt(r.effectiveDateTime || r.effectivePeriod?.start), r.status].filter(Boolean).join(" · ");
    case "Condition": return [cc(r.code), cc(r.clinicalStatus), dt(r.onsetDateTime || r.recordedDate)].filter(Boolean).join(" · ");
    case "Encounter": return [r.status, r.class?.code, cc(r.type), dt(r.period?.start)].filter(Boolean).join(" · ");
    case "MedicationRequest": return [cc(r.medicationCodeableConcept) || r.medicationReference?.display || r.medicationReference?.reference, r.status, r.dosageInstruction?.[0]?.text].filter(Boolean).join(" · ");
    case "Appointment": return [r.status, dt(r.start), r.description || cc(r.serviceType)].filter(Boolean).join(" · ");
    case "AllergyIntolerance": return [cc(r.code), cc(r.clinicalStatus), r.criticality].filter(Boolean).join(" · ");
    case "Procedure": case "Immunization": return [cc(r.code || r.vaccineCode), r.status, dt(r.performedDateTime || r.occurrenceDateTime || r.performedPeriod?.start)].filter(Boolean).join(" · ");
    case "DiagnosticReport": case "ServiceRequest": return [cc(r.code), r.status, dt(r.effectiveDateTime || r.authoredOn)].filter(Boolean).join(" · ");
    case "DocumentReference": return [cc(r.type), r.status, dt(r.date)].filter(Boolean).join(" · ");
    default: return [r.name && (typeof r.name === "string" ? r.name : nm(r.name)), r.title, cc(r.code || r.type), r.status, r.description].filter(Boolean).join(" · ");
  }
}

// --- documents ------------------------------------------------------------------------------

const REF_RE = /^[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/;

function docCard(res, open) {
  const ref = `${res.resourceType}/${res.id}`;
  const body = h("div", { class: "tree" });
  let built = false;
  const det = h("details", { class: "doc", open: open || null },
    h("summary", null,
      h("span", { class: "badge", text: res.resourceType }),
      h("span", { class: "sum", text: summarize(res) || "(no summary)" }),
      h("span", { class: "id muted", text: res.id ? `id ${res.id}` : "" }),
      res.meta?.lastUpdated ? h("span", { class: "muted small", text: `updated ${dt(res.meta.lastUpdated)}` }) : null),
    body);
  const build = () => { if (!built) { built = true; body.append(tree(res, 0)); } };
  det.addEventListener("toggle", () => { if (det.open) build(); });
  if (open) build();
  det.dataset.ref = ref;
  return det;
}

function tree(v, depth, key) {
  if (v === null || typeof v !== "object") {
    const cls = typeof v === "string" ? "s" : typeof v === "number" ? "n" : "b";
    if (key === "reference" && typeof v === "string" && REF_RE.test(v)) {
      return h("button", { class: "ref", title: `Open ${v}`, onclick: () => openRef(v) }, v);
    }
    if (key === "div" && typeof v === "string") return h("span", { class: "s muted", text: `(XHTML, ${v.length} chars)` });
    return h("span", { class: cls, text: typeof v === "string" ? `"${v}"` : String(v) });
  }
  const isArr = Array.isArray(v);
  const keys = isArr ? v.map((_, i) => i) : Object.keys(v);
  const list = h("ul", { class: "kv" });
  for (const k of keys) {
    const child = v[k];
    const isObj = child !== null && typeof child === "object";
    if (isObj) {
      const size = Array.isArray(child) ? `[${child.length}]` : `{${Object.keys(child).length}}`;
      const inner = h("div");
      let built = false;
      const d = h("details", { open: depth < 1 ? true : null },
        h("summary", null, h("span", { class: "k", text: isArr ? `${k}` : k }), h("span", { class: "muted", text: " " + size + " " + preview(child) })),
        inner);
      const build = () => { if (!built) { built = true; inner.append(tree(child, depth + 1, k)); } };
      d.addEventListener("toggle", () => { if (d.open) build(); });
      if (depth < 1) build();
      list.append(h("li", null, d));
    } else {
      list.append(h("li", null, h("span", { class: "k", text: isArr ? `${k}` : k }), ": ", tree(child, depth + 1, k)));
    }
  }
  return list;
}

function preview(v) {
  if (Array.isArray(v)) return v.length ? short(v[0]).slice(0, 60) : "";
  return short(v).slice(0, 60);
}

/** Short human text for any value (tables and previews). */
function short(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(short).filter(Boolean).join("; ");
  if (v.reference || v.display) return v.display || v.reference;
  if (v.coding || v.text) return cc(v);
  if (v.given || v.family) return nm(v);
  if (v.value !== undefined && (v.unit || v.code)) return qty(v);
  if (v.start || v.end) return `${dt(v.start)} – ${dt(v.end)}`;
  if (v.system && v.value) return v.value;
  if (v.code && v.display) return v.display;
  if (v.line || v.city) return [...(v.line || []), v.city, v.postalCode].filter(Boolean).join(", ");
  return Object.keys(v).slice(0, 3).join(", ") + (Object.keys(v).length > 3 ? "…" : "");
}

function table(resources) {
  const skip = new Set(["resourceType", "meta", "text", "contained", "id"]);
  const freq = new Map();
  for (const r of resources) for (const k of Object.keys(r)) if (!skip.has(k)) freq.set(k, (freq.get(k) || 0) + 1);
  const cols = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k]) => k);
  const wrap = h("div", { class: "tablewrap" });
  const t = h("table", { class: "grid" });
  t.append(h("thead", null, h("tr", null, h("th", { text: "id" }), cols.map((c) => h("th", { text: c })))));
  const tb = h("tbody");
  for (const r of resources) {
    tb.append(h("tr", null,
      h("td", null, h("button", { class: "ref", onclick: () => openRef(`${r.resourceType}/${r.id}`) }, r.id || "")),
      cols.map((c) => {
        const s = short(r[c]);
        return h("td", { title: s.length > 80 ? s : null, text: s.length > 80 ? s.slice(0, 79) + "…" : s });
      })));
  }
  t.append(tb);
  wrap.append(t);
  return wrap;
}

// --- projection chips -------------------------------------------------------------------------

function updateElementChips(matches) {
  const dl = $("element-list");
  const keys = new Set();
  for (const r of matches) for (const k of Object.keys(r)) if (!["resourceType", "id", "meta"].includes(k)) keys.add(k);
  if (!keys.size) return;
  clear(dl);
  for (const k of [...keys].sort()) dl.append(h("option", { value: k }));
  let chips = $("element-chips");
  if (!chips) {
    chips = h("div", { id: "element-chips", class: "chips", "aria-label": "Fields seen in the results — click to add to _elements" });
    $("elements").parentElement.append(chips);
  }
  clear(chips);
  const current = () => new Set(state.elements.split(",").map((x) => x.trim()).filter(Boolean));
  for (const k of [...keys].sort()) {
    chips.append(h("button", {
      class: "chip" + (current().has(k) ? " on" : ""),
      "aria-pressed": current().has(k) ? "true" : "false",
      onclick: (e) => {
        const set = current();
        set.has(k) ? set.delete(k) : set.add(k);
        state.elements = [...set].join(",");
        $("elements").value = state.elements;
        e.target.classList.toggle("on");
        e.target.setAttribute("aria-pressed", set.has(k) ? "true" : "false");
        updateRaw();
      },
    }, k));
  }
}

// ---------------------------------------------------------------------------------------------
// Explain + Make it leaner
// ---------------------------------------------------------------------------------------------

function renderExplain() {
  const out = $("explain");
  clear(out);
  if (!last) return;
  const { r } = last;
  const { matches, includes } = entriesOf(r.json);
  const rows = [
    ["Request", "GET [base]/" + r.rel],
    ["Status", String(r.status)],
    ["Time", `${r.ms} ms (browser → server → browser, including download)`],
    ["Payload", `${fmtBytes(r.bytes)} of JSON (after decompression)`],
    ["Results", r.json?.resourceType === "Bundle" ? `${matches.length} matches, ${includes.length} included` : r.json?.resourceType || "—"],
    ["Total", typeof r.json?.total === "number" ? r.json.total.toLocaleString() : "not returned — use Count total (_summary=count)"],
    ["More pages", r.json?.link?.some((l) => l.relation === "next") ? "yes — Next follows the server's link" : "no"],
    ["Server", [conn.software, conn.fhirVersion && "FHIR " + conn.fhirVersion].filter(Boolean).join(" · ") || "—"],
  ];
  out.append(h("table", { class: "kvtable" }, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("th", { text: k }), h("td", null, h("code", { text: v })))))));

  // Parameter breakdown with the server's own documentation.
  const qs = r.rel.split("?")[1];
  const type = r.rel.split(/[/?]/)[0];
  if (qs && conn.types.has(type)) {
    const info = conn.types.get(type);
    const list = h("table", { class: "grid params" },
      h("thead", null, h("tr", null, h("th", { text: "Parameter" }), h("th", { text: "Value" }), h("th", { text: "Type" }), h("th", { text: "What the server says it does" }))));
    const tb = h("tbody");
    for (const pair of qs.split("&")) {
      const [n, v = ""] = pair.split("=");
      const name = dec(n);
      const base = name.split(":")[0];
      const p = info.params.find((x) => x.name === base);
      const doc = p?.documentation || RESULT_PARAMS[base] || "";
      tb.append(h("tr", null, h("td", null, h("code", { text: name })), h("td", null, h("code", { text: dec(v) })), h("td", { text: p?.type || (RESULT_PARAMS[base] ? "result" : "?") }), h("td", { text: doc })));
    }
    list.append(tb);
    out.append(h("h3", { text: "Parameters" }), list);
  }

  const tips = explainTips(r, matches, includes);
  if (tips.length) out.append(h("h3", { text: "Tips" }), h("ul", { class: "tips" }, tips.map((t) => h("li", { text: t }))));
}

const RESULT_PARAMS = {
  _elements: "Return only these elements (the server marks results SUBSETTED — never save them back)",
  _summary: "Return a server-defined summary of each resource (or just the count)",
  _sort: "Sort order; prefix '-' for descending",
  _count: "Page size",
  _include: "Also return resources these results point to",
  _revinclude: "Also return resources that point to these results",
  _total: "Ask for an exact, estimated or no total",
  _getpages: "Server's paging cursor",
  _getpagesoffset: "Server's paging offset",
  _bundletype: "Bundle type of the page",
};

function explainTips(r, matches, includes) {
  const tips = [];
  const q = r.rel;
  if (r.json?.resourceType === "Bundle") {
    if (!/[?&]_elements=|[?&]_summary=/.test(q) && matches.length > 1 && r.bytes > 20000) {
      tips.push(`${fmtBytes(r.bytes)} for ${matches.length} results. If the screen shows only a few fields, add _elements (Project) — try "Make it leaner" below.`);
    }
    if (/[?&]_elements=/.test(q) && /[?&]_(rev)?include=/.test(q) && !/_elements=[A-Z]/.test(q)) {
      tips.push("Unqualified _elements with includes: HAPI applies them to every resource in the Bundle, so results can come back trimmed unexpectedly. Qualify them (Patient.name).");
    }
    if (typeof r.json.total !== "number") tips.push("No total in the Bundle. Asking for one can be slow on big servers; Count total uses _summary=count separately.");
    if (/[?&]_count=(\d{3,})/.test(q)) tips.push("Large pages are slower to transfer and render; paging with Next is often faster to first paint.");
    if (includes.length > matches.length * 5) tips.push(`${includes.length} included resources for ${matches.length} matches — check that every include is needed.`);
  }
  if (r.ms > 1500) tips.push("Over 1.5 s. Try a narrower filter, a smaller _count, or fewer includes.");
  return tips;
}

const SUGGESTED_ELEMENTS = {
  Patient: "name,gender,birthDate", Observation: "code,value,component,effective,status,subject",
  Condition: "code,clinicalStatus,onset,subject", Encounter: "status,class,type,period,subject",
  MedicationRequest: "medication,status,dosageInstruction,subject", Appointment: "status,start,end,participant",
  Practitioner: "name", Organization: "name",
};

async function leaner() {
  if (!state.type) return;
  const out = $("leaner-out");
  clear(out);
  const btn = $("leaner");
  btn.disabled = true;
  const elements = state.elements || SUGGESTED_ELEMENTS[state.type] || "id";
  const variants = [
    ["Full resources", buildQuery(state, { noProjection: true })],
    ["_summary=true", buildQuery(state, { noProjection: false, elements: "", summaryTrue: true })],
    [`_elements=${elements}${state.elements ? "" : " (suggested)"}`, buildQuery(state, { elements, summaryTrue: false })],
  ];
  const results = [];
  for (const [label, q] of variants) {
    btn.textContent = `Running: ${label}`;
    try {
      const r = await fhirGet(q);
      results.push({ label, q, r });
    } catch (e) { toast(e.message); break; }
  }
  btn.disabled = false; btn.textContent = "Compare";
  if (!results.length) return;
  const full = results[0].r.bytes;
  const t = h("table", { class: "grid" },
    h("thead", null, h("tr", null, ["Variant", "Payload", "vs full", "Time", "Results"].map((x) => h("th", { text: x })))));
  const tb = h("tbody");
  for (const { label, q, r } of results) {
    const { matches } = entriesOf(r.json);
    const pct = full ? Math.round((1 - r.bytes / full) * 100) : 0;
    const bar = h("span", { class: "bar" }, h("span", { class: "fill" }));
    bar.firstChild.style.width = `${full ? Math.max(2, Math.round((r.bytes / full) * 100)) : 0}%`;
    tb.append(h("tr", { title: "[base]/" + q },
      h("td", null, h("code", { text: label })),
      h("td", null, bar, " ", fmtBytes(r.bytes)),
      h("td", { text: r === results[0].r ? "—" : pct >= 0 ? `${pct}% smaller` : `${-pct}% larger` }),
      h("td", { text: `${r.ms} ms` }),
      h("td", { text: r.ok ? String(matches.length) : `HTTP ${r.status}` })));
  }
  t.append(tb);
  if (results.slice(1).some(({ r }) => r.bytes >= full)) {
    out.append(h("p", { class: "note", text: "Projection made some variants bigger: these resources are already small, and the server adds a SUBSETTED tag to each one it trims. Projection pays off on rich resources (e.g. Synthea patients with narrative text and many identifiers)." }));
  }
  out.append(t, h("p", { class: "muted small", text: "Smaller payloads matter most on slow networks and phones. _elements results are marked SUBSETTED: use them to display, never to edit and save back." }));
}

// ---------------------------------------------------------------------------------------------
// Schema tab
// ---------------------------------------------------------------------------------------------

const CODE_PARENTS = new Set(["code", "category", "type", "class", "vaccineCode", "medicationCodeableConcept", "clinicalStatus", "verificationStatus", "valueCodeableConcept", "reasonCode", "serviceType", "specialty", "maritalStatus"]);

async function analyse() {
  if (!state.type) return;
  const out = $("schema");
  clear(out);
  const btn = $("analyse");
  btn.disabled = true; btn.textContent = "Sampling…";
  const s = { ...state, includes: new Set(), revincludes: new Set(), count: 100, elements: "", summaryTrue: false };
  let r;
  try { r = await fhirGet(buildQuery(s)); } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = "Analyse sample";
  if (!r) return;
  if (!r.ok) { out.append(h("p", { class: "error", text: `HTTP ${r.status}` })); return; }
  const { matches } = entriesOf(r.json);
  if (!matches.length) { out.append(h("p", { class: "empty", text: "No resources matched, nothing to analyse." })); return; }

  const presence = new Map(); // path -> {count, types:Set}
  const codes = new Map(); // parent path -> Map(label -> n)
  const statuses = new Map(); // path -> Map(value -> n)

  for (const res of matches) {
    const seen = new Set();
    walk(res, "", 0, seen, codes, statuses);
    for (const [p, t] of [...seen].map((x) => x.split("\u0000"))) {
      const e = presence.get(p) || { count: 0, types: new Set() };
      e.count++; e.types.add(t);
      presence.set(p, e);
    }
  }

  out.append(h("p", { class: "muted small", text: `Sample of ${matches.length} ${state.type} resources (${fmtBytes(r.bytes)}, ${r.ms} ms).` }));

  const grid = h("div", { class: "schema-grid" });
  const ptable = h("table", { class: "grid" }, h("thead", null, h("tr", null, h("th", { text: "Field" }), h("th", { text: "Filled in" }), h("th", { text: "Types" }))));
  const tb = h("tbody");
  const paths = [...presence.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // Merge type variants of the same path.
  const merged = new Map();
  for (const [p, e] of paths) {
    const m = merged.get(p) || { count: 0, types: new Set() };
    m.count = Math.max(m.count, e.count);
    e.types.forEach((t) => m.types.add(t));
    merged.set(p, m);
  }
  for (const [p, e] of merged) {
    const pct = Math.round((e.count / matches.length) * 100);
    const bar = h("span", { class: "bar" }, h("span", { class: "fill" }));
    bar.firstChild.style.width = `${Math.max(2, pct)}%`;
    const depth = (p.match(/\./g) || []).length;
    const name = h("td", { class: "path" }, h("code", { text: p }));
    name.style.paddingLeft = `${8 + depth * 14}px`;
    tb.append(h("tr", null, name, h("td", null, bar, ` ${pct}%`), h("td", { class: "muted", text: [...e.types].join(", ") })));
  }
  ptable.append(tb);
  grid.append(h("div", null, h("h3", { text: "Fields" }), ptable));

  const side = h("div");
  const topBlock = (title, map) => {
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const t = h("table", { class: "grid" }, h("tbody", null, rows.map(([label, n]) => {
      const bar = h("span", { class: "bar" }, h("span", { class: "fill" }));
      bar.firstChild.style.width = `${Math.max(2, Math.round((n / matches.length) * 100))}%`;
      return h("tr", null, h("td", { text: label }), h("td", null, bar, ` ${n}`));
    })));
    side.append(h("h3", null, title, h("span", { class: "muted small", text: map.size > 10 ? ` · top 10 of ${map.size}` : "" })), t);
  };
  for (const [p, map] of statuses) topBlock(h("code", { text: p }), map);
  for (const [p, map] of codes) topBlock(h("code", { text: p }), map);
  if (!statuses.size && !codes.size) side.append(h("p", { class: "muted", text: "No coded fields found in this sample." }));
  grid.append(side);
  out.append(grid);
}

function walk(v, path, depth, seen, codes, statuses) {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, path + "[]", depth, seen, codes, statuses);
    return;
  }
  if (typeof v !== "object") return;
  for (const [k, child] of Object.entries(v)) {
    if (k === "resourceType" || (depth === 0 && (k === "meta" || k === "id"))) continue;
    const p = path ? `${path}.${k}` : k;
    const t = Array.isArray(child) ? "array" : child === null ? "null" : typeof child;
    if (depth < 3) seen.add(p.replace(/\[\]/g, "") + "\u0000" + t);
    if (k === "div") continue;
    // Top values for status-like strings.
    if ((k === "status" || k === "gender" || k === "intent" || k === "use") && typeof child === "string" && depth <= 1) {
      const m = statuses.get(p) || new Map();
      m.set(child, (m.get(child) || 0) + 1);
      statuses.set(p, m);
    }
    // Top codes for CodeableConcepts under well-known names.
    const leaf = k;
    if (CODE_PARENTS.has(leaf) && depth <= 1) {
      const ccs = Array.isArray(child) ? child : [child];
      const m = codes.get(p) || new Map();
      for (const c of ccs) {
        const coding = c?.coding?.[0];
        const label = coding ? `${coding.display || coding.code} (${coding.code})` : c?.text;
        if (label) m.set(label, (m.get(label) || 0) + 1);
      }
      if (m.size) codes.set(p, m);
    }
    if (depth < 3) walk(child, p, depth + 1, seen, codes, statuses);
  }
}

// ---------------------------------------------------------------------------------------------
// Examples, history, curl
// ---------------------------------------------------------------------------------------------

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function examples() {
  return [
    ["Latest patients", "Patient?_sort=-_lastUpdated&_count=10"],
    ["Patients, names and birth dates only", "Patient?_elements=name,gender,birthDate&_count=20"],
    ["Latest vital signs with their patients", "Observation?category=vital-signs&_sort=-date&_count=20&_include=Observation:subject&_elements=Observation.code,Observation.value,Observation.component,Observation.effective,Observation.subject,Patient.name"],
    ["HbA1c results (LOINC 4548-4)", "Observation?code=http://loinc.org|4548-4&_sort=-date&_count=20"],
    ["Active conditions", "Condition?clinical-status=active&_count=20"],
    ["Active prescriptions", "MedicationRequest?status=active&_count=20"],
    ["Latest encounters with their observations", "Encounter?_sort=-date&_count=5&_revinclude=Observation:encounter"],
    ["Appointments from today, with patients", `Appointment?date=ge${todayIso()}&_include=Appointment:patient&_count=20`],
    ["Patients who have an HbA1c (reverse chaining)", "Patient?_has:Observation:patient:code=4548-4&_count=20"],
  ].filter(([, q]) => conn?.types.has(q.split("?")[0]));
}

function renderExamples() {
  const ul = $("examples");
  clear(ul);
  for (const [label, q] of examples()) {
    ul.append(h("li", null, h("button", { class: "linkish", title: q, onclick: (e) => { e.target.closest("details").open = false; $("raw").value = q; runRaw(); } },
      h("strong", { text: label }), h("code", { class: "muted small", text: q }))));
  }
}

const HISTORY_KEY = "fhirview:history:v1";

function pushHistory(q) {
  const list = store.get(HISTORY_KEY, []).filter((x) => x.q !== q);
  list.unshift({ q, at: new Date().toISOString(), server: conn.kind });
  store.set(HISTORY_KEY, list.slice(0, 25));
  renderHistory();
}

function renderHistory() {
  const ul = $("history");
  clear(ul);
  const list = store.get(HISTORY_KEY, []).filter((x) => !conn || x.server === conn.kind);
  if (!list.length) ul.append(h("li", { class: "muted small", text: "No queries yet. Stored in this browser only, without the base URL." }));
  for (const { q, at } of list) {
    ul.append(h("li", null, h("button", { class: "linkish", title: q, onclick: (e) => { e.target.closest("details").open = false; $("raw").value = q; runRaw(); } },
      h("code", { text: q }), h("span", { class: "muted small", text: new Date(at).toLocaleString() }))));
  }
  if (list.length) {
    ul.append(h("li", null, h("button", { class: "btn tiny ghost", onclick: () => { store.set(HISTORY_KEY, []); renderHistory(); } }, "Clear history")));
  }
}

async function copyCurl() {
  if (!conn || !state.type) return;
  const q = $("raw").value.trim();
  const url = `${conn.base}/${q}`;
  const auth = conn.token ? ` -H "Authorization: Bearer $FHIR_TOKEN"` : "";
  const cmd = `curl -s -H "Accept: application/fhir+json"${auth} '${url.replace(/'/g, "'\\''")}'`;
  try {
    await navigator.clipboard.writeText(cmd);
    toast(conn.token ? "Copied. The token is $FHIR_TOKEN — export it in your shell. The URL includes your tenant." : "Copied.");
  } catch {
    toast("The browser blocked clipboard access.");
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

function setTab(name) {
  for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of ["documents", "schema", "explain"]) $("tab-" + p).hidden = p !== name;
}

function init() {
  $("connect-form").addEventListener("submit", connect);
  for (const r of document.querySelectorAll('input[name="server"]')) {
    r.addEventListener("change", () => {
      const isHapi = document.querySelector('input[name="server"]:checked').value === "hapi";
      $("medblocks-fields").hidden = isHapi;
      $("base-url").required = !isHapi;
      $("token").required = !isHapi;
    });
  }
  $("disconnect").addEventListener("click", disconnect);
  $("type-filter").addEventListener("input", renderSidebar);
  $("count-all").addEventListener("click", countAll);
  $("add-filter").addEventListener("click", () => { state.filters.push({ param: "", modifier: "", prefix: "", value: "" }); renderBuilder(); $("filters").lastChild?.querySelector("input")?.focus(); });
  $("elements").addEventListener("input", (e) => { state.elements = e.target.value; updateRaw(); });
  $("summary-true").addEventListener("change", (e) => { state.summaryTrue = e.target.checked; updateRaw(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; updateRaw(); });
  $("sort-dir").addEventListener("change", (e) => { state.sortDir = e.target.value; updateRaw(); });
  $("count").addEventListener("input", (e) => { state.count = Math.min(1000, Math.max(1, Number(e.target.value) || 20)); updateRaw(); });
  // Find runs what the Query box says: if it was edited by hand, it is parsed back into the builder first.
  $("run").addEventListener("click", () => {
    if (state.type && $("raw").value.trim() !== buildQuery()) runRaw(); else runQuery();
  });
  $("reset").addEventListener("click", () => state.type && selectType(state.type, false));
  $("curl").addEventListener("click", copyCurl);
  $("raw").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runRaw(); } });
  document.querySelector(".builder").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id !== "raw" && e.target.tagName === "INPUT") { e.preventDefault(); runQuery(); }
  });
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => setTab(b.dataset.tab));
  for (const b of document.querySelectorAll(".segbtn")) {
    b.addEventListener("click", () => {
      view = b.dataset.view;
      for (const x of document.querySelectorAll(".segbtn")) x.setAttribute("aria-pressed", String(x === b));
      if (last) render();
    });
  }
  $("next").addEventListener("click", () => page("next"));
  $("prev").addEventListener("click", () => page("previous"));
  $("back").addEventListener("click", goBack);
  $("total").addEventListener("click", countTotal);
  $("leaner").addEventListener("click", leaner);
  $("analyse").addEventListener("click", analyse);
  // Close open dropdowns (includes, examples, history) when clicking elsewhere or pressing Escape.
  const closeDropdowns = (except) => {
    for (const d of document.querySelectorAll("details.multi[open], details.examples[open]")) if (d !== except) d.open = false;
  };
  document.addEventListener("click", (e) => closeDropdowns(e.target.closest("details.multi, details.examples")));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDropdowns(null); });
}

document.addEventListener("DOMContentLoaded", init);

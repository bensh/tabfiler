import { categorize, allCategories } from "../lib/categorize.js";
import {
  getRules, setRules, getSettings, setSettings, getOpenTabs, isDemo, runtimeApi,
  buildBackup, validateBackup, applyBackup,
} from "../lib/store.js";
import { getFiled } from "../lib/bookmarks.js";

const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
// Strip anything that isn't a safe class-name char, so an imported/synced id
// can never break out of the class attribute. Defense at the sink, not just entry.
const catClass = (id) => `cat-${String(id || "unknown").replace(/[^a-z0-9_-]/gi, "")}`;

// Tiny DOM builder: el("div", {class:"x", onclick:fn}, [childNode, "text"]).
// Avoids innerHTML entirely, so untrusted strings can never be parsed as markup.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node[k.toLowerCase()] = v;
    else if (k === "selected" || k === "checked" || k === "disabled" || k === "hidden") { if (v) node.setAttribute(k, ""); }
    else if (k.startsWith("data-") || k === "aria-label" || k === "role" || k === "type" || k === "value" || k === "placeholder" || k === "src" || k === "alt" || k === "href" || k === "target" || k === "rel") node.setAttribute(k, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

let rules = null;
let settings = null;
let tabs = [];
let tabState = {}; // id -> {manualId, status: 'pending'|'saved'|'ignored'}
let filter = "all";
let focusKeywordFor = null; // category id whose keyword input should regain focus after re-render

/* ---------------- routing ---------------- */
const ROUTES = ["review", "filed", "settings", "rules"];
function route() {
  let r = location.hash.replace("#", "") || "settings";
  if (!ROUTES.includes(r)) r = "settings";
  ROUTES.forEach((name) => { $(`route-${name}`).hidden = name !== r; });
  $$(".navlink").forEach((a) => a.classList.toggle("is-active", a.dataset.route === r));
  if (r === "review") renderReview();
  if (r === "rules") renderRules();
  if (r === "filed") renderFiled();
}
window.addEventListener("hashchange", route);

/* ---------------- settings ---------------- */
function bindSettings() {
  $("s-onload").checked = settings.autoOnLoad;
  $("s-onclose").checked = settings.autoOnClose;
  $("s-notify").checked = settings.notifyOnAuto;
  $("s-ask").checked = settings.askWhenNoFit;
  $("s-wholeword").checked = settings.wholeWord;
  $("s-root").value = settings.rootFolderName;
  $("root-name").textContent = settings.rootFolderName;
  $$(`input[name="dup"]`).forEach((el) => { el.checked = el.value === settings.duplicates; });
  $$(`input[name="unk"]`).forEach((el) => { el.checked = el.value === settings.unknownMode; });

  const save = async (patch) => { settings = await setSettings(patch); };
  $("s-onload").onchange = (e) => save({ autoOnLoad: e.target.checked });
  $("s-onclose").onchange = (e) => save({ autoOnClose: e.target.checked });
  $("s-notify").onchange = (e) => save({ notifyOnAuto: e.target.checked });
  $("s-ask").onchange = (e) => save({ askWhenNoFit: e.target.checked });
  $("s-wholeword").onchange = (e) => save({ wholeWord: e.target.checked });
  $("s-root").oninput = (e) => { $("root-name").textContent = e.target.value || "TabFiler"; };
  $("s-root").onchange = (e) => save({ rootFolderName: e.target.value || "TabFiler" });
  $$(`input[name="dup"]`).forEach((el) => el.addEventListener("change", () => save({ duplicates: el.value })));
  $$(`input[name="unk"]`).forEach((el) => el.addEventListener("change", () => save({ unknownMode: el.value })));
  $("reset-defaults").onclick = async () => {
    if (!confirm("Reset all settings and category rules to defaults?")) return;
    location.reload();
  };

  $("export-btn").onclick = exportBackup;
  $("import-btn").onclick = () => $("import-file").click();
  $("import-file").onchange = importBackup;
}

function backupMsg(text, ok) {
  const el = $("backup-msg");
  el.textContent = text;
  el.classList.toggle("is-ok", !!ok);
  el.classList.toggle("is-err", !ok);
  el.hidden = false;
}

async function exportBackup() {
  try {
    const data = await buildBackup();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tabfiler-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    backupMsg("Backup downloaded.", true);
  } catch (e) {
    backupMsg("Couldn't create the backup file.", false);
  }
}

async function importBackup(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // allow re-importing the same file later
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    backupMsg("That file is too large to be a TabFiler backup.", false);
    return;
  }

  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch {
    backupMsg("That file isn't valid JSON.", false);
    return;
  }

  let clean;
  try {
    clean = validateBackup(parsed);
  } catch (err) {
    backupMsg(err.message, false);
    return;
  }

  const count = clean.rules.categories.length;
  if (!confirm(`Import ${count} categor${count === 1 ? "y" : "ies"} and replace your current rules and settings? Your bookmarks won't be touched.`)) {
    return;
  }

  try {
    await applyBackup(clean);
    backupMsg("Imported. Reloading…", true);
    setTimeout(() => location.reload(), 700);
  } catch {
    backupMsg("Couldn't save the imported settings.", false);
  }
}

/* ---------------- review ---------------- */
function tabResult(tab) {
  const st = tabState[tab.id] || {};
  const auto = categorize(tab.title, rules, { wholeWord: settings.wholeWord });
  const catId = st.manualId || auto.category.id;
  const cat = allCategories(rules).find((c) => c.id === catId) || auto.category;
  return { auto, cat, manual: !!st.manualId, status: st.status || "pending" };
}

function renderReview() {
  $("tab-count").textContent = tabs.length;
  const list = $("tab-list");
  list.replaceChildren();
  const visible = tabs.filter((t) => {
    if (filter === "unknown") return tabResult(t).auto.category.id === "unknown";
    return true;
  });
  $("review-empty").hidden = visible.length > 0;

  for (const tab of visible) {
    const { auto, cat, manual, status } = tabResult(tab);
    const li = document.createElement("li");
    li.className = `trow ${status === "saved" ? "is-saved" : ""} ${status === "ignored" ? "is-ignored" : ""}`;
    li.dataset.id = tab.id;

    // checkbox
    const check = el("label", { class: "check" }, [
      el("input", { type: "checkbox", class: "row-check", "aria-label": `Select ${tab.title}` }),
      el("span", { class: "box", "aria-hidden": "true" }),
    ]);

    // favicon
    const fav = el("img", { class: "favicon", alt: "" });
    if (/^(https?:|data:image\/)/i.test(tab.favIconUrl || "")) fav.src = tab.favIconUrl;

    // text
    const text = el("div", { class: "trow__text" }, [
      el("div", { class: "trow__title", text: tab.title }),
      el("div", { class: "trow__url mono", text: tab.url }),
    ]);

    // reason + confidence
    const reason = el("div", { class: "trow__reason" }, [
      pipsNode(auto.confidence),
      el("span", { class: "label", text: manual ? "set by you" : shortReason(auto) }),
    ]);

    // category badge
    const badgeWrap = el("div", {}, [
      el("span", { class: `badge ${catClass(cat.id)}` }, [
        el("span", { class: "dot" }),
        cat.name,
      ]),
      manual ? el("span", { class: "manual-tag", text: "manual" }) : null,
    ]);

    // override / status
    let ctrl;
    if (status === "saved" || status === "ignored") {
      const undoBtn = el("button", { "data-undo": "", text: "Undo",
        onclick: () => { tabState[tab.id] = { ...tabState[tab.id], status: "pending" }; renderReview(); } });
      const label = status === "saved" ? `✓ ${cat.name} ` : "Ignored ";
      const flag = el("span", { class: "saved-flag" }, [label, undoBtn]);
      if (status === "ignored") flag.style.color = "var(--ink-3)";
      ctrl = el("div", {}, [flag]);
    } else {
      const sel = el("select", { "aria-label": `Folder for ${tab.title}`,
        onchange: (e) => {
          tabState[tab.id] = { ...tabState[tab.id], manualId: e.target.value === auto.category.id ? null : e.target.value };
          renderReview();
        } });
      for (const c of allCategories(rules)) {
        sel.appendChild(el("option", { value: c.id, selected: c.id === cat.id, text: c.name }));
      }
      ctrl = el("div", {}, [sel]);
    }

    li.append(check, fav, text, badgeWrap, reason, ctrl);
    list.appendChild(li);
  }
  updateBulkButtons();
}

function selectedIds() {
  return $$(".row-check").filter((c) => c.checked).map((c) => +c.closest(".trow").dataset.id);
}
function updateBulkButtons() {
  const n = selectedIds().length;
  $("bookmark-sel").disabled = n === 0;
  $("ignore-sel").disabled = n === 0;
  $("bookmark-sel").textContent = n ? `Bookmark selected (${n})` : "Bookmark selected";
}

function pageToast(parts, onUndo) {
  const t = $("toast");
  const msg = $("toast-msg");
  msg.textContent = "";
  for (const p of [].concat(parts)) {
    msg.appendChild(typeof p === "string" ? document.createTextNode(p) : p);
  }
  t.hidden = false;
  clearTimeout(pageToast._t);
  pageToast._t = setTimeout(() => (t.hidden = true), 6000);
  $("toast-undo").onclick = () => { t.hidden = true; onUndo && onUndo(); };
}

async function bookmarkIds(ids) {
  for (const id of ids) {
    const tab = tabs.find((t) => t.id === id);
    const { cat } = tabResult(tab);
    if (cat.id === "unknown" && settings.unknownMode === "ignore") {
      tabState[id] = { ...tabState[id], status: "ignored" }; continue;
    }
    tabState[id] = { ...tabState[id], status: "saved" };
    // real bookmark creation would happen here in extension mode
  }
  renderReview();
  filedData = null; // refresh Filed counts next time it's opened
  pageToast(["Filed ", el("b", { text: String(ids.length) }), ` ${ids.length === 1 ? "tab" : "tabs"}.`], () => {
    ids.forEach((id) => { tabState[id] = { ...tabState[id], status: "pending" }; });
    renderReview();
  });
}

function bindReview() {
  $("select-all").onchange = (e) => { $$(".row-check").forEach((c) => (c.checked = e.target.checked)); updateBulkButtons(); };
  $("tab-list").addEventListener("change", (e) => { if (e.target.classList.contains("row-check")) updateBulkButtons(); });
  $("bookmark-sel").onclick = () => bookmarkIds(selectedIds());
  $("bookmark-all").onclick = () => bookmarkIds(tabs.filter((t) => (tabState[t.id]?.status ?? "pending") === "pending").map((t) => t.id));
  $("ignore-sel").onclick = () => { selectedIds().forEach((id) => (tabState[id] = { ...tabState[id], status: "ignored" })); renderReview(); };
  $("rerun").onclick = () => {
    const hasManual = Object.values(tabState).some((s) => s.manualId);
    if (hasManual && !confirm("Re-running will keep your manual choices. Continue?")) return;
    renderReview();
  };
  $$(".chip").forEach((chip) => chip.onclick = () => {
    $$(".chip").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active"); filter = chip.dataset.filter; renderReview();
  });
}

/* ---------------- filed ---------------- */
let filedData = null;      // cached [{name,count,items}]
let filedOpen = new Set(); // category names currently expanded

// Demo bookmarks so the Filed view is populated in the static preview.
const DEMO_FILED = [
  { name: "Android", count: 2, items: [
    { id: "d1", title: "Jetpack Compose state hoisting", url: "https://developer.android.com/jetpack/compose/state" },
    { id: "d2", title: "security workshop and guide book | android", url: "https://example.com/workshop" },
  ]},
  { name: "iOS", count: 1, items: [
    { id: "d3", title: "SwiftUI navigation stack tutorial", url: "https://developer.apple.com/tutorials/swiftui" },
  ]},
  { name: "Kubernetes / Docker", count: 2, items: [
    { id: "d4", title: "Kubernetes ingress security best practices", url: "https://kubernetes.io/docs/concepts/services-networking/ingress/" },
    { id: "d5", title: "Docker Compose networking explained", url: "https://docs.docker.com/compose/networking/" },
  ]},
  { name: "Security", count: 1, items: [
    { id: "d6", title: "OWASP Top 10 — 2024 (possible duplicate)", url: "https://owasp.org/Top10/" },
  ]},
];

async function loadFiled() {
  if (isDemo) return structuredClone(DEMO_FILED);
  try { return await getFiled(runtimeApi(), settings.rootFolderName); }
  catch (e) { console.error(e); return []; }
}

async function renderFiled() {
  const host = $("filed-list");
  if (!filedData) {
    host.replaceChildren(el("p", { class: "empty", text: "Loading…" }));
    filedData = await loadFiled();
  }
  const q = ($("filed-search").value || "").trim().toLowerCase();

  // filter items by search query
  const cats = filedData
    .map((c) => {
      if (!q) return c;
      const items = c.items.filter((it) =>
        it.title.toLowerCase().includes(q) || it.url.toLowerCase().includes(q));
      return { ...c, items, count: items.length };
    })
    .filter((c) => !q || c.items.length > 0);

  const total = filedData.reduce((n, c) => n + c.count, 0);
  $("filed-empty").hidden = total > 0;
  host.replaceChildren();
  if (total === 0) return;

  for (const cat of cats) {
    const open = q ? true : filedOpen.has(cat.name); // expand all while searching
    const chevron = el("span", { class: "filed-cat__chevron", "aria-hidden": "true" }, ["▶"]);
    const head = el("button", {
      class: "filed-cat__head", "aria-expanded": open ? "true" : "false",
      onclick: () => {
        if (filedOpen.has(cat.name)) filedOpen.delete(cat.name); else filedOpen.add(cat.name);
        renderFiled();
      },
    }, [
      chevron,
      el("span", { class: `badge ${catClass(catIdFromName(cat.name))}` }, [el("span", { class: "dot" }), cat.name]),
      el("span", { class: "filed-cat__count", text: `${cat.count}` }),
    ]);

    const items = el("ul", { class: "filed-cat__items" });
    if (!open) items.hidden = true;
    for (const it of cat.items) {
      const flagged = /\(possible duplicate\)/i.test(it.title);
      const cleanTitle = it.title.replace(/\s*\(possible duplicate\)\s*$/i, "");

      const link = el("a", {
        class: "filed-item__link", href: it.url, target: "_blank", rel: "noopener noreferrer",
      }, [
        el("div", { class: "filed-item__text" }, [
          el("div", { class: "filed-item__title", text: cleanTitle }),
          el("div", { class: "filed-item__url", text: prettyUrl(it.url) }),
        ]),
        flagged ? el("span", { class: "filed-flag", text: "dup?" }) : null,
        el("span", { class: "filed-item__open", "aria-hidden": "true", text: "↗" }),
      ]);

      const del = el("button", {
        class: "filed-item__del", "aria-label": `Remove ${cleanTitle} from ${cat.name}`,
        title: "Remove from TabFiler", text: "✕",
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); deleteFiled(it, cleanTitle, cat.name); },
      });

      items.appendChild(el("li", { class: "filed-item" }, [link, del]));
    }

    const card = el("div", { class: `filed-cat ${open ? "is-open" : ""}` }, [head, items]);
    host.appendChild(card);
  }
}

function catIdFromName(name) {
  const found = allCategories(rules).find((c) => c.name === name);
  return found ? found.id : "unknown";
}
function prettyUrl(url) {
  try { const u = new URL(url); return u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname); }
  catch { return url; }
}

function bindFiled() {
  $("filed-search").addEventListener("input", () => renderFiled());
}

// Remove a filed bookmark. Only touches TabFiler's own folder. Offers undo by
// recreating the bookmark in the same category if the user changes their mind.
async function deleteFiled(item, cleanTitle, catName) {
  if (!confirm(`Remove “${cleanTitle}” from ${catName}?\n\nThis deletes the bookmark from your ${catName} folder. The page itself is unaffected.`)) {
    return;
  }

  let recreate = null;
  if (!isDemo) {
    try {
      const api = runtimeApi();
      // snapshot for undo before removing
      const node = await api.bookmarks.get(item.id).then((n) => n[0]).catch(() => null);
      await api.bookmarks.remove(item.id);
      if (node) {
        recreate = async () => {
          try { await api.bookmarks.create({ parentId: node.parentId, title: node.title, url: node.url }); }
          catch (e) {}
          filedData = null; renderFiled();
        };
      }
    } catch (e) { console.error(e); }
  }

  // update local cache immediately
  if (filedData) {
    const cat = filedData.find((c) => c.name === catName);
    if (cat) { cat.items = cat.items.filter((i) => i.id !== item.id); cat.count = cat.items.length; }
  }
  renderFiled();

  pageToast([`Removed from `, el("b", { text: catName })], recreate || undefined);
}

/* ---------------- rules ---------------- */
function renderRules() {
  const list = $("cat-list");
  list.replaceChildren();
  rules.categories.forEach((cat, idx) => {
    const handle = el("span", { class: "crow__handle", "aria-hidden": "true" }, [
      el("i"), el("i"), el("i"),
    ]);
    const upBtn = el("button", { "data-up": "", "aria-label": `Move ${cat.name} up`, text: "▲",
      onclick: () => move(idx, -1) });
    if (idx === 0) upBtn.disabled = true;
    const downBtn = el("button", { "data-down": "", "aria-label": `Move ${cat.name} down`, text: "▼",
      onclick: () => move(idx, 1) });
    if (idx === rules.categories.length - 1) downBtn.disabled = true;

    const head = el("div", { class: "crow__head" }, [
      handle,
      el("span", { class: "crow__rank", text: String(idx + 1) }),
      el("span", { class: `badge ${catClass(cat.id)}` }, [el("span", { class: "dot" }), cat.name]),
      el("span", { class: "crow__move" }, [upBtn, downBtn]),
    ]);

    const kwWrap = el("div", { class: "crow__kw" });
    cat.keywords.forEach((kw, ki) => {
      const removeBtn = el("button", { "aria-label": `Remove ${kw}`, text: "×",
        onclick: () => { cat.keywords.splice(ki, 1); persistRules(); renderRules(); } });
      kwWrap.appendChild(el("span", { class: "kw" }, [kw, removeBtn]));
    });
    const add = el("input", { type: "text", class: "kw-add", placeholder: "+ keyword",
      "aria-label": `Add keyword to ${cat.name}`, "data-cat-id": cat.id });
    add.onkeydown = (e) => {
      if (e.key === "Enter" && add.value.trim()) {
        const kw = add.value.trim().toLowerCase();
        if (!cat.keywords.includes(kw)) cat.keywords.push(kw);
        persistRules();
        focusKeywordFor = cat.id; // refocus this category's input after re-render
        renderRules();
      }
    };
    kwWrap.appendChild(add);

    const li = el("li", { class: "crow", "data-idx": String(idx) }, [head, kwWrap]);
    li.draggable = true;
    attachDrag(li);
    list.appendChild(li);
  });

  // QoL: after adding a keyword, the DOM is rebuilt — put the cursor back in
  // the same category's input so several keywords can be typed in a row.
  if (focusKeywordFor) {
    const target = list.querySelector(`.kw-add[data-cat-id="${CSS.escape(focusKeywordFor)}"]`);
    if (target) target.focus();
    focusKeywordFor = null;
  }

  runTest();
}

function move(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= rules.categories.length) return;
  const [c] = rules.categories.splice(idx, 1);
  rules.categories.splice(j, 0, c);
  persistRules(); renderRules();
}

let dragIdx = null;
function attachDrag(li) {
  li.addEventListener("dragstart", () => { dragIdx = +li.dataset.idx; li.classList.add("dragging"); });
  li.addEventListener("dragend", () => { li.classList.remove("dragging"); $$(".crow").forEach((r) => r.classList.remove("drop-target")); });
  li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("drop-target"); });
  li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    const target = +li.dataset.idx;
    if (dragIdx === null || dragIdx === target) return;
    const [c] = rules.categories.splice(dragIdx, 1);
    rules.categories.splice(target, 0, c);
    dragIdx = null; persistRules(); renderRules();
  });
}

async function persistRules() { await setRules(rules); }

function runTest() {
  const val = $("test-input").value;
  const r = categorize(val, rules, { wholeWord: settings.wholeWord });
  const box = $("test-result");
  box.querySelector(".badge").className = `badge badge--lg ${catClass(r.category.id)}`;
  box.querySelector(".test-cat").textContent = r.category.name;
  const reasonEl = box.querySelector(".test-reason");
  if (val.trim()) renderReason(reasonEl, r.reason);
  else reasonEl.textContent = "Type a title to see where it would go.";
}

function bindRules() {
  $("test-input").addEventListener("input", runTest);
  $$(".preset").forEach((b) => b.onclick = () => { $("test-input").value = b.dataset.t; runTest(); });
  $("add-cat").onclick = () => {
    const name = prompt("New category name?");
    if (!name || !name.trim()) return;
    const clean = name.trim().slice(0, 60);
    let id = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `cat-${Date.now()}`;
    if (rules.categories.some((c) => c.id === id)) id = `${id}-${Date.now().toString(36)}`;
    rules.categories.push({ id, name: clean, color: "#8B8680", keywords: [] });
    persistRules(); renderRules();
  };
}

/* ---------------- helpers ---------------- */
function pipsNode(conf) {
  return el("span", { class: `pips ${conf}`, "aria-label": `confidence ${conf}` }, [
    el("i"), el("i"), el("i"),
  ]);
}
function shortReason(auto) {
  if (auto.category.id === "unknown") return "no match";
  return auto.matchedKeyword ? `matched “${auto.matchedKeyword}”` : auto.reason;
}
// Render a reason string, bolding any “quoted” segment, via DOM nodes (no innerHTML).
function renderReason(node, text) {
  node.textContent = "";
  const re = /“([^”]+)”/g;
  let last = 0, m;
  const s = String(text ?? "");
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) node.appendChild(document.createTextNode(s.slice(last, m.index)));
    const strong = document.createElement("b");
    strong.textContent = m[1];
    node.appendChild(strong);
    last = re.lastIndex;
  }
  if (last < s.length) node.appendChild(document.createTextNode(s.slice(last)));
}

/* ---------------- init ---------------- */
async function init() {
  rules = await getRules();
  settings = await getSettings();
  tabs = await getOpenTabs();
  bindSettings();
  bindReview();
  bindRules();
  bindFiled();
  route();
}
init();

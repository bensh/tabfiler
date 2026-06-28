import { categorize, allCategories } from "../lib/categorize.js";
import { getRules, setRules, getSettings, setSettings, getActiveTab, isDemo, runtimeApi } from "../lib/store.js";
import { fileBookmark } from "../lib/bookmarks.js";

const $ = (id) => document.getElementById(id);
const catClass = (id) => `cat-${String(id || "unknown").replace(/[^a-z0-9_-]/gi, "")}`;

let state = { tab: null, rules: null, settings: null, result: null, manualId: null };

function safeImgUrl(u) {
  return typeof u === "string" && /^(https?:|data:image\/)/i.test(u) ? u : "";
}

function favicon(tab) {
  const el = $("cur-favicon");
  const url = safeImgUrl(tab.favIconUrl);
  if (url) { el.src = url; el.onerror = () => { el.removeAttribute("src"); }; }
  else el.removeAttribute("src");
}

function paintBadge(cat) {
  const badge = $("cur-badge");
  badge.className = `badge badge--lg ${catClass(cat.id)}`;
  $("cur-badge-name").textContent = cat.name;
}

function effectiveCategory() {
  if (state.manualId) {
    const c = allCategories(state.rules).find((c) => c.id === state.manualId);
    return c;
  }
  return state.result.category;
}

function render() {
  const { tab, result } = state;
  $("cur-title").textContent = tab.title || "Untitled tab";
  $("cur-url").textContent = tab.url || "—";
  favicon(tab);

  const cat = effectiveCategory();
  paintBadge(cat);

  // reason vs manual
  const isManual = !!state.manualId;
  $("cur-manual").hidden = !isManual;
  if (isManual) {
    setBoldParts($("cur-reason"), ["Set by you. Auto-detect suggested ", b(result.category.name), "."]);
  } else {
    renderReason($("cur-reason"), result.reason);
  }

  // no-fit prompt only for auto Unknown
  $("nofit").hidden = isManual || result.category.id !== "unknown" || !state.settings.askWhenNoFit;

  // override dropdown selection
  $("cur-override").value = cat.id;

  // auto toggle reflects per-category setting
  const autoCats = state.settings.autoCategories || [];
  const isOn = autoCats.includes(cat.id);
  $("auto-toggle").checked = isOn;
  if (isOn) {
    setBoldParts($("auto-sub"), ["New ", b(cat.name), " pages will be filed automatically."]);
  } else {
    setBoldParts($("auto-sub"), ["Turn on to auto-file every ", b(cat.name), " page."]);
  }
}

// Mark a string as a bold segment for setBoldParts().
function b(text) { return { bold: String(text ?? "") }; }

// Render an array of strings / {bold} segments into el as text + <b> nodes.
// No innerHTML, so nothing can be injected.
function setBoldParts(el, parts) {
  el.textContent = "";
  for (const p of parts) {
    if (p && typeof p === "object" && "bold" in p) {
      const strong = document.createElement("b");
      strong.textContent = p.bold;
      el.appendChild(strong);
    } else {
      el.appendChild(document.createTextNode(String(p)));
    }
  }
}

// Render a reason string, bolding any “quoted” segment, via DOM nodes.
function renderReason(el, text) {
  el.textContent = "";
  const re = /“([^”]+)”/g;
  let last = 0, m;
  const s = String(text ?? "");
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(s.slice(last, m.index)));
    const strong = document.createElement("b");
    strong.textContent = m[1];
    el.appendChild(strong);
    last = re.lastIndex;
  }
  if (last < s.length) el.appendChild(document.createTextNode(s.slice(last)));
}

function buildOverride() {
  const sel = $("cur-override");
  sel.replaceChildren();
  for (const c of allCategories(state.rules)) {
    const opt = document.createElement("option");
    opt.value = c.id; opt.textContent = c.name;
    sel.appendChild(opt);
  }
  const nf = document.createElement("option");
  nf.value = "__new"; nf.textContent = "+ New folder…";
  sel.appendChild(nf);
}

let toastTimer = null;
function showToast(folderName, action, onUndo) {
  const t = $("toast");
  const msg = t.querySelector(".toast__msg");
  let verb = "Saved to";
  if (action === "updated") verb = "Updated in";
  if (action === "skipped") verb = "Already saved in";
  if (action === "flagged") verb = "Saved (possible duplicate) to";
  setBoldParts(msg, [verb + " ", b(folderName)]);
  t.hidden = false;
  // restart drain animation
  const bar = t.querySelector(".toast__bar");
  bar.style.animation = "none"; void bar.offsetWidth; bar.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
  // nothing to undo when we deliberately skipped
  $("toast-undo").style.display = action === "skipped" ? "none" : "";
  $("toast-undo").onclick = () => {
    t.hidden = true; clearTimeout(toastTimer);
    onUndo && onUndo();
  };
}

async function doBookmark() {
  const cat = effectiveCategory();
  const btn = $("bookmark-now");
  btn.disabled = true;

  let undo = null;
  let action = "created";
  if (!isDemo) {
    try {
      const api = runtimeApi();
      const result = await fileBookmark(api, {
        tab: state.tab,
        categoryName: cat.name,
        rootFolderName: state.settings.rootFolderName,
        duplicates: state.settings.duplicates,
      });
      undo = result.undo;
      action = result.action;
    } catch (e) { console.error(e); }
  }

  showToast(cat.name, action, async () => {
    if (undo) { try { await undo(); } catch (e) {} }
  });
  btn.disabled = false;
}

// ensure /rootFolderName/catName exists under the bookmarks menu/toolbar

function openPage(path) {
  if (isDemo) { window.location.href = path; return; }
  const api = runtimeApi();
  api.tabs.create({ url: api.runtime.getURL(path) });
  window.close();
}

async function init() {
  state.rules = await getRules();
  state.settings = await getSettings();
  state.tab = await getActiveTab();
  state.result = categorize(state.tab.title, state.rules, { wholeWord: state.settings.wholeWord });

  buildOverride();
  render();

  $("cur-override").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === "__new") { openNewFolder(); e.target.value = effectiveCategory().id; return; }
    state.manualId = v === state.result.category.id ? null : v;
    render();
  });

  $("bookmark-now").addEventListener("click", doBookmark);

  $("auto-toggle").addEventListener("change", async (e) => {
    const cat = effectiveCategory();
    const set = new Set(state.settings.autoCategories || []);
    e.target.checked ? set.add(cat.id) : set.delete(cat.id);
    state.settings = await setSettings({ autoCategories: [...set] });
    render();
  });

  $("open-settings").addEventListener("click", () => openPage("../options/options.html"));
  $("open-review").addEventListener("click", () => openPage("../options/options.html#review"));
  $("nofit-new").addEventListener("click", openNewFolder);
  $("nofit-choose").addEventListener("click", () => $("cur-override").focus());

  // inline new-folder dialog
  $("newfolder-create").addEventListener("click", createFolder);
  $("newfolder-cancel").addEventListener("click", closeNewFolder);
  $("newfolder-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createFolder(); }
    if (e.key === "Escape") { e.preventDefault(); closeNewFolder(); }
  });
  $("newfolder-name").addEventListener("input", () => {
    $("newfolder-error").hidden = true;
  });

  // keyboard: Enter = bookmark (but not while the new-folder dialog is open)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!$("newfolder").hidden) return;
    if (document.activeElement.tagName === "SELECT") return;
    doBookmark();
  });
}

function openNewFolder() {
  $("newfolder").hidden = false;
  $("newfolder-error").hidden = true;
  const input = $("newfolder-name");
  input.value = "";
  input.focus();
}

function closeNewFolder() {
  $("newfolder").hidden = true;
  $("cur-override").focus();
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function createFolder() {
  const raw = $("newfolder-name").value.trim();
  const err = $("newfolder-error");
  if (!raw) { showFolderError("Give the folder a name."); return; }
  if (raw.length > 60) { showFolderError("That name is a bit long — keep it under 60 characters."); return; }

  const existing = allCategories(state.rules);
  if (existing.some((c) => c.name.toLowerCase() === raw.toLowerCase())) {
    showFolderError(`“${raw}” already exists.`);
    return;
  }

  let id = slugify(raw) || `cat-${Date.now()}`;
  if (existing.some((c) => c.id === id)) id = `${id}-${Date.now().toString(36)}`;

  // New categories sit just above Unknown (lowest priority of the real folders),
  // so they don't unexpectedly outrank existing specific categories.
  state.rules.categories.push({ id, name: raw, color: "#8B8680", keywords: [] });
  await setRules(state.rules);

  buildOverride();
  state.manualId = id;
  closeNewFolder();
  render();
}

function showFolderError(msg) {
  const err = $("newfolder-error");
  err.textContent = msg;
  err.hidden = false;
  $("newfolder-name").focus();
}

init();

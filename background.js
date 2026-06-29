// TabFiler — background service.
// Handles automatic filing on page load / tab close and the open-on-install onboarding.
// Uses classic (non-module) script per manifest; imports inline via dynamic import.

const DEFAULT_SETTINGS = {
  autoOnLoad: false, autoOnClose: true, duplicates: "skip",
  unknownMode: "bookmark", askWhenNoFit: true, wholeWord: true,
  notifyOnAuto: true, rootFolderName: "TabFiler", onboarded: false,
  autoCategories: [],
};

let categorize, DEFAULT_RULES, fileBookmark;
(async () => {
  const cat = await import(browser.runtime.getURL("lib/categorize.js"));
  categorize = cat.categorize; DEFAULT_RULES = cat.DEFAULT_RULES;
  const bm = await import(browser.runtime.getURL("lib/bookmarks.js"));
  fileBookmark = bm.fileBookmark;
})();

async function getState() {
  const { settings, rules } = await browser.storage.local.get(["settings", "rules"]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    rules: rules || DEFAULT_RULES,
  };
}

// throttle a flood of events (session restore, bulk close)
const recently = new Map();
const THROTTLE_MS = 1500;
const MAX_MAP = 5000; // hard cap so a long session can't grow these without bound
function throttled(key) {
  const now = Date.now();
  const last = recently.get(key) || 0;
  if (now - last < THROTTLE_MS) return true;
  recently.set(key, now);
  if (recently.size > MAX_MAP) {
    // drop the oldest half
    const cutoff = now - THROTTLE_MS;
    for (const [k, t] of recently) { if (t < cutoff) recently.delete(k); }
    while (recently.size > MAX_MAP) recently.delete(recently.keys().next().value);
  }
  return false;
}

// Maps a notification id -> the bookmark id it created, for one-click undo.
const lastFiled = new Map();


async function fileTab(tab, trigger) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url) || !tab.title) return;
  if (!categorize || !fileBookmark) return;
  const { settings, rules } = await getState();
  // Throttle per trigger+URL so a load-file and a close-file of the same page
  // don't cancel each other, while still absorbing event floods (session
  // restore, bulk close) for the same trigger.
  if (throttled(`${trigger}:${tab.url}`)) return;

  const r = categorize(tab.title, rules, { wholeWord: settings.wholeWord });
  if (r.category.id === "unknown" && settings.unknownMode === "ignore") return;

  // Decide whether this trigger should auto-file.
  // A page files if EITHER the global switch for this trigger is on,
  // OR the user opted this specific category in via the popup toggle.
  const globalOn =
    (trigger === "load" && settings.autoOnLoad) ||
    (trigger === "close" && settings.autoOnClose);
  const perCategoryOn = (settings.autoCategories || []).includes(r.category.id);
  if (!globalOn && !perCategoryOn) return;

  const result = await fileBookmark(browser, {
    tab,
    categoryName: r.category.name,
    rootFolderName: settings.rootFolderName,
    duplicates: settings.duplicates,
  });

  if (result.action !== "skipped") {
    notifyFiled(settings, result.folderName, clampTitleLocal(tab.title), result.bookmarkId, result.action);
  }
}

// Lightweight local clamp for the notification message (display only).
function clampTitleLocal(s) {
  s = String(s || "");
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

// Build the right notification for how the bookmark was filed.
function notifyFiled(settings, catName, title, bookmarkId, mode) {
  if (!settings.notifyOnAuto) return;
  const nid = `tabfiler:${bookmarkId}`;
  let heading = `Filed to ${catName}`;
  if (mode === "updated") heading = `Updated in ${catName}`;
  if (mode === "flagged") heading = `Filed to ${catName} — similar title already saved`;
  browser.notifications.create(nid, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-48.png"),
    title: heading,
    message: title,
  });
  lastFiled.set(nid, bookmarkId);
  if (lastFiled.size > 200) lastFiled.delete(lastFiled.keys().next().value);
}

// undo via notification click
browser.notifications.onClicked.addListener(async (nid) => {
  const bid = lastFiled.get(nid);
  if (bid) { try { await browser.bookmarks.remove(bid); } catch (e) {} lastFiled.delete(nid); }
  browser.notifications.clear(nid);
});

// on page load complete
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") fileTab(tab, "load");
});

// on tab close — must read tab info before it's gone, so we keep a live
// snapshot of each tab. Titles and URLs can arrive in SEPARATE onUpdated
// events (and some pages, like GitHub's PDF viewer, populate the title late
// or only after the tab is activated), so we MERGE partial data rather than
// requiring url+title in a single event.
const cache = new Map();

function remember(tabId, tab) {
  if (!tab) return;
  const prev = cache.get(tabId) || {};
  const next = {
    id: tabId,
    url: tab.url || prev.url,
    title: tab.title || prev.title,
    favIconUrl: tab.favIconUrl || prev.favIconUrl,
  };
  // Only store once we at least have a URL; title may fill in later.
  if (next.url) {
    cache.set(tabId, next);
    if (cache.size > MAX_MAP) cache.delete(cache.keys().next().value);
  }
}

browser.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  remember(tabId, tab);
});

browser.tabs.onRemoved.addListener((tabId) => {
  const tab = cache.get(tabId);
  if (tab && tab.url && tab.title) fileTab(tab, "close");
  cache.delete(tabId);
});

// first run
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const { settings } = await getState();
    if (!settings.onboarded) {
      browser.tabs.create({ url: browser.runtime.getURL("onboarding/onboarding.html") });
    }
  }
});

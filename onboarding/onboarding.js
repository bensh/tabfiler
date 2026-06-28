import { setSettings, isDemo, runtimeApi } from "../lib/store.js";

const steps = Array.from(document.querySelectorAll(".step"));
const pips = Array.from(document.querySelectorAll(".ob__progress i"));
let cur = 0;

function show(i) {
  cur = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach((s, idx) => s.classList.toggle("is-active", idx === cur));
  pips.forEach((p, idx) => p.classList.toggle("on", idx <= cur));
  const active = steps[cur].querySelector("h1, .ob__h1");
  active && active.setAttribute("tabindex", "-1"), active && active.focus();
}

document.querySelectorAll(".ob__next").forEach((b) => b.addEventListener("click", () => show(cur + 1)));
document.querySelectorAll(".ob__back").forEach((b) => b.addEventListener("click", () => show(cur - 1)));

document.getElementById("finish").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  await setSettings({
    onboarded: true,
    autoOnLoad: mode === "load",
    autoOnClose: mode === "close" || mode === "load",
  });
  if (isDemo) { window.location.href = "../options/options.html#review"; return; }
  const api = runtimeApi();
  api.tabs.create({ url: api.runtime.getURL("options/options.html#review") });
  const tab = await api.tabs.getCurrent();
  if (tab) api.tabs.remove(tab.id);
});

show(0);

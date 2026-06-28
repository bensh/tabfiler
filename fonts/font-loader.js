// TabFiler — font fallback.
// Local fonts (fonts/fonts.css) are linked in the HTML and load first.
// This script verifies the bundled faces actually loaded; if any failed
// (missing file, corruption, blocked), it injects the Google Fonts CDN
// stylesheet as a one-time fallback so text still renders in-brand.
//
// The CSP allows style-src from fonts.googleapis.com and font-src from
// fonts.gstatic.com for exactly this fallback path.

(function () {
  const CDN = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

  // Faces we expect from the local bundle.
  const REQUIRED = [
    '600 1em "Space Grotesk"',
    '400 1em "JetBrains Mono"',
  ];

  function injectCdn(reason) {
    if (document.getElementById("tf-font-cdn")) return;
    const link = document.createElement("link");
    link.id = "tf-font-cdn";
    link.rel = "stylesheet";
    link.href = CDN;
    document.head.appendChild(link);
    // Not an error the user needs to see; quietly note why we fell back.
    console.info("TabFiler: using CDN font fallback —", reason);
  }

  if (!("fonts" in document)) {
    // Very old engine without the Font Loading API: trust the local @font-face,
    // and only fall back if document.fonts is unavailable entirely.
    return;
  }

  // Give the bundled fonts a chance to load, then check.
  const check = () =>
    Promise.all(REQUIRED.map((f) => document.fonts.load(f).then((got) => got.length > 0)))
      .then((results) => {
        if (results.some((ok) => !ok)) injectCdn("a bundled face did not load");
      })
      .catch((e) => injectCdn("font check failed: " + e.message));

  if (document.fonts.ready) {
    document.fonts.ready.then(check);
  } else {
    window.addEventListener("load", check);
  }
})();

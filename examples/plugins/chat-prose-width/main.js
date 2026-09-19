/**
 * Chat Prose Width (v0.4.0)
 *
 * Adjusts the max display width of message text inside the conversation.
 *
 * Mechanism:
 * - Message text width is `min(100%, var(--chat-prose-max-width, 720px))`.
 * - The built-in drag handles write the width variables as INLINE styles on
 *   `.chat-surface`; a value on the ancestor `.main-pane` is shadowed. So the
 *   contributed CSS targets `.chat-surface` itself with `!important` (an
 *   important stylesheet declaration beats a normal inline style).
 * - Theme CSS is the only sanctioned way for a plugin to reach the main
 *   window DOM, and the sheet applies only while its theme is selected. The
 *   width theme therefore appears in Settings → Theme — an inherent cost.
 *
 * Cooperation rules:
 * - While our theme is selected, the app palette equals the theme's `base`.
 *   `base` is resolved from `app.getAppearance()` and NEVER guessed.
 * - Dangling preference repair: after a hot reload or restart the stored
 *   preference may point at our theme before it is re-registered. The host
 *   then reports `base: "system"` and v0.3.0 waited forever (the bug behind
 *   "theme gone, width dead"). Now we detect that window, repair the
 *   preference to a builtin id first, then register and select.
 * - Stand down: when the user switches to any other theme, we stop
 *   re-selecting ours. Changing a plugin setting re-activates it.
 * - Unload: restore a builtin preference only if our theme is still the
 *   selected one; never clobber a choice the user made without us.
 */

const PLUGIN_ID = "local.chat-prose-width";
const THEME_ID = "prose-width";
const FULL_THEME_ID = `plugin:${PLUGIN_ID}:${THEME_ID}`;
const DEFAULT_PROSE_WIDTH = 720;
const MIN_CUSTOM_WIDTH = 200;
const MAX_CUSTOM_WIDTH = 4000;
const MAX_BASE_RETRIES = 5;

/** Latest builtin preference we have seen; restored when we step aside. */
let previousTheme = null;
/** False after the user manually switches away from our theme. */
let active = true;
/** True while appearance events are caused by our own setTheme calls. */
let suppressStandDown = false;
let settingsHandler;
let appearanceHandler;
let baseRetryTimer;
let baseRetries = 0;

function buildCss(proseWidth, bg, base) {
  const lines = [".chat-surface {"];
  lines.push(`  --chat-prose-max-width: ${proseWidth}px !important;`);
  lines.push(`  --chat-content-max-width: max(760px, ${proseWidth}px) !important;`);
  lines.push(`  --chat-composer-max-width: max(760px, ${proseWidth}px) !important;`);
  lines.push("}");

  if (bg && bg.image) {
    // Backdrop layer: the image with blur, plus a veil on top so text stays
    // readable. Fixed attachment keeps it still while content scrolls.
    lines.push(".app-shell::before {");
    lines.push('  content: "";');
    lines.push("  position: fixed;");
    lines.push("  inset: 0;");
    lines.push("  z-index: 0;");
    // Backslashes are CSS escape characters inside url(): `C:\Users` would be
    // parsed as escapes and mangled before the host ever sees the path. Use
    // forward slashes — the host's asset resolver accepts both forms.
    const assetUrl = bg.image.replaceAll("\\", "/");
    lines.push(`  background: url("${assetUrl}") center / cover no-repeat fixed;`);
    lines.push(`  filter: blur(${bg.blur}px);`);
    lines.push("  pointer-events: none;");
    lines.push("}");
    if (bg.blur > 0) {
      // Soften blur edge artifacts at the viewport border.
      lines.push(".app-shell::before {");
      lines.push(`  transform: scale(${1 + bg.blur / 100});`);
      lines.push("}");
    }
    if (bg.dim > 0) {
      // Veil color follows the palette: dark veil on the dark theme, light on
      // the light theme, so text of either palette stays readable.
      const veil = base === "light" ? "255, 255, 255" : "0, 0, 0";
      lines.push(".app-shell::after {");
      lines.push('  content: "";');
      lines.push("  position: fixed;");
      lines.push("  inset: 0;");
      lines.push("  z-index: 0;");
      lines.push(`  background: rgba(${veil}, ${bg.dim / 100});`);
      lines.push("  pointer-events: none;");
      lines.push("}");
    }
    // Translucent surface tokens so the backdrop shows through every opaque
    // region: main shell, work panel dock, elevated sheets, side rail. The
    // tint follows the palette so a light theme never gets black surfaces
    // under dark text (and vice versa). Higher dim => more opaque surfaces,
    // which also restores readability over busy images.
    const tint = base === "light" ? "255, 255, 255" : "18, 18, 21";
    const tintAlt = base === "light" ? "246, 246, 248" : "28, 28, 32";
    // Primary surfaces sit near the chosen haze; secondary surfaces stay a
    // little clearer so the layering of the shell remains perceptible.
    const haze = bg.surface / 100;
    const alpha = Math.min(1, haze + 0.06);
    const alphaAlt = Math.min(1, haze * 0.82);
    lines.push(":root, .app-shell {");
    lines.push(`  --ds-bg-primary: rgba(${tint}, ${alpha}) !important;`);
    lines.push(`  --ds-bg-secondary: rgba(${tintAlt}, ${alphaAlt}) !important;`);
    lines.push(`  --ds-bg-tertiary: rgba(${tintAlt}, ${alphaAlt}) !important;`);
    lines.push(`  --ds-bg-inset: rgba(${tintAlt}, ${alphaAlt}) !important;`);
    lines.push(`  --ds-bg-under: rgba(${tint}, ${alpha}) !important;`);
    lines.push(`  --ds-bg-dock: rgba(${tintAlt}, ${alphaAlt}) !important;`);
    lines.push(`  --ds-bg-dock-raised: rgba(${tint}, ${alpha}) !important;`);
    lines.push(`  --ds-bg-elevated: rgba(${tint}, ${alpha}) !important;`);
    lines.push(`  --ds-bg-elevated-opaque: rgba(${tint}, ${alpha}) !important;`);
    lines.push(`  --ds-bg-elevated-primary: rgba(${tint}, ${alpha}) !important;`);
    lines.push(`  --ds-bg-composer: rgba(${tint}, ${alpha}) !important;`);
    lines.push(`  --ds-bg-sidebar: rgba(${tintAlt}, ${alphaAlt}) !important;`);
    lines.push("}");
    // Modal dialogs (plugin settings sheet, confirm dialogs) float above the
    // backdrop and carry dense forms; translucency stacks their text on the
    // background image and wrecks readability. Keep them opaque, with their
    // own opaque token so nested surfaces inherit the fix too.
    lines.push(".plugins-modal {");
    lines.push(`  background: rgba(${tint}, 1) !important;`);
    lines.push(`  --ds-bg-elevated-opaque: rgba(${tint}, 1) !important;`);
    lines.push("}");
  }
  return lines.join("\n");
}

/**
 * Custom pixel entry wins over the preset when it is a positive finite
 * number; otherwise fall back to the preset select. Bounds keep a typo
 * (e.g. "80" or "80000") from breaking the layout.
 */
function resolveProseWidth(settings) {
  const custom = Number(settings.customWidth);
  if (Number.isFinite(custom) && custom >= MIN_CUSTOM_WIDTH && custom <= MAX_CUSTOM_WIDTH) {
    return Math.round(custom);
  }
  const preset = Number(settings.proseWidth);
  if (Number.isFinite(preset) && preset > 0) return Math.round(preset);
  return DEFAULT_PROSE_WIDTH;
}

/**
 * Background settings, validated before they reach the theme CSS: the host
 * rejects the WHOLE sheet when a url() target fails its checks, so a bad
 * image path would silently take the width overrides down with it. We check
 * existence/extension/size here (plugin process has plain Node fs) and only
 * include the backdrop when the image passes; failures surface as a toast.
 */
function resolveBackground(settings) {
  const raw = typeof settings.bgImage === "string" ? settings.bgImage : "";
  // Strip invisible direction/format control chars — Windows "Copy path" and
  // explorer address bars sometimes prefix a U+202A LRE that makes the path
  // look right while the filesystem cannot find it.
  const image = raw.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim();
  if (!image) return null;
  const blur = clampNumber(settings.bgBlur, 0, 40, 0);
  // The dim veil was removed as a setting: readability is controlled by the
  // surface haze alone, so the backdrop is always rendered undimmed.
  const dim = 0;
  // User-chosen surface haze: 0 = fully translucent surfaces (background at
  // its clearest, lowest text contrast), 100 = opaque surfaces (background
  // hidden). This is the knob that trades background visibility for
  // readability; dim alone no longer decides it.
  const surface = clampNumber(settings.bgSurface, 0, 100, 50);
  const check = checkImageFile(image);
  if (!check.ok) {
    lastBgError = check.error;
    return null;
  }
  lastBgError = null;
  return { image, blur, dim, surface };
}

/** Last backdrop validation failure, surfaced as a toast by applyTheme. */
let lastBgError = null;

const BG_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".avif"];

function checkImageFile(path) {
  const { existsSync, statSync } = require("node:fs");
  const lower = path.toLowerCase();
  if (!BG_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { ok: false, error: "背景图仅支持 jpg/png/webp/avif" };
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false, error: `背景图文件不存在：${path}` };
  }
  if (!stats.isFile()) {
    return { ok: false, error: "背景图路径不是文件" };
  }
  if (stats.size > 4 * 1024 * 1024) {
    return { ok: false, error: `背景图超过 4MB（当前 ${(stats.size / 1048576).toFixed(1)}MB）` };
  }
  return { ok: true };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isBuiltinTheme(value) {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Resolved light/dark palette, or null when unresolved. `base: "system"`
 * reaches plugins only when the preference points at a plugin theme that is
 * not currently registered — i.e. a dangling id, usually our own during the
 * load window. It never means "the OS palette" here.
 */
async function currentBase() {
  try {
    const appearance = await pi.app.getAppearance();
    if (appearance.base === "light") return "light";
    if (appearance.base === "dark") return "dark";
    return null;
  } catch {
    return null;
  }
}

/** Run `fn` without the appearance handler treating the change as a user pick. */
async function withSelfInflictedThemeChange(fn) {
  suppressStandDown = true;
  try {
    await fn();
  } finally {
    setTimeout(() => {
      suppressStandDown = false;
    }, 1000);
  }
}

async function activateWidthTheme() {
  if (!active) return;
  let base = await currentBase();
  if (base === null) {
    // Dangling plugin-theme preference (typically ours after a reload).
    // Repair it to a builtin first — the host already renders the system
    // palette in this window, so this repairs rather than clobbers.
    await withSelfInflictedThemeChange(async () => {
      try {
        await pi.app.setTheme(previousTheme ?? "system");
      } catch {
        // Best-effort repair; retry below either way.
      }
    });
    base = await currentBase();
    if (base === null) {
      scheduleBaseRetry();
      return;
    }
  }
  baseRetries = 0;

  const settings = await pi.plugin.getSettings();
  const proseWidth = resolveProseWidth(settings);
  currentWidth = proseWidth;
  const bg = resolveBackground(settings);
  if (lastBgError) {
    try {
      await pi.ui.showToast(`背景图未应用：${lastBgError}`, "warn");
    } catch {
      // Toast is best-effort.
    }
  }
  const payload = { id: THEME_ID, label: "sqing主题", base, css: buildCss(proseWidth, bg, base) };

  try {
    await pi.themes.upsert(payload);
  } catch (error) {
    // The host rejects the WHOLE sheet when a url() target fails its own
    // checks. Retry once without the backdrop so the width overrides (and a
    // readable theme) survive a background the host will not serve.
    try {
      await pi.ui.showToast(`背景图被宿主拒绝，已仅应用文字宽度：${error?.message ?? error}`, "warn");
    } catch {
      // Toast is best-effort.
    }
    await pi.themes.upsert({ ...payload, css: buildCss(proseWidth, null, base) });
  }
  await withSelfInflictedThemeChange(() => pi.app.setTheme(FULL_THEME_ID));
}

function scheduleBaseRetry() {
  if (baseRetryTimer || baseRetries >= MAX_BASE_RETRIES) return;
  baseRetries += 1;
  baseRetryTimer = setTimeout(() => {
    baseRetryTimer = undefined;
    void activateWidthTheme();
  }, 1500);
}

async function onLoad() {
  try {
    const appearance = await pi.app.getAppearance();
    if (isBuiltinTheme(appearance.theme)) {
      previousTheme = appearance.theme;
    }
  } catch {
    // Best-effort: unload falls back to "system" then.
  }

  await activateWidthTheme();

  settingsHandler = () => {
    // Changing a plugin setting is the explicit "make it active again" signal.
    active = true;
    void activateWidthTheme();
  };
  appearanceHandler = () => {
    void (async () => {
      try {
        const appearance = await pi.app.getAppearance();
        if (isBuiltinTheme(appearance.theme)) {
          // Track the latest builtin preference for a polite restore.
          previousTheme = appearance.theme;
        }
        if (suppressStandDown) return;
        if (appearance.theme !== FULL_THEME_ID) {
          // The user chose a different theme. Stand down and keep their pick.
          active = false;
          return;
        }
        // Still ours — nothing to do; re-selecting would only echo.
      } catch {
        // Never fight the host over the theme.
      }
    })();
  };
  pi.events.on("plugin:settingsChanged", settingsHandler);
  pi.events.on("appearance:changed", appearanceHandler);
}

async function onUnload() {
  if (settingsHandler) {
    pi.events.off("plugin:settingsChanged", settingsHandler);
    settingsHandler = undefined;
  }
  if (appearanceHandler) {
    pi.events.off("appearance:changed", appearanceHandler);
    appearanceHandler = undefined;
  }
  if (baseRetryTimer) {
    clearTimeout(baseRetryTimer);
    baseRetryTimer = undefined;
  }

  // Restore only if our theme is still selected, so a preference the user
  // chose on their own is never clobbered. Restore BEFORE removing the theme
  // so the preference never points at a theme that is already gone.
  try {
    const appearance = await pi.app.getAppearance();
    if (appearance.theme === FULL_THEME_ID) {
      await withSelfInflictedThemeChange(() =>
        pi.app.setTheme(previousTheme ?? "system"),
      );
    }
  } catch {
    // Best-effort; the host falls back to system if this fails.
  }
  try {
    await pi.themes.remove(THEME_ID);
  } catch {
    // The theme may already be gone.
  }
  previousTheme = null;
  active = true;
  baseRetries = 0;
}

module.exports = { onLoad, onUnload };
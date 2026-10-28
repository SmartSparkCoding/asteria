/**
 * The Orbit design system.
 *
 * One place for the Catppuccin Mocha palette and the shared chrome, because the
 * dashboard and the huddle page each embed their own stylesheet and used to
 * repeat the same GitHub-dark literals in two files.
 *
 * Roles are bound to Catppuccin names, never to raw hex at the point of use:
 * change a role here and every surface follows. Light mode is intentionally not
 * implemented. Slack's own chrome is dark, the huddle pages are dark, and a
 * second theme that nobody asked for would double every colour decision. The
 * tokens are structured so a Latte block could be added against the same roles.
 */
export const CTP = {
  rosewater: '#f5e0dc',
  flamingo: '#f2cdcd',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  maroon: '#eba0ac',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',
  text: '#cdd6f4',
  subtext1: '#bac2de',
  subtext0: '#a6adc8',
  overlay2: '#9399b2',
  overlay1: '#7f849c',
  overlay0: '#6c7086',
  surface2: '#585b70',
  surface1: '#45475a',
  surface0: '#313244',
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
};

/** Alpha helpers, so translucent surfaces stay tied to the palette. */
function alpha(hex, value) {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${value})`;
}

const mauve = CTP.mauve;
const lavender = CTP.lavender;
const blue = CTP.blue;
const red = CTP.red;
const text = CTP.text;

/**
 * The variable block both stylesheets start with. Kept as a string because the
 * pages are server rendered with no build step.
 */
export const THEME_TOKENS = `:root{color-scheme:dark;
  /* Catppuccin Mocha roles */
  --ctp-rosewater:${CTP.rosewater};--ctp-mauve:${mauve};--ctp-lavender:${lavender};
  --ctp-blue:${blue};--ctp-peach:${CTP.peach};--ctp-green:${CTP.green};
  --ctp-yellow:${CTP.yellow};--ctp-red:${red};
  --ctp-text:${text};--ctp-subtext1:${CTP.subtext1};--ctp-subtext0:${CTP.subtext0};
  --ctp-crust:${CTP.crust};--ctp-surface0:${CTP.surface0};--ctp-surface1:${CTP.surface1};

  /* Surface roles. Base is the page, Mantle is a panel sunk into it, Surface0 is
     a raised row, input or knob. Borders are hairlines, not boxes. */
  --bg:${CTP.base};--surface:${CTP.mantle};--raised:${CTP.surface0};
  --line:${CTP.surface0};--line-soft:${CTP.surface0};

  /* Ink. Text for primary, Subtext1 for secondary, Subtext0 for hints. */
  --ink:${text};--ink-2:${CTP.subtext1};--ink-3:${CTP.subtext0};

  /* Accents. Mauve is the product accent, lavender is the readable link/hover
     colour, and the rest are semantic only. */
  --accent:${mauve};--accent-bright:${lavender};
  --gold:${CTP.yellow};--bronze:${CTP.peach};--silver:${CTP.subtext1};--red:${red};
  --green:${CTP.green};--blue:${blue};--rosewater:${CTP.rosewater};

  /* Translucent surfaces, all derived from the palette above. */
  --tint:${alpha(mauve, 0.07)};--tint-2:${alpha(mauve, 0.12)};
  --ring:${alpha(mauve, 0.35)};--ring-strong:${alpha(mauve, 0.6)};
  --glow:${alpha(mauve, 0.1)};
  --bar-top:${alpha(mauve, 0.9)};--bar-bottom:${alpha(mauve, 0.22)};
  --blue-tint:${alpha(blue, 0.16)};--blue-ring:${alpha(blue, 0.3)};
  --red-tint:${alpha(red, 0.08)};--red-ring:${alpha(red, 0.3)};
  --dot-halo:${alpha(CTP.subtext0, 0.18)};
  --glass:${alpha(CTP.base, 0.88)};--scrim:${alpha(CTP.crust, 0.72)};--shadow:${alpha(CTP.crust, 0.6)};
  --knob:${CTP.text};

  --r:10px;--r-sm:6px;--r-lg:14px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}`;

/**
 * The Orbit mark: a planet with a tilted orbital path and one moon. Clean
 * geometry, no gradients, inherits the accent of whatever it sits in.
 */
export const ORBIT_MARK_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.1"/><ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(-24 12 12)"/><circle cx="20.1" cy="7.6" r="1.4" fill="currentColor" stroke="none"/></svg>`;

/** The same mark as a standalone favicon. */
export const ORBIT_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${CTP.crust}"/><circle cx="12" cy="12" r="3.9" fill="none" stroke="${mauve}" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="9.4" ry="4.1" transform="rotate(-24 12 12)" fill="none" stroke="${lavender}" stroke-width="1.3"/><circle cx="19.9" cy="7.7" r="1.3" fill="${lavender}"/></svg>`;

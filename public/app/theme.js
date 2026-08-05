// The theme button: system → light → dark, and back to system.
//
// "System" is the default and the first state in the cycle, so the app keeps
// following the device unless it is told otherwise — the same behaviour it had
// before this button existed.
//
// All the CSS needs is `data-theme` on <html>; style.css maps that onto
// `color-scheme`, and every token is a light-dark() pair that follows. There is
// no class to toggle on individual elements and no second palette.
//
// The saved choice is applied by a small inline script in each page's <head>
// (see index.html) so the first paint is already the right colour. This module
// handles the button and everything that has to happen after load.

const KEY = 'medreminder.theme';
const CYCLE = ['system', 'light', 'dark'];

const LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

// Matches the theme-color metas in the page head.
const CHROME = { light: '#f4f7fb', dark: '#0f1720' };

const ICON = {
  system: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm0 14.2V1.8a6.2 6.2 0 0 1 0 12.4Z"/></svg>',
  light:  '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 11.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4ZM8 3a.9.9 0 0 1-.9-.9V.9a.9.9 0 1 1 1.8 0v1.2A.9.9 0 0 1 8 3Zm0 12a.9.9 0 0 1-.9-.9v-1.2a.9.9 0 1 1 1.8 0v1.2A.9.9 0 0 1 8 15Zm7-7a.9.9 0 0 1-.9.9h-1.2a.9.9 0 1 1 0-1.8h1.2A.9.9 0 0 1 15 8ZM3 8a.9.9 0 0 1-.9.9H.9a.9.9 0 1 1 0-1.8h1.2A.9.9 0 0 1 3 8Zm9.9-4.9-.9.9a.9.9 0 0 1-1.2-1.2l.9-.9a.9.9 0 0 1 1.2 1.2ZM4.2 11.8l-.9.9a.9.9 0 0 1-1.2-1.2l.9-.9a.9.9 0 0 1 1.2 1.2Zm8.7.9-.9-.9a.9.9 0 0 1 1.2-1.2l.9.9a.9.9 0 0 1-1.2 1.2ZM4.2 4.2l-.9-.9a.9.9 0 0 1 1.2-1.2l.9.9a.9.9 0 0 1-1.2 1.2Z"/></svg>',
  dark:   '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M14 9.8A6.4 6.4 0 0 1 6.2 2 6.4 6.4 0 1 0 14 9.8Z"/></svg>',
};

// localStorage throws in a locked-down browser rather than returning null, and
// a theme preference is not worth a broken page.
function stored() {
  try {
    const value = localStorage.getItem(KEY);
    return CYCLE.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

function remember(theme) {
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch { /* private mode; the choice just will not survive a reload */ }
}

// What the theme resolves to right now — "system" depends on the device.
function resolved(theme) {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Keep the browser chrome in step with the page. The two metas in the head are
// media-scoped for the system case; forcing a theme sets both to the same
// colour so whichever one the browser picks is the right one.
function syncChrome(theme) {
  const colour = CHROME[resolved(theme)];
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (theme === 'system') meta.content = meta.media.includes('dark') ? CHROME.dark : CHROME.light;
    else meta.content = colour;
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  syncChrome(theme);
}

// Wires the button in the top bar. The visible label is the current mode; the
// accessible name also says what pressing it will do, because "Light" alone
// does not tell you whether that is the state or the action.
export function mountThemeToggle(button) {
  if (!button) return;

  let theme = stored();

  function paint() {
    const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
    button.innerHTML = `${ICON[theme]}<span>${LABEL[theme]}</span>`;
    button.setAttribute('aria-label', `Colour theme: ${LABEL[theme].toLowerCase()}. Switch to ${LABEL[next].toLowerCase()}.`);
    button.title = `Theme: ${LABEL[theme]} — click for ${LABEL[next]}`;
  }

  applyTheme(theme);
  paint();

  button.addEventListener('click', () => {
    theme = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
    remember(theme);
    applyTheme(theme);
    paint();
  });

  // On "system", follow the device if it changes underneath us — a laptop
  // switching to dark at sunset should take the app with it.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme === 'system') syncChrome(theme);
  });
}

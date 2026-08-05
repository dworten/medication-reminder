// Shell: who is signed in, which screen is showing, and signing out.
//
// Routing lives in the hash. The server serves one shell for /app and the
// client decides what to draw, so there is no set of server routes to keep in
// step with the screens — and a reload or a bookmarked #/history still lands
// where you expect.

import { api }  from './api.js';
import { $, toast } from './ui.js';

import { renderToday }     from './screens/today.js';
import { renderSchedules } from './screens/schedules.js';
import { renderContacts }  from './screens/contacts.js';
import { renderMessages }  from './screens/messages.js';
import { renderHistory }   from './screens/history.js';

const SCREENS = {
  today:     renderToday,
  schedules: renderSchedules,
  contacts:  renderContacts,
  messages:  renderMessages,
  history:   renderHistory,
};

// Shared read-only context handed to every screen. The account's timezone is
// here because timestamps are rendered in HER clock, not the browser's — this
// is checked from other timezones and a silent shift of every time by six hours
// would be worse than useless.
export const context = { account: null };

function currentTab() {
  const name = (window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return SCREENS[name] ? name : 'today';
}

let renderToken = 0;

async function route() {
  const tab    = currentTab();
  const screen = $('#screen');

  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  // Navigating away mid-load must not let a slow screen paint over the new one.
  const token = ++renderToken;
  screen.innerHTML = '<p class="loading">Loading…</p>';

  try {
    const html = await SCREENS[tab](context);
    if (token !== renderToken) return;
    screen.replaceChildren(html);
  } catch (err) {
    if (token !== renderToken) return;
    // A 401 has already redirected by this point; anything reaching here is
    // worth showing rather than swallowing.
    screen.innerHTML = `<div class="banner banner-bad">Could not load this screen: ${err.message}</div>`;
  }
}

async function start() {
  try {
    const me = await api.me();
    context.account = me.account;
    $('#whoami').textContent = me.account.email;
  } catch (err) {
    // api.js redirects on 401, so reaching here means the server is unreachable
    // rather than the session being gone.
    $('#screen').innerHTML =
      `<div class="banner banner-bad">Could not reach the server. ${err.message}</div>`;
    return;
  }

  $('#signout').addEventListener('click', async () => {
    try {
      await api.logout();
    } finally {
      window.location.href = '/login';
    }
  });

  window.addEventListener('hashchange', route);
  await route();
}

// Lets a screen ask for a redraw after it changes something.
export function refresh() {
  return route();
}

// Screens navigate through this rather than assigning location.hash directly,
// so a same-tab navigation still redraws.
export function go(tab) {
  if (currentTab() === tab) return route();
  window.location.hash = `#/${tab}`;
  return undefined;
}

start().catch((err) => toast(err.message, 'bad'));

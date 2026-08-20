// Messages — the reusable library of reminder wording.

import { api } from '../api.js';
import {
  node, esc, badge, toast, confirmAction, readForm,
  showFieldErrors, clearFieldErrors,
} from '../ui.js';
import { refresh } from '../app.js';

// Placeholder wording for an empty new message, and the sentence the app always
// appends on a call. Neither is a message row; both are here only to be shown.
const BUILT_IN = 'Hi, this is your medicine reminder.';
const QUESTION = 'Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.';

// Display names for the stored kinds. The stored values (TTS / AUDIO / TEXT)
// are untouched — they travel to the API, the schema and the call path, so
// renaming them here is a label change and nothing more.
const KIND_LABEL = {
  TTS:   'Voice Typed Message',
  AUDIO: 'Voice Recorded Message',
  TEXT:  'Text Message',
};

// "Make default" appears only on typed voice messages: the default exists to be
// what an event schedule speaks when it has no message of its own, and the
// schedule picker offers typed messages alone — a recording or a text marked
// default would be a default nothing can use. There is deliberately no
// "unset": the default moves by making another message the default, so an
// account with one can never quietly end up with none.
function card(message) {
  const canBeDefault = message.kind === 'TTS' && !message.isDefault;

  return `<article class="card message" data-id="${esc(message.id)}">
    <div class="card-head">
      <div>
        <h3 class="card-title">${esc(message.name)}</h3>
        <p class="tag-row">
          ${message.isDefault ? badge('Default', 'ok') : ''}
          ${badge(KIND_LABEL[message.kind] || message.kind, 'info')}
        </p>
      </div>
      <div class="card-actions">
        ${canBeDefault ? '<button class="small" data-act="make-default">Make default</button>' : ''}
        <button class="small" data-act="edit">Edit</button>
      </div>
    </div>
    <p class="message-body">
      ${message.kind === 'AUDIO'
        ? esc(message.audioUrl || '(no file)')
        : `“${esc(message.ttsText || '(no text)')}”`}
    </p>
  </article>`;
}

// The three ways a new message can start. Editing skips this — an existing row
// already knows its kind — and the form never asks again: the kind rides along
// in a hidden input rather than a Type dropdown.
function chooser() {
  return `<div id="kind-chooser" class="panel">
    <h2 class="panel-title">New Message</h2>
    <div class="kind-choice">
      <button type="button" data-kind="TTS">
        <span class="choice-title">Voice Typed Message</span>
        <span class="small muted">Written here, spoken aloud by the call.</span>
      </button>
      <button type="button" data-kind="AUDIO">
        <span class="choice-title">Voice Recorded Message</span>
        <span class="small muted">An audio recording, played on the call.</span>
      </button>
      <button type="button" data-kind="TEXT">
        <span class="choice-title">Text Message</span>
        <span class="small muted">Sent as an SMS, never spoken.</span>
      </button>
    </div>
    <div class="button-row"><button type="button" data-act="cancel">Cancel</button></div>
  </div>`;
}

// One form for all three kinds. The kind is fixed before the form opens, so
// there is no Type control; the section a kind cannot use is grayed out rather
// than removed — its inputs are disabled, which keeps them out of the submitted
// payload (readForm skips disabled elements, and on a partial update an absent
// field means "leave it alone"), while the form keeps one recognisable shape
// across all three kinds.
//
// The "always asked" note is left off the Text form: the question belongs to
// the voice call's Gather, and a text message has no Gather to feed.
function form(message, kind) {
  const m = message || { name: '', ttsText: '', audioUrl: '', voice: '', language: '' };

  const isTyped    = kind === 'TTS';
  const isRecorded = kind === 'AUDIO';
  const isText     = kind === 'TEXT';

  const off = (relevant) => (relevant ? '' : 'disabled');
  const dim = (relevant) => (relevant ? '' : ' grayed');

  return `<form id="message-form" class="panel" novalidate>
    <h2 class="panel-title">${message ? 'Edit' : 'New'} ${esc(KIND_LABEL[kind])}</h2>
    <input type="hidden" name="kind" value="${esc(kind)}">

    <div class="form-grid">
      <div class="field span-2"><label for="m-name">Name <span class="hint">— for your reference, never spoken or sent</span></label>
        <input id="m-name" name="name" type="text" value="${esc(m.name)}" required></div>
    </div>

    <div class="field${dim(isRecorded)}"><label for="m-url">Audio file URL <span class="hint">— must be https; Twilio fetches it during the call</span></label>
      <input id="m-url" name="audioUrl" type="url" value="${esc(m.audioUrl || '')}" placeholder="https://example.com/reminder.mp3" ${off(isRecorded)}></div>

    <div class="field${dim(!isRecorded)}"><label for="m-text">${isText ? 'Message text' : 'What to say'}</label>
      <textarea id="m-text" name="ttsText" placeholder="${esc(BUILT_IN)}" ${off(!isRecorded)}>${esc(m.ttsText || '')}</textarea></div>
    <div class="field${dim(isTyped)}"><label for="m-voice">Voice <span class="hint">— optional Twilio voice name; blank uses the default</span></label>
      <input id="m-voice" name="voice" type="text" value="${esc(m.voice || '')}" placeholder="Polly.Joanna" ${off(isTyped)}></div>
    <div class="field${dim(isTyped)}"><label for="m-lang">Language <span class="hint">— optional, e.g. en-US</span></label>
      <input id="m-lang" name="language" type="text" value="${esc(m.language || '')}" placeholder="en-US" ${off(isTyped)}></div>

    ${isText ? '' : `<p class="small muted">
      The question is always asked by the app after your message, so a Gather still makes sense
      whatever it says: “${esc(QUESTION)}”
    </p>`}

    <div class="button-row">
      <button type="submit" class="primary">${message ? 'Save changes' : 'Create message'}</button>
      <button type="button" data-act="cancel">Cancel</button>
      <span class="spacer"></span>
      ${message ? '<button type="button" class="danger" data-act="delete">Delete</button>' : ''}
    </div>
  </form>`;
}

export async function renderMessages() {
  const { messages } = await api.messages.list();

  const el = node(`
    <div class="page-head">
      <div>
        <h1>Messages</h1>
        <p class="sub">These are the messages that you can choose from to send to the primary recipient either by voice call or text message.</p>
      </div>
      <div class="button-row"><button class="primary" data-act="new">New message</button></div>
    </div>

    <div id="library">
    ${messages.length && !messages.some((m) => m.isDefault)
      ? `<div class="banner banner-warn"><span><strong>No message is marked as the default.</strong>
          An event schedule with no message of its own will speak the built-in wording
          — “${esc(BUILT_IN)}” — which cannot be edited here.</span></div>`
      : ''}
    <div id="list" class="card-grid">
      ${messages.length ? messages.map(card).join('') : '<p class="empty">No messages yet.</p>'}
    </div>
    </div>
    <div id="editor"></div>
  `);

  // The whole library hides while the editor is open, or the form appears to
  // belong to whichever card it happens to sit under.
  const library = el.querySelector('#library');
  const editor  = el.querySelector('#editor');
  const newBtn  = el.querySelector('[data-act="new"]');

  function closeEditor() {
    editor.innerHTML = '';
    library.style.display = '';
    newBtn.style.display = '';
  }

  function openPanel(html) {
    library.style.display = 'none';
    newBtn.style.display = 'none';
    editor.innerHTML = html;
    return editor.firstElementChild;
  }

  function openChooser() {
    const panel = openPanel(chooser());
    panel.querySelector('[data-act="cancel"]').addEventListener('click', closeEditor);
    for (const button of panel.querySelectorAll('[data-kind]')) {
      button.addEventListener('click', () => openEditor(null, button.dataset.kind));
    }
  }

  function openEditor(message, kind = message?.kind || 'TTS') {
    const formEl = openPanel(form(message, kind));

    formEl.querySelector('[data-act="cancel"]').addEventListener('click', closeEditor);

    formEl.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      if (!confirmAction(`Delete "${message.name}"? Event schedules using it fall back to the built-in wording.`)) return;
      try {
        const result = await api.messages.remove(message.id);
        toast(result?.schedulesReset?.length
          ? `Deleted — ${result.schedulesReset.length} event schedule(s) reverted to the default wording`
          : 'Message deleted');
        await refresh();
      } catch (err) { toast(err.message, 'bad'); }
    });

    formEl.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(formEl);

      const data = readForm(formEl, { nullable: ['ttsText', 'audioUrl', 'voice', 'language'] });
      const submit = formEl.querySelector('[type="submit"]');
      submit.disabled = true;

      try {
        if (message) await api.messages.update(message.id, data);
        else         await api.messages.create(data);
        toast(message ? 'Message saved' : 'Message created');
        await refresh();
      } catch (err) {
        submit.disabled = false;
        if (!showFieldErrors(formEl, err.details)) toast(err.message, 'bad');
        else toast('Check the highlighted fields', 'bad');
      }
    });
  }

  newBtn.addEventListener('click', openChooser);

  for (const article of el.querySelectorAll('.card[data-id]')) {
    const message = messages.find((m) => m.id === article.dataset.id);
    article.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(message));

    article.querySelector('[data-act="make-default"]')?.addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        await api.messages.update(message.id, { isDefault: true });
        toast(`"${message.name}" is now the default message`);
        await refresh();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    });
  }

  return el;
}

// Messages — the reusable library of reminder wording.

import { api } from '../api.js';
import {
  node, esc, badge, toast, confirmAction, readForm,
  showFieldErrors, clearFieldErrors,
} from '../ui.js';
import { refresh } from '../app.js';

// What the call actually says when a schedule has no message attached. Shown so
// the built-in wording is visible rather than folklore.
const BUILT_IN = 'Hi, this is your medicine reminder.';
const QUESTION = 'Have you taken your medicine? Say Yes or No, or type 1 for yes and 2 for no.';

function card(message) {
  return `<article class="card message" data-id="${esc(message.id)}">
    <div class="card-head">
      <div>
        <h3 class="card-title">${esc(message.name)}</h3>
        <p class="tag-row">
          ${badge(message.kind === 'AUDIO' ? 'Audio file' : 'Spoken text', 'info')}
          ${message.isDefault ? badge('Default', 'ok') : ''}
        </p>
      </div>
      <div class="card-actions"><button class="small" data-act="edit">Edit</button></div>
    </div>
    <p class="message-body">
      ${message.kind === 'AUDIO'
        ? esc(message.audioUrl || '(no file)')
        : `“${esc(message.ttsText || '(no text)')}”`}
    </p>
  </article>`;
}

function form(message) {
  const m = message || { name: '', kind: 'TTS', ttsText: '', audioUrl: '', voice: '', language: '', isDefault: false };

  return `<form id="message-form" class="panel" novalidate>
    <h2 class="panel-title">${message ? 'Edit message' : 'New message'}</h2>
    <p class="sub" style="margin-bottom:1.5rem">Wording any schedule can point at.</p>

    <div class="form-grid">
      <div class="field"><label for="m-name">Name <span class="hint">— for your reference, never spoken</span></label>
        <input id="m-name" name="name" type="text" value="${esc(m.name)}" required></div>

      <div class="field"><label for="m-kind">Type</label>
        <select id="m-kind" name="kind">
          <option value="TTS"   ${m.kind === 'TTS'   ? 'selected' : ''}>Spoken text</option>
          <option value="AUDIO" ${m.kind === 'AUDIO' ? 'selected' : ''}>Audio file</option>
        </select></div>
    </div>

    <div id="tts-fields" class="${m.kind === 'AUDIO' ? 'hidden' : ''}">
      <div class="field"><label for="m-text">What to say</label>
        <textarea id="m-text" name="ttsText" placeholder="${esc(BUILT_IN)}">${esc(m.ttsText || '')}</textarea></div>
      <div class="field"><label for="m-voice">Voice <span class="hint">— optional Twilio voice name; blank uses the default</span></label>
        <input id="m-voice" name="voice" type="text" value="${esc(m.voice || '')}" placeholder="Polly.Joanna"></div>
      <div class="field"><label for="m-lang">Language <span class="hint">— optional, e.g. en-US</span></label>
        <input id="m-lang" name="language" type="text" value="${esc(m.language || '')}" placeholder="en-US"></div>
    </div>

    <div id="audio-fields" class="${m.kind === 'AUDIO' ? '' : 'hidden'}">
      <div class="field"><label for="m-url">Audio file URL <span class="hint">— must be https; Twilio fetches it during the call</span></label>
        <input id="m-url" name="audioUrl" type="url" value="${esc(m.audioUrl || '')}" placeholder="https://example.com/reminder.mp3"></div>
    </div>

    <div class="checkline">
      <input id="m-default" name="isDefault" type="checkbox" ${m.isDefault ? 'checked' : ''}>
      <label for="m-default">Use as the default message</label>
    </div>

    <p class="small muted">
      The question is always asked by the app after your message, so a Gather still makes sense
      whatever you write here: “${esc(QUESTION)}”
    </p>

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
        <p class="sub">What the call says. A schedule with no message uses the built-in wording.</p>
      </div>
      <div class="button-row"><button class="primary" data-act="new">New message</button></div>
    </div>

    <div id="library">
    <article class="card message is-builtin">
      <div class="card-head">
        <div>
          <h2 class="card-title">Built-in default</h2>
          <p class="tag-row">${badge('Always available', 'off')}</p>
        </div>
      </div>
      <p class="message-body">“${esc(BUILT_IN)}”</p>
    </article>

    <h2>Your messages</h2>
    <div id="list" class="card-grid">
      ${messages.length ? messages.map(card).join('') : '<p class="empty">No custom messages yet.</p>'}
    </div>
    </div>
    <div id="editor"></div>
  `);

  // Only one of the two field groups applies at a time; showing both invites a
  // TTS message with an audio URL that will never play.
  const style = document.createElement('style');
  style.textContent = '.hidden { display: none; }';
  el.appendChild(style);

  // The whole library hides while the editor is open — the built-in card and
  // the heading included, or the form appears to belong to them.
  const library = el.querySelector('#library');
  const editor  = el.querySelector('#editor');
  const newBtn  = el.querySelector('[data-act="new"]');

  function closeEditor() {
    editor.innerHTML = '';
    library.style.display = '';
    newBtn.style.display = '';
  }

  function openEditor(message) {
    library.style.display = 'none';
    newBtn.style.display = 'none';
    editor.innerHTML = form(message);

    const formEl = editor.querySelector('#message-form');
    const kind   = formEl.querySelector('#m-kind');

    const syncKind = () => {
      formEl.querySelector('#tts-fields').classList.toggle('hidden', kind.value === 'AUDIO');
      formEl.querySelector('#audio-fields').classList.toggle('hidden', kind.value !== 'AUDIO');
    };
    kind.addEventListener('change', syncKind);

    formEl.querySelector('[data-act="cancel"]').addEventListener('click', closeEditor);

    formEl.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      if (!confirmAction(`Delete "${message.name}"? Schedules using it fall back to the built-in wording.`)) return;
      try {
        const result = await api.messages.remove(message.id);
        toast(result?.schedulesReset?.length
          ? `Deleted — ${result.schedulesReset.length} schedule(s) reverted to the default wording`
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

  newBtn.addEventListener('click', () => openEditor(null));

  for (const article of el.querySelectorAll('.card[data-id]')) {
    const message = messages.find((m) => m.id === article.dataset.id);
    article.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(message));
  }

  return el;
}

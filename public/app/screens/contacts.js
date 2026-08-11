// Contacts — the people who can be called.
//
// Every number on this screen has passed a verification code, because that is
// the only way one gets here. The badge is therefore not a warning so much as a
// receipt — and the interesting state is the one below it: a number waiting on
// its code, which is visible and cancellable and is NOT being called.

import { api } from '../api.js';
import {
  node, esc, badge, toast, confirmAction, readForm,
  showFieldErrors, clearFieldErrors,
} from '../ui.js';
import { refresh } from '../app.js';
import { channelField, mountCodeStep } from './verify.js';

const ROLE_LABEL = { RECIPIENT: 'Recipient', CAREGIVER: 'Caregiver', BOTH: 'Both' };

const WARN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm.9 7.6 2.4 1.4a.9.9 0 1 1-.9 1.6L7.6 9a.9.9 0 0 1-.5-.8V4a.9.9 0 1 1 1.8 0v3.6Z"/></svg>';

// Deliberately silent when everything is fine.
//
// A contact only exists here because a code came back, so a "Verified" badge on
// every card would be a label that is always true — decoration that costs a line
// of vertical space on every row and tells you nothing you could act on.
//
// What IS worth interrupting someone for is the state that should not be
// possible: a contact whose number nobody ever proved. That cannot be reached
// through the app, but a restored backup or a row typed into Prisma Studio can
// produce it, and it is exactly the case where the interface going quiet would
// be a lie. Icon, word and colour together, so it survives greyscale.
function verificationWarning(contact) {
  if (contact.phoneVerifiedAt) return '';
  return `<span class="badge badge-bad">${WARN_ICON}Unverified</span>`;
}

function card(contact) {
  return `<article class="card contact ${contact.isActive ? '' : 'is-off'}" data-id="${esc(contact.id)}">
    <div class="card-head">
      <div>
        <h2 class="card-title">${esc(contact.name)}</h2>
        <p class="contact-phone">${esc(contact.phone)}</p>
      </div>
      <div class="card-actions"><button class="small" data-act="edit">Edit</button></div>
    </div>
    <p class="tag-row">
      ${verificationWarning(contact)}
      ${badge(ROLE_LABEL[contact.role] || contact.role, 'info')}
      ${contact.isActive ? '' : badge('Inactive', 'off')}
    </p>
    ${contact.pendingPhone ? pendingNotice(contact) : ''}
    ${contact.notes ? `<p class="small muted contact-notes">${esc(contact.notes)}</p>` : ''}
  </article>`;
}

// A number change part-way through. Says explicitly that the old number is still
// the one being called — otherwise "pending" reads as though something is
// currently broken, when in fact nothing has changed yet and nothing will until
// a code comes back.
function pendingNotice(contact) {
  return `<div class="pending-note">
    <p class="small">
      <strong>${esc(contact.pendingPhone)}</strong> is waiting to be verified.
      Calls still go to ${esc(contact.phone)} until it is.
    </p>
    <div class="button-row">
      <button class="small primary" data-act="resume-verify">Enter code</button>
      <button class="small" data-act="cancel-pending">Cancel change</button>
    </div>
  </div>`;
}

// ─── Forms ───────────────────────────────────────────────────────────────────

// Adding a contact: the details AND the number AND how the code should arrive,
// all at once. The contact is not created by this form — it is created when the
// code checks out — so everything it needs has to be collected before the code
// goes out.
// `draft` is what was typed last time, so backing out of the code step returns
// to a filled-in form rather than a blank one. Losing four fields because a text
// did not arrive is a small insult that is entirely avoidable.
function newContactForm(draft = {}) {
  const d = { name: '', phone: '', role: 'RECIPIENT', notes: '', channel: 'SMS', ...draft };

  return `<form id="contact-form" class="panel" novalidate>
    <h2 class="panel-title">New contact</h2>
    <p class="sub" style="margin-bottom:1.5rem">
      We will send a code to this number and add the contact once it comes back,
      so a mistyped number can never be called.
    </p>

    <div class="form-grid">
      <div class="field"><label for="c-name">Name</label>
        <input id="c-name" name="name" type="text" value="${esc(d.name)}" required></div>

      <div class="field">
        <label for="c-phone">Phone <span class="hint">— E.164: a plus, country code, then the number</span></label>
        <input id="c-phone" name="phone" type="text" value="${esc(d.phone)}"
               placeholder="+15125550123" inputmode="tel" required>
      </div>

      <div class="field span-2"><label for="c-role">Role <span class="hint">— a label for grouping; the schedule decides who is actually called</span></label>
        <select id="c-role" name="role">
          ${Object.entries(ROLE_LABEL).map(([value, label]) =>
            `<option value="${value}" ${d.role === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select></div>

      <div class="field span-2"><label for="c-notes">Notes <span class="hint">— optional</span></label>
        <textarea id="c-notes" name="notes">${esc(d.notes || '')}</textarea></div>

      ${channelField(d.channel)}
    </div>

    <div class="button-row">
      <button type="submit" class="primary">Send code</button>
      <button type="button" data-act="cancel">Cancel</button>
    </div>
  </form>`;
}

// Editing: everything except the number.
//
// The phone is shown read-only behind its own button rather than being a
// disabled input nobody can explain. Changing it is a different operation with a
// different outcome — it starts a verification, it does not save a field — and
// putting it on the same Save button would misrepresent what pressing it does.
function editContactForm(contact) {
  return `<form id="contact-form" class="panel" novalidate>
    <h2 class="panel-title">Edit contact</h2>

    <div class="form-grid">
      <div class="field"><label for="c-name">Name</label>
        <input id="c-name" name="name" type="text" value="${esc(contact.name)}" required></div>

      <div class="field">
        <label for="c-phone-display">Phone</label>
        <div class="locked-field">
          <span id="c-phone-display" class="locked-value">${esc(contact.phone)}</span>
          ${verificationWarning(contact)}
        </div>
        <p class="small muted">
          ${contact.pendingPhone
            ? `A change to ${esc(contact.pendingPhone)} is waiting on its code.`
            : 'Changing this sends a code to the new number. Calls keep going to the current one until it is verified.'}
        </p>
        <div class="button-row" style="margin-top:.625rem">
          <button type="button" class="small" data-act="change-phone">Change number</button>
        </div>
      </div>

      <div class="field span-2"><label for="c-role">Role <span class="hint">— a label for grouping; the schedule decides who is actually called</span></label>
        <select id="c-role" name="role">
          ${Object.entries(ROLE_LABEL).map(([value, label]) =>
            `<option value="${value}" ${contact.role === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select></div>

      <div class="field span-2"><label for="c-notes">Notes <span class="hint">— optional</span></label>
        <textarea id="c-notes" name="notes">${esc(contact.notes || '')}</textarea></div>
    </div>

    <div class="checkline">
      <input id="c-active" name="isActive" type="checkbox" ${contact.isActive ? 'checked' : ''}>
      <label for="c-active">Active</label>
    </div>

    <div class="button-row">
      <button type="submit" class="primary">Save changes</button>
      <button type="button" data-act="cancel">Cancel</button>
      <span class="spacer"></span>
      <button type="button" class="danger" data-act="delete">Delete</button>
    </div>
  </form>`;
}

function changeNumberForm(contact, draft = {}) {
  const d = { phone: '', channel: 'SMS', ...draft };

  return `<form id="change-form" class="panel" novalidate>
    <h2 class="panel-title">Change ${esc(contact.name)}'s number</h2>
    <p class="sub" style="margin-bottom:1.5rem">
      Calls and alerts keep going to <strong>${esc(contact.phone)}</strong> until the new
      number is verified. Nothing stops working while this is in progress.
    </p>

    <div class="form-grid">
      <div class="field span-2">
        <label for="c-newphone">New phone <span class="hint">— E.164, e.g. +15125550123</span></label>
        <input id="c-newphone" name="phone" type="text" value="${esc(d.phone)}"
               placeholder="+15125550123" inputmode="tel" required autofocus>
      </div>
      ${channelField(d.channel)}
    </div>

    <div class="button-row">
      <button type="submit" class="primary">Send code</button>
      <button type="button" data-act="cancel">Cancel</button>
    </div>
  </form>`;
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export async function renderContacts() {
  const { contacts } = await api.contacts.list();

  const el = node(`
    <div class="page-head">
      <div>
        <h1>Contacts</h1>
        <p class="sub">Who can be called — the person being reminded, and whoever gets alerted.</p>
      </div>
      <div class="button-row"><button class="primary" data-act="new">New contact</button></div>
    </div>
    <div id="list" class="card-grid">
      ${contacts.length ? contacts.map(card).join('') : '<p class="empty">No contacts yet.</p>'}
    </div>
    <div id="editor"></div>
  `);

  const list   = el.querySelector('#list');
  const editor = el.querySelector('#editor');
  const newBtn = el.querySelector('[data-act="new"]');

  function closeEditor() {
    editor.replaceChildren();
    list.style.display = '';
    newBtn.style.display = '';
  }

  function openEditor(html) {
    list.style.display = 'none';
    newBtn.style.display = 'none';
    editor.innerHTML = html;
    return editor.firstElementChild;
  }

  // Shared landing for both flows: the number is live, say so and redraw.
  function verified(contact) {
    toast(`${contact.name}'s number is verified`);
    return refresh();
  }

  // ── Adding a contact ──

  function openNew(draft) {
    const form = openEditor(newContactForm(draft));
    form.querySelector('[data-act="cancel"]').addEventListener('click', closeEditor);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(form);

      const data   = readForm(form, { nullable: ['notes'] });
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;

      try {
        const { verification } = await api.contacts.startVerification(data);

        mountCodeStep(editor, {
          verification,
          resend:     () => api.contacts.startVerification(data),
          onVerified: verified,
          // Back to the form as it was typed, not a blank one.
          onCancel:   () => openNew(data),
        });
      } catch (err) {
        submit.disabled = false;
        if (!showFieldErrors(form, err.details)) toast(err.message, 'bad');
        else toast('Check the highlighted fields', 'bad');
      }
    });
  }

  // ── Changing a number ──

  function openChangeNumber(contact, draft) {
    const form = openEditor(changeNumberForm(contact, draft));
    form.querySelector('[data-act="cancel"]').addEventListener('click', () => openEdit(contact));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(form);

      const data   = readForm(form);
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;

      try {
        const { verification } = await api.contacts.startNumberChange(contact.id, data);
        mountCodeStep(editor, {
          verification,
          resend:     () => api.contacts.startNumberChange(contact.id, data),
          onVerified: verified,
          onCancel:   () => openChangeNumber(contact, data),
        });
      } catch (err) {
        submit.disabled = false;
        if (!showFieldErrors(form, err.details)) toast(err.message, 'bad');
        else toast('Check the highlighted fields', 'bad');
      }
    });
  }

  // ── Editing everything else ──

  function openEdit(contact) {
    const form = openEditor(editContactForm(contact));

    form.querySelector('[data-act="cancel"]').addEventListener('click', closeEditor);
    form.querySelector('[data-act="change-phone"]')
      .addEventListener('click', () => openChangeNumber(contact));

    form.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirmAction(`Delete ${contact.name}?`)) return;
      try {
        await api.contacts.remove(contact.id);
        toast('Contact deleted');
        await refresh();
      } catch (err) {
        // The API refuses when a schedule still points here, and says which —
        // far more use than "could not delete".
        const blocking = err.details?.schedules;
        if (blocking?.length) {
          toast(`Still used by: ${blocking.map((s) => s.name).join(', ')}`, 'bad');
        } else {
          toast(err.message, 'bad');
        }
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(form);

      // phone is deliberately absent — it is not an input on this form, and the
      // API rejects it outright if it ever appears.
      const data   = readForm(form, { nullable: ['notes'] });
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;

      try {
        await api.contacts.update(contact.id, data);
        toast('Contact saved');
        await refresh();
      } catch (err) {
        submit.disabled = false;
        if (!showFieldErrors(form, err.details)) toast(err.message, 'bad');
        else toast('Check the highlighted fields', 'bad');
      }
    });
  }

  // ── Wiring ──

  // Wrapped, not passed directly: addEventListener would hand openNew the click
  // Event as its draft, and the form would try to render a MouseEvent's fields.
  newBtn.addEventListener('click', () => openNew());

  for (const article of el.querySelectorAll('.card[data-id]')) {
    const contact = contacts.find((c) => c.id === article.dataset.id);

    article.querySelector('[data-act="edit"]')
      .addEventListener('click', () => openEdit(contact));

    // A change already in flight: pick the code entry back up without starting
    // over. Resending is the only way to get a fresh code from here, since the
    // original was issued against a form that is no longer on screen.
    article.querySelector('[data-act="resume-verify"]')?.addEventListener('click', async () => {
      try {
        const { verification } = await api.contacts.startNumberChange(contact.id, {
          phone: contact.pendingPhone, channel: 'SMS',
        });
        list.style.display = 'none';
        newBtn.style.display = 'none';
        mountCodeStep(editor, {
          verification,
          resend: () => api.contacts.startNumberChange(contact.id, {
            phone: contact.pendingPhone, channel: 'SMS',
          }),
          onVerified: verified,
          onCancel:   closeEditor,
        });
      } catch (err) {
        toast(err.message, 'bad');
      }
    });

    article.querySelector('[data-act="cancel-pending"]')?.addEventListener('click', async () => {
      if (!confirmAction(`Cancel the change to ${contact.pendingPhone}? ${contact.name} keeps ${contact.phone}.`)) return;
      try {
        await api.contacts.cancelPending(contact.id);
        toast('Number change cancelled');
        await refresh();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
  }

  return el;
}

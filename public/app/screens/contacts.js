// Contacts — the people who can be called.

import { api } from '../api.js';
import {
  node, esc, badge, toast, confirmAction, readForm,
  showFieldErrors, clearFieldErrors,
} from '../ui.js';
import { refresh } from '../app.js';

const ROLE_LABEL = { RECIPIENT: 'Recipient', CAREGIVER: 'Caregiver', BOTH: 'Both' };

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
      ${badge(ROLE_LABEL[contact.role] || contact.role, 'info')}
      ${contact.isActive ? '' : badge('Inactive', 'off')}
    </p>
    ${contact.notes ? `<p class="small muted contact-notes">${esc(contact.notes)}</p>` : ''}
  </article>`;
}

function form(contact) {
  const c = contact || { name: '', phone: '', role: 'RECIPIENT', notes: '', isActive: true };

  return `<form id="contact-form" class="panel" novalidate>
    <h2 class="panel-title">${contact ? 'Edit contact' : 'New contact'}</h2>
    <p class="sub" style="margin-bottom:1.5rem">A schedule can only call someone who is listed here.</p>

    <div class="form-grid">
      <div class="field"><label for="c-name">Name</label>
        <input id="c-name" name="name" type="text" value="${esc(c.name)}" required></div>

      <div class="field">
        <label for="c-phone">Phone <span class="hint">— E.164: a plus, country code, then the number</span></label>
        <input id="c-phone" name="phone" type="text" value="${esc(c.phone)}"
               placeholder="+15125550123" inputmode="tel" required>
      </div>

      <div class="field span-2"><label for="c-role">Role <span class="hint">— a label for grouping; the schedule decides who is actually called</span></label>
        <select id="c-role" name="role">
          ${Object.entries(ROLE_LABEL).map(([value, label]) =>
            `<option value="${value}" ${c.role === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select></div>

      <div class="field span-2"><label for="c-notes">Notes <span class="hint">— optional</span></label>
        <textarea id="c-notes" name="notes">${esc(c.notes || '')}</textarea></div>
    </div>

    <div class="checkline">
      <input id="c-active" name="isActive" type="checkbox" ${c.isActive ? 'checked' : ''}>
      <label for="c-active">Active</label>
    </div>

    <div class="button-row">
      <button type="submit" class="primary">${contact ? 'Save changes' : 'Create contact'}</button>
      <button type="button" data-act="cancel">Cancel</button>
      <span class="spacer"></span>
      ${contact ? '<button type="button" class="danger" data-act="delete">Delete</button>' : ''}
    </div>
  </form>`;
}

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
    editor.innerHTML = '';
    list.style.display = '';
    newBtn.style.display = '';
  }

  function openEditor(contact) {
    list.style.display = 'none';
    newBtn.style.display = 'none';
    editor.innerHTML = form(contact);

    const formEl = editor.querySelector('#contact-form');
    formEl.querySelector('[data-act="cancel"]').addEventListener('click', closeEditor);

    formEl.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
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

    formEl.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(formEl);

      const data = readForm(formEl, { nullable: ['notes'] });
      const submit = formEl.querySelector('[type="submit"]');
      submit.disabled = true;

      try {
        if (contact) await api.contacts.update(contact.id, data);
        else         await api.contacts.create(data);
        toast(contact ? 'Contact saved' : 'Contact created');
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
    const contact = contacts.find((c) => c.id === article.dataset.id);
    article.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(contact));
  }

  return el;
}

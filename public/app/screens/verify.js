// The code-entry step, shared by both ways a number gets verified.
//
// Its own module rather than more markup inside contacts.js: adding a contact
// and changing an existing contact's number are different journeys that meet at
// exactly this screen, and it carries its own timer, its own cooldown and its
// own error handling. Folded into contacts.js it would be the larger half of a
// file that is supposed to be about contacts.

import { api } from '../api.js';
import { node, esc, toast, showFieldErrors, clearFieldErrors } from '../ui.js';

const CHANNEL_LABEL = { SMS: 'texted', CALL: 'called' };

// The two ways a code can arrive, as a real radio group.
//
// Not a select: there are two options, both matter, and the difference between
// them is the difference between a number that can be verified and one that
// cannot. The reason CALL exists is spelled out rather than left as a bare
// label, because "why would I pick that" has a real answer here.
export function channelField(selected = 'SMS') {
  return `<fieldset class="field span-2 channel-choice">
    <legend>How should the code arrive?</legend>
    <label class="checkline">
      <input type="radio" name="channel" value="SMS" ${selected === 'SMS' ? 'checked' : ''}>
      <span>Text message <span class="hint">— fastest, if the number can receive texts</span></span>
    </label>
    <label class="checkline">
      <input type="radio" name="channel" value="CALL" ${selected === 'CALL' ? 'checked' : ''}>
      <span>Phone call <span class="hint">— the code is read aloud, twice. Use this for a landline, or for someone who does not read texts</span></span>
    </label>
  </fieldset>`;
}

function stepMarkup(verification) {
  const how = CHANNEL_LABEL[verification.channel] || 'sent';

  return `<form id="code-form" class="panel" novalidate>
    <h2 class="panel-title">Enter the code</h2>
    <p class="sub" style="margin-bottom:1.5rem">
      We ${esc(how)} a 6-digit code to <strong>${esc(verification.phone)}</strong>.
      ${verification.channel === 'CALL' ? 'It is read aloud twice — answer and write it down.' : ''}
    </p>

    <div class="field code-field">
      <label for="v-code">Code</label>
      <input id="v-code" name="code" class="code-input" type="text"
             inputmode="numeric" autocomplete="one-time-code"
             maxlength="7" placeholder="000000" required autofocus>
      <p class="small muted" id="countdown" aria-live="polite"></p>
    </div>

    <div class="button-row">
      <button type="submit" class="primary">Verify number</button>
      <button type="button" data-act="resend">Resend code</button>
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
    </div>
  </form>`;
}

// mm:ss until the code expires, or a plain statement once it has.
function remainingText(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'This code has expired — request a new one.';

  const total   = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `Expires in ${minutes}:${seconds}.`;
}

// Renders the code step into `host` and drives it to completion.
//
//   verification  what the server returned when the code was sent
//   resend        () => Promise<verification> — re-issues a code for the same
//                 number, through whichever endpoint started this
//   onVerified    (contact) => void — the number is now live
//   onCancel      () => void — back out; the contact's real number is untouched
export function mountCodeStep(host, { verification, resend, onVerified, onCancel }) {
  let current = verification;

  host.replaceChildren(node(stepMarkup(current)).firstElementChild);

  const form      = host.querySelector('#code-form');
  const input     = form.querySelector('#v-code');
  const countdown = form.querySelector('#countdown');
  const submit    = form.querySelector('[type="submit"]');
  const resendBtn = form.querySelector('[data-act="resend"]');

  // ── The clock ──
  //
  // Guarded on isConnected rather than cleaned up by a lifecycle hook: the shell
  // swaps whole screens with replaceChildren, so this element can be discarded
  // without anything telling us. Checking whether we are still on the page is
  // the only teardown signal that is actually reliable here.
  const tick = () => {
    if (!host.isConnected) { clearInterval(timer); return; }
    countdown.textContent = remainingText(current.expiresAt);
  };
  const timer = setInterval(tick, 1000);
  tick();

  // ── Resend, with the server's cooldown mirrored locally ──
  //
  // The server is the authority and returns 429 with a Retry-After; this only
  // stops the button being pressed into that error. A disabled button says
  // "not yet" better than a red toast does.
  let cooldownTimer = null;

  function startCooldown(seconds) {
    let left = seconds;
    resendBtn.disabled = true;

    const render = () => {
      if (!host.isConnected) { clearInterval(cooldownTimer); return; }
      if (left <= 0) {
        clearInterval(cooldownTimer);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend code';
        return;
      }
      resendBtn.textContent = `Resend in ${left}s`;
      left -= 1;
    };

    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(render, 1000);
    render();
  }

  startCooldown(60);

  resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    try {
      current = (await resend()).verification;
      clearFieldErrors(form);
      input.value = '';
      input.focus();
      tick();
      startCooldown(60);
      toast('A new code is on its way');
    } catch (err) {
      resendBtn.disabled = false;
      toast(err.message, 'bad');
    }
  });

  form.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    clearInterval(timer);
    clearInterval(cooldownTimer);
    onCancel();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);

    const code = input.value.trim();
    submit.disabled = true;

    try {
      const { contact } = await api.contacts.checkCode(current.id, code);
      clearInterval(timer);
      clearInterval(cooldownTimer);
      onVerified(contact);
    } catch (err) {
      submit.disabled = false;
      // A wrong code comes back with how many attempts are left, which belongs
      // on the input rather than in a toast that vanishes after six seconds.
      if (!showFieldErrors(form, err.details)) toast(err.message, 'bad');
      else toast(err.message, 'bad');
      input.select();
    }
  });
}

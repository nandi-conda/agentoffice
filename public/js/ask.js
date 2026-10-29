// "Are you sure?" without window.confirm(): some browsers (in-app web
// views, embedded panes) block or auto-dismiss native dialogs, and a blocked
// confirm() returns false, so the button silently did nothing. This asks
// inline, right after the thing that was clicked: the question, a button
// that does it, and Keep. Resolves true or false; asking again while a
// question is up answers the old one with false.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function ask(after, question, yes = 'Yes') {
  after.parentElement?.querySelector(':scope > .ask')?.querySelector('.ask-no')?.click();
  return new Promise((resolve) => {
    const box = document.createElement('span');
    box.className = 'ask';
    box.innerHTML = `<span class="small">${esc(question)}</span> <button type="button" class="btn danger ask-yes">${esc(yes)}</button> <button type="button" class="btn ghost ask-no">Keep</button>`;
    const done = (v) => { box.remove(); resolve(v); };
    box.querySelector('.ask-yes').addEventListener('click', (e) => { e.stopPropagation(); done(true); });
    box.querySelector('.ask-no').addEventListener('click', (e) => { e.stopPropagation(); done(false); });
    after.insertAdjacentElement('afterend', box);
    box.querySelector('.ask-yes').focus();
  });
}

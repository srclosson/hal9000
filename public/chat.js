// How an answer reads on any screen: escaped text, light markdown, and steps cards with copy buttons. Shared by every
// UI (monitor.html, dashboard.html) so a reply can never become HTML of its own on one of them and not the other.

export const escapeHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Light markdown for a written answer (format 'markdown'): paragraphs, lists, **bold**, `code` and code blocks.
// Everything is escaped first, so nothing in a reply can become HTML of its own.
export const mdInline = t => escapeHtml(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
function mdBlocks(t) {
  return t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => {
    const lines = p.split('\n'), item = /^\s*(?:[-*•]|(\d+)[.)])\s+/;
    if (lines.every(l => item.test(l))) {
      const ordered = /^\s*\d/.test(lines[0]);
      return `<${ordered ? 'ol' : 'ul'}>${lines.map(l => `<li>${mdInline(l.replace(item, ''))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
    }
    return `<p>${lines.map(mdInline).join('<br>')}</p>`;
  }).join('');
}
export function mdHtml(text) {
  return String(text ?? '').split(/```[\w-]*\n?([\s\S]*?)(?:```|$)/).map((b, i) => (i % 2 ? `<pre><code>${escapeHtml(b.replace(/\n$/, ''))}</code></pre>` : mdBlocks(b))).join('');
}
// A steps card (show_steps): each step with its kind, what it does, the command with a copy button, and what to expect.
export function cardHtml(c) {
  return `<div class="card" data-card="${escapeHtml(c.id)}"><div class="ctitle">${escapeHtml(c.title)}</div><ol>${c.steps.map((s, i) =>
    `<li class="k-${escapeHtml(s.kind)}"><span class="kind">${escapeHtml(s.kind)}</span> ${mdInline(s.text)}` +
    (s.command ? `<div class="cmd"><pre><code>${escapeHtml(s.command)}</code></pre><button type="button" data-copy="${i}">Copy</button></div>` : '') +
    (s.expect ? `<div class="expect">Expect: ${mdInline(s.expect)}</div>` : '') + '</li>').join('')}</ol>` +
    '<button class="chip" type="button" data-save>Save as runbook in Know-how ▸</button></div>';
}
export async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); }
  catch {   // no clipboard API (an insecure origin): select it instead
    const r = document.createRange(); r.selectNodeContents(button.previousElementSibling); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('copy');
  }
  button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1500);
}

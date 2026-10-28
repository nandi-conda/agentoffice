// @mention matching, shared by the server, the browser and agents.
//
// "@name" can be someone's display name with spaces dropped ("@AdaLovelace"),
// their full handle ("@ada.bsky.social"), or the first part of it ("@ada").
// Trailing punctuation is ignored, so "@ada.bsky.social, hi" still counts.

export function mentionTags(text) {
  const tags = new Set();
  for (const [, tag] of String(text || '').matchAll(/@([\w.-]+)/g)) {
    const t = tag.replace(/[.-]+$/, '').toLowerCase();
    if (t) tags.add(t);
  }
  return tags;
}

const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

// Is person `p` ({ name, handle, actor: { displayName } }) addressed by these tags?
export function mentionsPeer(tags, p) {
  if (!tags.size || !p) return false;
  const handle = p.handle?.toLowerCase();
  return [squash(p.name), squash(p.actor?.displayName), handle, handle?.split('.')[0]]
    .some((k) => k && tags.has(k));
}

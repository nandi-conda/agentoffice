// Every time the office shows a person goes through here: 12-hour clock, in
// the viewer's own time zone. Shared with the server and agents, so it stays
// free of DOM and Node APIs.
//
// The server never formats a time into text (it would use its own zone).
// It writes a stamp, `<t:EPOCH_MS>`, and the browser swaps it for the local
// time with localize(); agents get ISO 8601 from isoize().

let timeFmt, hourFmt;
const fmt = () => (timeFmt ||= new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', hour12: true }));
const hourOnly = () => (hourFmt ||= new Intl.DateTimeFormat([], { hour: 'numeric', hour12: true }));

// "9:05 AM"
export const fmtTime = (t) => fmt().format(new Date(t));
// "9:05 AM–9:45 AM"
export const fmtRange = (b) => `${fmtTime(b.start)}–${fmtTime(b.end)}`;
// "7 AM", for axis labels
export const fmtHour = (t) => hourOnly().format(new Date(t));
// A local "HH:MM" (24h, as forms carry it) shown as "9:05 AM"
export const fmtClock = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(2000, 0, 1, h, m); return fmtTime(d); };

export const stamp = (t) => `<t:${Math.round(t)}>`;
export const stampRange = (b) => `${stamp(b.start)}–${stamp(b.end)}`;

const STAMP = /<t:(-?\d+)>/g;
export const localize = (text) => String(text ?? '').replace(STAMP, (_, t) => fmtTime(+t));
export const isoize = (text) => String(text ?? '').replace(STAMP, (_, t) => new Date(+t).toISOString());

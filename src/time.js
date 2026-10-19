// Showtime helpers. CKS is in the Philippines, so times are read as Manila time (UTC+8).
function tMins(t) {
  const m = String(t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return 0;
  let h = +m[1];
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + +(m[2] || 0);
}
function showStartMs(date, time) {
  const mins = tMins(time);
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  const t = Date.parse(`${date}T${hh}:${mm}:00+08:00`);
  return Number.isNaN(t) ? 0 : t;
}
// Reservations close when the film starts.
function hasStarted(date, time, now = Date.now()) {
  const t = showStartMs(date, time);
  return t > 0 && t <= now;
}
function manilaDate(offsetDays = 0, now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);
}
module.exports = { tMins, showStartMs, hasStarted, manilaDate };
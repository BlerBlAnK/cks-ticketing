// Helpers for tickets: confirmation codes, links, calendar entries.
const { cached } = require('./site');
const location = () => cached().location;
const TZ_OFFSET_HOURS = 8; // Philippines (Asia/Manila), no daylight saving

function ticketCode(r) {
  return 'CKS-' + String(r.id).slice(2).toUpperCase();
}

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t).trim());
  if (!m) return { h: 12, min: 0 };
  let h = (+m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return { h, min: +m[2] };
}

function startEnd(r) {
  const [Y, M, D] = String(r.date).split('-').map(Number);
  const { h, min } = parseTime(r.time);
  const start = new Date(Date.UTC(Y, M - 1, D, h - TZ_OFFSET_HOURS, min));
  const end = new Date(start.getTime() + (r.movieDuration || 120) * 60000);
  return { start, end };
}

function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escIcs(s) {
  return String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

function icsFor(r) {
  const { start, end } = startEnd(r);
  const seats = [...r.seats].sort().join(', ');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ticketing//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ticketCode(r)}@cks-ticketing`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escIcs('Movie: ' + r.movieTitle)}`,
    `LOCATION:${escIcs(location())}`,
    `DESCRIPTION:${escIcs('Seats ' + seats + '\nCode ' + ticketCode(r) + '\nFree reservation')}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function googleCalUrl(r) {
  const { start, end } = startEnd(r);
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Movie: ' + r.movieTitle,
    dates: `${stamp(start)}/${stamp(end)}`,
    details: `Seats ${[...r.seats].sort().join(', ')}\nCode ${ticketCode(r)}\nFree reservation`,
    location: location(),
  });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

function ticketUrl(appUrl, r) {
  return `${appUrl}/?ticket=${encodeURIComponent(ticketCode(r))}`;
}

// Text inside the QR code: the whole ticket, readable by any scanner app (works offline too).
function qrText(r, appUrl) {
  const d = new Date(r.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const lines = [
    `${ticketCode(r)}`,
    String(r.movieTitle).toUpperCase(),
    `Name: ${r.name}`,
    `Phone: ${r.phone || '-'}`,
    `${d} ${r.time}`,
    `Seats: ${[...r.seats].sort().join(', ')}`,
  ];
  if (appUrl) lines.push(`${appUrl}/?ticket=${ticketCode(r)}`);
  return lines.join('\n');
}

module.exports = { qrText, location, ticketCode, icsFor, googleCalUrl, ticketUrl };
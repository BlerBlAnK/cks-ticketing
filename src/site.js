// Site-wide content the admin can edit from the website (stored in the database).
const { pool } = require('./db');

const DEFAULTS = {
  brandName: 'CKS',
  brandSub: 'Ticketing',
  siteTitle: 'CKS Ticketing',
  introPresents: 'Center for Kapampangan Studies presents',
  accent: '#E8B94D',
  heroEyebrow: 'Now Showing at CKS',
  heroLine1: 'Lights down.',
  heroEmptyTagline: 'One theater, forty-nine seats, no bad seats in the house. Reserve yours online, free of charge, at CKS Ticketing.',
  aboutEyebrow: 'About CKS',
  aboutHeading: 'One room, forty-nine seats,\nrun properly.',
  aboutText:
    "CKS Ticketing is the screening room of the Center for Kapampangan Studies, housed within Holy Angel University's Center for Kapampangan Studies Museum. It's a single, intimate theater built for the kind of programming a big multiplex would never make room for — Kapampangan heritage films, documentaries, student work, and the occasional wide release, all on one screen.\n\n" +
    "Forty-nine seats means every showing feels close, and every seat is a good one — there's no back row here worth avoiding. Reservations are free and seat-numbered, booked online ahead of time so nobody's turned away at the door for a show that quietly sold out.\n\n" +
    "Being part of the Museum means the room doubles as a cultural space as much as a cinema — expect programming that ties back to Kapampangan history and storytelling alongside the regular schedule.",
  stats: [
    { num: '1', lbl: 'Screening Room' },
    { num: '49', lbl: 'Total Seats' },
    { num: '7', lbl: 'Days a Week' },
    { num: '10AM–11PM', lbl: 'Box Office Hours' },
  ],
  seatingText: '49 seats',
  locationName: 'Center for Kapampangan Studies Museum\nHoly Angel University, Angeles City, Pampanga',
  location: 'Center for Kapampangan Studies Museum, Holy Angel University, Angeles City, Pampanga',
  footerTitle: 'CKS TICKETING — CINEMA HOUSE',
  footerLine: 'Angeles City, Pampanga · Box office opens daily 10:00 AM – 11:00 PM',
  bookingNotice: 'No account needed. Your ticket and QR code will be emailed to you. Changes and cancellations are handled by CKS staff.',
  emailNote: 'Free reservation. Show this email or your code at the door.',
  contactEmail: '',
  galleryEyebrow: 'Inside the Theater',
  galleryHeading: 'Take a look inside.',
  privacyNotice: 'I agree that CKS may use my name, email and phone number to manage my reservation and to contact me about it.',
  privacyText:
    "Privacy Notice\n\n" +
    "What we collect: your name, email address and phone number, plus the movie, showing and seats you reserve.\n\n" +
    "Why: only to confirm and manage your reservation, send your ticket and reminders, reach you if a showing changes, and let staff check you in at the door.\n\n" +
    "Who can see it: authorized CKS staff only. Your details are never shown on the public website and are not sold or shared for advertising.\n\n" +
    "How long we keep it: reservation details are deleted automatically after the retention period shown in Site Settings (180 days after the showing by default).\n\n" +
    "Your rights: under the Data Privacy Act of 2012 (RA 10173) you may ask to see, correct or delete your information. Contact CKS using the details on the Contact page.",
  retentionDays: '180',
  bookingOpen: true,
  bookingClosedMessage: 'Reservations are closed right now. Please check back later or contact CKS.',
};

// Photos shown on the About page until staff change them in Site Settings.
const DEFAULT_GALLERY = [
  { id: 'd1', url: '/theater/theater-1.jpg', caption: 'Our screening room: tiered seating, one big screen' },
];

const MAX = {
  brandName: 30, brandSub: 30, siteTitle: 80, introPresents: 90, heroEyebrow: 60, heroLine1: 60,
  heroEmptyTagline: 300, aboutEyebrow: 60, aboutHeading: 120, aboutText: 4000, seatingText: 40,
  galleryEyebrow: 60, galleryHeading: 100, locationName: 200, location: 200, footerTitle: 80, footerLine: 160, bookingNotice: 300, emailNote: 300, contactEmail: 120, bookingClosedMessage: 200, privacyNotice: 300, privacyText: 4000,
};

let cache = null; // { data, at }

function clean(input) {
  const out = {};
  for (const k of Object.keys(MAX)) {
    if (input[k] === undefined) continue;
    const v = String(input[k]).replace(/\r/g, '').trim().slice(0, MAX[k]);
    if (!v && k !== 'contactEmail') continue; // blank = keep default
    out[k] = v;
  }
  if (out.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.contactEmail)) {
    const e = new Error('The contact email is not valid.'); e.status = 400; throw e;
  }
  if (input.retentionDays !== undefined) {
    const n = parseInt(input.retentionDays, 10);
    out.retentionDays = String(Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(3650, Math.max(30, n))) : 180);
  }
  if (input.bookingOpen !== undefined) out.bookingOpen = input.bookingOpen === true || input.bookingOpen === 'true';
  if (input.accent !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(input.accent))) { const e = new Error('Pick a valid accent color.'); e.status = 400; throw e; }
    out.accent = String(input.accent).toUpperCase();
  }
  if (Array.isArray(input.stats)) {
    const s = input.stats.slice(0, 6)
      .map((x) => ({ num: String((x && x.num) || '').trim().slice(0, 14), lbl: String((x && x.lbl) || '').trim().slice(0, 30) }))
      .filter((x) => x.num || x.lbl);
    out.stats = s;
  }
  return out;
}

async function readRow() {
  const { rows } = await pool.query(`SELECT data FROM settings WHERE id = 'site'`);
  return rows[0] ? rows[0].data : {};
}
async function writeRow(data) {
  await pool.query(
    `INSERT INTO settings (id, data) VALUES ('site', $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [JSON.stringify(data)]);
  cache = null;
}

function publicView(row) {
  const { logoData, logoAt, gallery, ...rest } = row;
  const merged = { ...DEFAULTS, ...rest };
  merged.gallery = Array.isArray(gallery) ? gallery : DEFAULT_GALLERY;
  merged.logo = logoData ? `/api/site/logo?v=${logoAt || 1}` : '/logo.png';
  return merged;
}

async function getSite() {
  if (cache && Date.now() - cache.at < 15000) return cache.data;
  let row = {};
  try { row = await readRow(); } catch (e) { console.warn('[site] could not read settings:', e.message); }
  const data = publicView(row);
  cache = { data, at: Date.now() };
  return data;
}
// Last known settings, synchronously (for places that cannot await).
function cached() { return cache ? cache.data : publicView({}); }

module.exports = { DEFAULT_GALLERY, DEFAULTS, clean, readRow, writeRow, getSite, cached, publicView };
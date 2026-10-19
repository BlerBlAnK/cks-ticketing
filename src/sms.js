// Text messages (SMS) to the guest's mobile number. Needs an SMS provider account:
//   SMS_PROVIDER=semaphore  + SEMAPHORE_API_KEY (+ optional SEMAPHORE_SENDER)   (Philippines)
//   SMS_PROVIDER=twilio     + TWILIO_SID, TWILIO_TOKEN, and TWILIO_FROM (or TWILIO_MESSAGING_SID)
// Without these, booking still works and the guest gets email only.
const { getSite } = require('./site');

function provider() { return String(process.env.SMS_PROVIDER || '').trim().toLowerCase(); }

function isConfigured() {
  const p = provider();
  if (p === 'semaphore') return !!process.env.SEMAPHORE_API_KEY;
  if (p === 'twilio') return !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SID));
  return false;
}

function intl(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (/^09\d{9}$/.test(d)) return '+63' + d.slice(1);
  if (/^63\d{10}$/.test(d)) return '+' + d;
  return d;
}

async function post(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// Short, readable reason shown to staff.
function friendly(text) {
  const t = String(text || '');
  if (/apikey|api key|invalid.*key|unauthor/i.test(t)) return 'The SMS API key was rejected. Check SEMAPHORE_API_KEY.';
  if (/sender/i.test(t)) return 'The sender name is not registered or approved. Remove SEMAPHORE_SENDER or register one in Semaphore.';
  if (/credit|balance|insufficient/i.test(t)) return 'Not enough SMS credits. Top up your SMS account.';
  if (/number/i.test(t)) return 'The phone number was not accepted.';
  return t.replace(/\s+/g, ' ').slice(0, 160) || 'The SMS service refused the message.';
}

async function sendSms(to, message) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  if (!to) return { sent: false, reason: 'no_number' };
  if (!/^(\+63|0)9\d{9}$/.test(String(to).replace(/[^\d+]/g, ''))) return { sent: false, reason: 'not_mobile' }; // landlines can't receive texts
  try {
    let r;
    if (provider() === 'semaphore') {
      const body = new URLSearchParams({ apikey: process.env.SEMAPHORE_API_KEY, number: String(to).replace(/^\+63/, '0'), message });
      if (process.env.SEMAPHORE_SENDER) body.set('sendername', process.env.SEMAPHORE_SENDER);
      r = await post(process.env.SEMAPHORE_URL || 'https://api.semaphore.co/api/v4/messages', { method: 'POST', body });
    } else {
      const sid = process.env.TWILIO_SID;
      const body = new URLSearchParams({ To: intl(to), Body: message });
      if (process.env.TWILIO_MESSAGING_SID) body.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SID);
      else body.set('From', process.env.TWILIO_FROM);
      r = await post(process.env.TWILIO_URL || `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST', body,
        headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_TOKEN}`).toString('base64') },
      });
    }
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch (_) { /* not JSON */ }
    // Semaphore can answer 200 with an error object (bad key, no sender name...) instead of a list of messages.
    const looksBad = provider() === 'semaphore' && r.ok && !(Array.isArray(parsed) && parsed.length && parsed.every((m) => m && m.message_id !== undefined && !/fail/i.test(String(m.status || ''))));
    if (!r.ok || looksBad) {
      console.error(`[sms] ${provider()} refused the message (${r.status}):`, r.text.slice(0, 200));
      return { sent: false, reason: 'error', message: friendly(r.text) };
    }
    return { sent: true };
  } catch (e) {
    console.error('[sms] send failed:', e.message);
    return { sent: false, reason: 'error', message: e.name === 'AbortError' ? 'The SMS service did not answer in time.' : e.message };
  }
}

function shortDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function sendBookingSms(r, code) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const S = await getSite();
  const title = String(r.movieTitle).length > 26 ? String(r.movieTitle).slice(0, 25) + '…' : r.movieTitle;
  const seats = [...r.seats].sort().join(' ');
  const text = `${S.brandName}: ${title}, ${shortDate(r.date)} ${r.time}, seat ${seats}. Ticket ${code}. Show this at the entrance. Free.`;
  return sendSms(r.phone, text);
}

module.exports = { isConfigured, sendSms, sendBookingSms };
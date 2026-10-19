const express = require('express');
const { sendMail } = require('../email');
const { getSite } = require('../site');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

router.post('/', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const message = String(req.body.message || '').trim();

  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!message) return res.status(400).json({ error: 'Enter a message.' });
  if (message.length > 4000) return res.status(400).json({ error: 'Message is too long.' });

  const site = await getSite();
  const ownerEmail = (site.contactEmail || process.env.ADMIN_EMAIL || '').trim();
  if (!ownerEmail) {
    console.warn('[contact] ADMIN_EMAIL is not set, so there is nowhere to route contact form messages. Set it in .env.');
    return res.status(503).json({ error: 'The contact form is not fully set up on this server yet.' });
  }

  const result = await sendMail({
    to: ownerEmail,
    subject: `${site.siteTitle} contact form -- ${name}`,
    replyTo: email,
    text: `From: ${name} <${email}>\n\n${message}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <h2 style="color:#111;">New contact form message</h2>
        <p style="color:#444;">From <strong>${escapeHtml(name)}</strong> (${escapeHtml(email)})</p>
        <div style="background:#f6f6f6;border-radius:6px;padding:16px;white-space:pre-wrap;color:#222;">${escapeHtml(message)}</div>
      </div>`,
  });

  if (!result.sent) {
    return res.status(503).json({ error: "Couldn't send your message right now -- email delivery isn't configured on this server yet." });
  }

  res.json({ ok: true });
});

module.exports = router;
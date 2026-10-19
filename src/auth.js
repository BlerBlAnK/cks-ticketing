const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const USER_COOKIE = 'cks_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

function signUserToken(user) {
  return jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function setUserCookie(res, user) {
  res.cookie(USER_COOKIE, signUserToken(user), COOKIE_OPTS);
}
function clearUserCookie(res) {
  res.clearCookie(USER_COOKIE);
}

function attachUser(req, _res, next) {
  const token = req.cookies && req.cookies[USER_COOKIE];
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      req.user = null;
    }
  }
  next();
}

// Admin is not a separate login at all -- it's whoever is logged in with the
// one email address the site owner configured in ADMIN_EMAIL. No passcode,
// no separate button, nothing for a stranger to even find and try.
function attachAdmin(req, _res, next) {
  const ownerEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  req.isAdmin = !!(ownerEmail && req.user && req.user.email && req.user.email.toLowerCase() === ownerEmail);
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Log in required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(401).json({ error: 'Admin access required' });
  next();
}

module.exports = {
  USER_COOKIE,
  setUserCookie,
  clearUserCookie,
  attachUser,
  attachAdmin,
  requireUser,
  requireAdmin,
};
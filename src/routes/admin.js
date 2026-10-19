const express = require('express');

const router = express.Router();

// isAdmin is computed by the attachAdmin middleware in server.js (matches the
// logged-in user's email against ADMIN_EMAIL) -- there's nothing to "log in"
// to here separately. Signing into your regular account with the owner email
// is what makes this true.
router.get('/me', (req, res) => {
  res.json({ isAdmin: !!req.isAdmin });
});

module.exports = router;
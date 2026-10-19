// Express 4 does not catch errors thrown inside async route handlers: an unhandled
// rejection (for example a dropped database connection) can crash the whole server,
// and the browser then shows "Failed to fetch". This wraps every route handler so the
// error goes to the normal error handler and the server stays up.
function wrapRouter(router) {
  router.stack.forEach((layer) => {
    if (!layer.route) return;
    layer.route.stack.forEach((s) => {
      const fn = s.handle;
      if (fn.length >= 4) return;
      s.handle = function (req, res, next) {
        try {
          const out = fn.call(this, req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
        } catch (e) {
          next(e);
        }
      };
    });
  });
  return router;
}
module.exports = { wrapRouter };
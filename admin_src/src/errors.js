class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
const invalid = (details) => new HttpError(422, 'validation_failed', 'One or more fields are invalid.', details);
const unauthorized = (message = 'Authentication required.') => new HttpError(401, 'unauthorized', message);
const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message);
const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found.`);
const conflict = (code, message) => new HttpError(409, code, message);

// Lets route handlers be plain async functions.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Request body is not valid JSON.' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large.' } });
  }
  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Unexpected server error.', request_id: req.id },
  });
}

module.exports = { HttpError, badRequest, invalid, unauthorized, forbidden, notFound, conflict, wrap, errorHandler };

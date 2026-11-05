// Small helpers shared by routes.

// Generate a legacy-style id, e.g. idWith('ORD') -> "ORD-lp3k2a-9f2".
// Keeps the same shape as the old app's uid() so ids stay recognisable.
export function idWith(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

// Wrap an async route handler so thrown errors reach the error middleware.
export function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

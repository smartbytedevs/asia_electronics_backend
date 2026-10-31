'use strict';

const ApiError = require('../utils/ApiError');
const authenticate = require('./authenticate');
const resolveCurrentUser = require('./resolveCurrentUser');

const MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
};

/**
 * Guest identity namespace. Guest identities are provisioned as ordinary
 * CUSTOMER User records whose `authProviderId` is `guest:<uuid>`, so they
 * never collide with Better Auth subjects and the existing unique index
 * prevents duplicate provisioning for the same guest id.
 */
const GUEST_PROVIDER = 'guest';
const GUEST_ID_HEADER = 'x-guest-id';

// Standard UUID format (versions 1-5). The frontend generates a v4 UUID via
// `crypto.randomUUID()`; anything that is not a well-formed UUID is rejected.
const GUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function extractBearerAuthorization(req) {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim().length > 0 ? header : null;
}

function extractGuestId(req) {
  const raw = req.headers[GUEST_ID_HEADER];
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!GUEST_ID_PATTERN.test(id)) return null;
  return id;
}

/**
 * Storefront customer gate: `Authorization: Bearer <token>` OR `X-Guest-Id`.
 *
 * Used ONLY on storefront cart/checkout surfaces where guest checkout is
 * allowed. It composes the existing `authenticate` + `resolveCurrentUser`
 * middleware so the authenticated path behaves exactly as before:
 *
 *   - A Bearer token present (valid or not) → the existing verified flow runs
 *     (invalid/expired → 401 exactly as today; a valid token is resolved
 *     against the application User record as today).
 *   - NO Bearer token → the `X-Guest-Id` header (a UUID) is treated as a
 *     guest authentication identity `{ authProviderId: 'guest:<uuid>' }` and
 *     passed through the SAME user-resolution path, which auto-provisions an
 *     ACTIVE CUSTOMER User on first sight. `req.user` therefore has the exact
 *     shape every customer controller/service expects.
 *   - Neither → 401 UNAUTHORIZED.
 *
 * MUST NEVER be mounted on admin/staff routes — those keep the full
 * `authenticate → resolveCurrentUser → authorizeRoles` chain unchanged.
 */
function resolveStorefrontCustomer({ verifier, userService } = {}) {
  const authenticateMw = authenticate(verifier);
  const resolveUserMw = resolveCurrentUser({ userService });

  return async function resolveStorefrontCustomerMiddleware(req, res, next) {
    if (extractBearerAuthorization(req)) {
      return authenticateMw(req, res, (authErr) => {
        if (authErr) return next(authErr);
        return resolveUserMw(req, res, next);
      });
    }

    const guestId = extractGuestId(req);
    if (!guestId) {
      return next(ApiError.unauthorized(MESSAGES.UNAUTHORIZED));
    }
    req.auth = { authProviderId: `${GUEST_PROVIDER}:${guestId}` };
    return resolveUserMw(req, res, next);
  };
}

module.exports = resolveStorefrontCustomer;
module.exports.GUEST_PROVIDER = GUEST_PROVIDER;
module.exports.GUEST_ID_HEADER = GUEST_ID_HEADER;
module.exports.extractGuestId = extractGuestId;

'use strict';

const { Router } = require('express');
const { ROLES, ERROR_CODES } = require('../../constants');
const { MEDIA_LIMITS, MEDIA_MESSAGES } = require('./media.constants');
const { MediaService } = require('./media.service');
const { createMediaController } = require('./media.controller');
const { createCloudinaryMediaService } = require('../../integrations/media/cloudinary/cloudinary.adapter');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default media service bound to the central Cloudinary config with the
 * catalog upload error contract. Credentials stay server-side; only safe
 * provider references leave the adapter.
 */
const defaultMediaService = createCloudinaryMediaService({
  uploadMessage: MEDIA_MESSAGES.UPLOAD_FAILED,
  uploadErrorCode: ERROR_CODES.MEDIA_UPLOAD_FAILED,
});

const defaultMediaUploadService = new MediaService({ mediaService: defaultMediaService });

/**
 * Catalog media upload router, mounted at /api/v1/admin/media.
 *
 * POST /upload — authenticate → resolveCurrentUser →
 * authorizeRoles(ADMIN, STAFF). STAFF may create products (which carry
 * images), so STAFF may upload catalog assets; CUSTOMER and anonymous are
 * rejected by the middleware chain.
 *
 * The POST route consumes multipart/form-data raw bytes; the `express.raw`
 * limit is above the per-file cap so oversized submissions surface as a clean
 * 400 from the media validator.
 *
 * `mediaService`, `userService`, and `verifier` are injectable for tests;
 * production uses the defaults.
 */
function createMediaRouter({
  mediaService = defaultMediaUploadService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createMediaController({ mediaService });

  router.post(
    '/upload',
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN, ROLES.STAFF),
    require('express').raw({
      type: 'multipart/form-data',
      limit: MEDIA_LIMITS.MULTIPART_BODY_MAX_BYTES,
    }),
    controller.uploadImages
  );

  return router;
}

const defaultRouter = createMediaRouter();

module.exports = { createMediaRouter, defaultRouter };

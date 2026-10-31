'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { normalizePagination } = require('../../utils/pagination');
const { assertObjectId } = require('./user.validation');
const { serializeAdminUser } = require('./user.serializer');
const { USER_MESSAGES, DEFAULT_USER_ROLE, DEFAULT_USER_STATUS } = require('./user.constants');

/**
 * Application-level user logic.
 *
 * Owns business rules: identity resolution, customer provisioning, and the
 * safe API representation of a user. It NEVER handles credentials — the
 * backend stores no passwords, sessions, or authentication secrets.
 */
class UserService {
  constructor({ repository, autoProvisionCustomers = true }) {
    this.repository = repository;
    this.autoProvisionCustomers = autoProvisionCustomers;
  }

  async findById(id) {
    const user = await this.repository.findById(id);
    return user ? this.toApplicationIdentity(user) : null;
  }

  /**
   * Resolves the application user for a verified authentication identity.
   *
   *   JWT → req.auth → find by authProviderId
   *     · existing user  → return its application identity
   *     · missing user   → provision a CUSTOMER if auto-provisioning is
   *       allowed; otherwise a controlled application-level error.
   *
   * Auto-provisioning NEVER creates ADMIN/STAFF accounts from JWT claims.
   */
  async resolveAuthenticatedUser(authIdentity) {
    const user = await this.repository.findByAuthProviderId(
      authIdentity.authProviderId
    );
    if (user) {
      return this.toApplicationIdentity(user);
    }

    if (this.autoProvisionCustomers) {
      const created = await this.provisionCustomer(authIdentity);
      return this.toApplicationIdentity(created);
    }

    throw ApiError.forbidden(USER_MESSAGES.ACCOUNT_NOT_FOUND);
  }

  /**
   * Provisions a CUSTOMER application user for a new authentication identity.
   * Role and status are always CUSTOMER/ACTIVE — never taken from the JWT.
   */
  async provisionCustomer(authIdentity) {
    const data = {
      authProviderId: authIdentity.authProviderId,
      role: DEFAULT_USER_ROLE,
      status: DEFAULT_USER_STATUS,
    };
    if (typeof authIdentity.email === 'string' && authIdentity.email.length > 0) {
      data.email = authIdentity.email;
    }
    if (
      typeof authIdentity.displayName === 'string' &&
      authIdentity.displayName.length > 0
    ) {
      data.displayName = authIdentity.displayName;
    }
    return this.repository.create(data);
  }

  /**
   * Internal application identity placed on `req.user`. Includes the internal
   * `authProviderId` (used by services/audit) but never reaches API responses.
   */
  toApplicationIdentity(user) {
    return {
      id: String(user._id || user.id),
      authProviderId: user.authProviderId,
      email: user.email,
      displayName: user.displayName,
      phone: user.phone,
      role: user.role,
      status: user.status,
    };
  }

  /**
   * Safe API representation. Deliberately omits `authProviderId` and any
   * internal fields so future schema additions cannot leak to clients.
   */
  toSafeUser(user) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      phone: user.phone,
      role: user.role,
      status: user.status,
    };
  }

  // ---------------------------------------------------------------------
  // Admin surface (ADMIN-only customer list & detail)
  // ---------------------------------------------------------------------

  userNotFound() {
    return new ApiError(404, USER_MESSAGES.USER_NOT_FOUND, ERROR_CODES.USER_NOT_FOUND);
  }

  /**
   * ADMIN list of application users (newest first), optionally filtered by the
   * validated `role` / `status` filters from the controller. The endpoint is
   * named `/admin/customers`, but the surface lists every application user so
   * an ADMIN can also locate STAFF/ADMIN accounts by role.
   */
  async listCustomers({ role, status, page, limit }) {
    const filter = {};
    if (role !== undefined && role !== null && role !== '') {
      filter.role = role;
    }
    if (status !== undefined && status !== null && status !== '') {
      filter.status = status;
    }
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.repository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.repository.count(filter),
    ]);
    return {
      customers: docs.map((doc) => serializeAdminUser(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * ADMIN detail of one application user. 404 when the id is malformed or no
   * matching user exists.
   */
  async getCustomer(id) {
    assertObjectId(id, 'id');
    const doc = await this.repository.findById(id);
    if (!doc) {
      throw this.userNotFound();
    }
    return serializeAdminUser(doc);
  }
}

module.exports = { UserService };

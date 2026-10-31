'use strict';

/**
 * Shared HTTP-level fixtures for the Phase 07 integration tests (cart, orders,
 * admin orders). Mirrors the conventions of tests/integration/inventory.test.js
 * but composes the cart + order + admin-order routers into ONE app so full
 * flows (add to cart → checkout → confirm → process) share repository state.
 */

const express = require('express');
const crypto = require('crypto');
const { ROLES, ACCOUNT_STATUSES } = require('../../src/constants');
const { UserService } = require('../../src/modules/users/user.service');
const { CartService } = require('../../src/modules/cart/cart.service');
const { OrderService } = require('../../src/modules/orders/order.service');
const { AdminOrderService } = require('../../src/modules/orders/adminOrder.service');
const { ReservationService } = require('../../src/modules/inventory/reservation.service');
const { PaymentService } = require('../../src/modules/payments/payment.service');
const { PaymentMethodService } = require('../../src/modules/payments/paymentMethod.service');
const { createCartRouter } = require('../../src/modules/cart/cart.routes');
const { createOrderRouter } = require('../../src/modules/orders/order.routes');
const { createAdminOrderRouter } = require('../../src/modules/orders/adminOrder.routes');
const { createPaymentRouter } = require('../../src/modules/payments/payment.routes');
const { createAdminPaymentRouter } = require('../../src/modules/payments/adminPayment.routes');
const { createPaymentMethodRouter } = require('../../src/modules/payments/paymentMethod.routes');
const { createAdminPaymentMethodRouter } = require('../../src/modules/payments/adminPaymentMethod.routes');
const { createMemoryMediaService } = require('../../src/integrations/media/media.mock');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('./jwt-fixtures');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const {
  createMemoryVariantRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  createMemoryReservationRepository,
} = require('./inventory-stubs');
const {
  createMemoryOrderRepository,
  createMemoryCartRepository,
  createMemoryProductRepository,
  createRollbackTransaction,
} = require('./order-stubs');
const {
  createMemoryPaymentRepository,
  createMemoryPaymentMethodRepository,
} = require('./payment-stubs');
const { CourierService } = require('../../src/modules/courier/courier.service');
const { createCourierRouter } = require('../../src/modules/courier/courier.routes');
const { createMockCourierProvider } = require('../../src/modules/courier/courier.provider.mock');
const { createMemoryShipmentRepository } = require('./courier-stubs');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const P1 = '507f1f77bcf86cd799439031';
const P2 = '507f1f77bcf86cd799439032';
const V1 = '507f1f77bcf86cd799439041';
const V2 = '507f1f77bcf86cd799439042';
const UNKNOWN_VARIANT_ID = '507f1f77bcf86cd799439999';

function product(id, overrides = {}) {
  return {
    _id: id,
    name: id === P1 ? 'Abaya' : 'Kurta',
    slug: id === P1 ? 'abaya' : 'kurta',
    sellingPrice: 100000,
    discount: id === P2 ? { type: 'percentage', value: 10 } : null,
    isActive: true,
    ...overrides,
  };
}

function variant(id, overrides = {}) {
  return {
    _id: id,
    productId: id === V1 ? P1 : P2,
    sku: id === V1 ? 'ABAYA-52' : 'KURTA-L',
    attributes: { size: id === V1 ? '52' : 'L' },
    isActive: true,
    ...(id === V2 ? { sellingPriceOverride: 60000 } : {}),
    ...overrides,
  };
}

const USER_IDS = {
  'auth-customer-1': '507f1f77bcf86cd799439111',
  'auth-customer-2': '507f1f77bcf86cd799439112',
  'auth-staff-1': '507f1f77bcf86cd799439113',
  'auth-admin-1': '507f1f77bcf86cd799439114',
};

function userDoc(overrides = {}) {
  const authProviderId = overrides.authProviderId || 'auth-customer-1';
  return {
    _id: USER_IDS[authProviderId] || `usr-${authProviderId}`,
    authProviderId,
    email: 'amina@example.com',
    displayName: 'Amina Rahman',
    phone: '+8801712345678',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
    ...overrides,
  };
}

function createStubUserRepository(users) {
  return {
    findByAuthProviderId: async (authProviderId) =>
      users.find((u) => u.authProviderId === authProviderId) || null,
    create: async (data) => {
      // Provisioned identities (e.g. guest users) must carry a valid 24-hex
      // ObjectId: CartService and checkout assertObjectId(customerId).
      const id = crypto
        .createHash('sha1')
        .update(data.authProviderId)
        .digest('hex')
        .slice(0, 24);
      const created = { _id: id, ...data };
      users.push(created);
      return created;
    },
  };
}

const GUEST_ID_HEADER = 'x-guest-id';

function guestHeaders(guestId) {
  return { [GUEST_ID_HEADER]: guestId };
}

function seedUsers() {
  return [
    userDoc(),
    userDoc({ authProviderId: 'auth-customer-2' }),
    userDoc({
      authProviderId: 'auth-staff-1',
      email: 'staff@example.com',
      displayName: 'Staff Person',
      role: ROLES.STAFF,
    }),
    userDoc({
      authProviderId: 'auth-admin-1',
      email: 'admin@example.com',
      displayName: 'Admin Person',
      role: ROLES.ADMIN,
    }),
  ];
}

let defaultVerifier;

function buildApp({
  users,
  products = [product(P1), product(P2)],
  variants = [variant(V1), variant(V2)],
  inventory,
  paymentMethods = [],
  verifier: appVerifier,
  runTransaction,
  courierProvider,
  autoDispatchOnConfirm = false,
  webhookSecret = 'test-secret',
  notificationService,
} = {}) {
  const effectiveVerifier = appVerifier || defaultVerifier;
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers: true,
  });

  const productRepo = createMemoryProductRepository(products);
  const variantRepo = createMemoryVariantRepository(variants);
  const invRepo = createMemoryInventoryRepository(
    inventory || [
      { _id: '507f1f77bcf86cd7994390a1', productVariantId: V1, onlineQuantity: 20, offlineQuantity: 5, reservedQuantity: 0, lowStockThreshold: 2 },
      { _id: '507f1f77bcf86cd7994390a2', productVariantId: V2, onlineQuantity: 10, offlineQuantity: 0, reservedQuantity: 0, lowStockThreshold: 2 },
    ]
  );
  const movRepo = createMemoryMovementRepository();
  const resRepo = createMemoryReservationRepository();
  const cartRepo = createMemoryCartRepository();
  const orderRepo = createMemoryOrderRepository();
  const paymentRepo = createMemoryPaymentRepository();
  const paymentMethodRepo = createMemoryPaymentMethodRepository(paymentMethods);
  const mediaService = createMemoryMediaService();

  const transaction = runTransaction ||
    createRollbackTransaction([orderRepo, cartRepo, invRepo, resRepo, movRepo, paymentRepo, paymentMethodRepo]);

  const cartService = new CartService({
    cartRepository: cartRepo,
    productRepository: productRepo,
    variantRepository: variantRepo,
    inventoryRepository: invRepo,
  });

  const reservationService = new ReservationService({
    reservationRepository: resRepo,
    inventoryRepository: invRepo,
    movementRepository: movRepo,
    variantRepository: variantRepo,
    runTransaction: transaction,
  });

  const paymentMethodService = new PaymentMethodService({
    paymentMethodRepository: paymentMethodRepo,
  });

  const shipmentRepo = createMemoryShipmentRepository();

  const courierService = new CourierService({
    shipmentRepository: shipmentRepo,
    orderRepository: orderRepo,
    paymentRepository: paymentRepo,
    provider: courierProvider || createMockCourierProvider(),
    config: {
      defaultItemWeightKg: 0.5,
      webhookSecret,
      reconcileStaleAfterMs: 60 * 60 * 1000,
    },
  });

  const paymentService = new PaymentService({
    paymentRepository: paymentRepo,
    paymentMethodRepository: paymentMethodRepo,
    orderRepository: orderRepo,
    mediaService,
    runTransaction: transaction,
  });

  const orderService = new OrderService({
    orderRepository: orderRepo,
    cartRepository: cartRepo,
    productRepository: productRepo,
    variantRepository: variantRepo,
    reservationService,
    courierService,
    notificationService,
    runTransaction: transaction,
  });

  const adminOrderService = new AdminOrderService({
    orderRepository: orderRepo,
    orderService,
    courierService,
    paymentRepository: paymentRepo,
    autoDispatchOnConfirm,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/cart',
    createCartRouter({ cartService, userService, verifier: effectiveVerifier })
  );
  app.use(
    '/api/v1/orders',
    createOrderRouter({ orderService, userService, verifier: effectiveVerifier })
  );
  app.use(
    '/api/v1/orders',
    createPaymentRouter({ paymentService, userService, verifier: effectiveVerifier })
  );
  app.use(
    '/api/v1/payment-methods',
    createPaymentMethodRouter({ paymentMethodService })
  );
  app.use(
    '/api/v1/admin/orders',
    createAdminOrderRouter({ adminOrderService, userService, verifier: effectiveVerifier })
  );
  app.use(
    '/api/v1/admin/payments',
    createAdminPaymentRouter({ paymentService, userService, verifier: effectiveVerifier })
  );
  app.use(
    '/api/v1/admin/payment-methods',
    createAdminPaymentMethodRouter({ paymentMethodService, userService, verifier: effectiveVerifier })
  );
  app.use(
    '/api/v1',
    createCourierRouter({ courierService, userService, verifier: effectiveVerifier })
  );
  app.use(notFound);
  app.use(errorHandler);

  return {
    app,
    repos: {
      cartRepo,
      orderRepo,
      invRepo,
      resRepo,
      movRepo,
      productRepo,
      variantRepo,
      paymentRepo,
      paymentMethodRepo,
      mediaService,
      shipmentRepo,
      courierService,
    },
  };
}

function withServer(build, fn) {
  return async () => {
    const { app, repos } = build();
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      await fn(`http://127.0.0.1:${port}`, repos);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function request(method, url, token, body, headers = {}) {
  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const VALID_ADDRESS = {
  fullName: 'Amina Rahman',
  phone: '+8801712345678',
  line1: 'House 12, Road 5',
  line2: null,
  city: 'Chattogram',
  area: 'GEC Circle',
  district: 'Chattogram',
  postalCode: '4000',
  country: 'BD',
};

function checkoutBody(overrides = {}) {
  return {
    delivery: { address: { ...VALID_ADDRESS } },
    notes: null,
    paymentMethod: 'COD',
    ...overrides,
  };
}

async function setupAuth() {
  const { privateKey, publicJwk } = await createKeyPair();
  defaultVerifier = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });
  const token = async (subject, claims = {}) =>
    signToken({ privateKey, subject, claims: { email: `${subject}@example.com`, name: subject, ...claims } });
  return {
    verifier: defaultVerifier,
    tokenCustomer: await token('auth-customer-1'),
    tokenCustomer2: await token('auth-customer-2'),
    tokenStaff: await token('auth-staff-1'),
    tokenAdmin: await token('auth-admin-1'),
    tokenAdminClaimSpoof: await token('auth-customer-1', { role: 'ADMIN' }),
  };
}

module.exports = {
  P1,
  P2,
  V1,
  V2,
  UNKNOWN_VARIANT_ID,
  product,
  variant,
  userDoc,
  createStubUserRepository,
  seedUsers,
  buildApp,
  withServer,
  request,
  GUEST_ID_HEADER,
  guestHeaders,
  VALID_ADDRESS,
  checkoutBody,
  setupAuth,
};

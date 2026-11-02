'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { notificationTemplates } = require('../../../src/modules/notifications/templates');
const { NOTIFICATION_EVENT_TYPES } = require('../../../src/modules/notifications/notification.constants');

const CUSTOMER = { name: 'Ayesha', email: 'customer@taqwa.test', phone: '+971501234567' };
const DATA = {
  entityRef: 'pay-1',
  order: { orderNumber: 'TAQ-20260808-000001' },
  payment: { transactionReference: 'REF-1', amountMinorUnits: 248000 },
};

test('every NOTIFICATION_EVENT_TYPE has a registered template', () => {
  for (const eventType of Object.values(NOTIFICATION_EVENT_TYPES)) {
    const template = notificationTemplates[eventType];
    assert.ok(template, `missing template for ${eventType}`);
    assert.equal(template.key, eventType, `template key mismatch for ${eventType}`);
    assert.equal(typeof template.render, 'function', `template render missing for ${eventType}`);
  }
});

test('payment templates render the order number and formatted amount', () => {
  const submitted = notificationTemplates[NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED].render({
    customer: CUSTOMER,
    data: DATA,
  });
  assert.match(submitted.subject, /Payment received for order TAQ-20260808-000001/);
  assert.match(submitted.text, /2,480\.00/);
  assert.ok(submitted.html.includes('REF-1'), 'HTML includes the transaction reference');
  assert.ok(submitted.html);

  const verified = notificationTemplates[NOTIFICATION_EVENT_TYPES.PAYMENT_VERIFIED].render({
    customer: CUSTOMER,
    data: DATA,
  });
  assert.match(verified.subject, /Payment verified for order TAQ-20260808-000001/);
  assert.match(verified.text, /has been verified/);
});

test('rejected-payment template surfaces the staff note and HTML-escapes it', () => {
  const rejected = notificationTemplates[NOTIFICATION_EVENT_TYPES.PAYMENT_REJECTED].render({
    customer: CUSTOMER,
    data: { ...DATA, note: '<script>alert(1)</script> & "reason"' },
  });
  assert.match(rejected.subject, /Action needed: payment for order TAQ-20260808-000001/);
  assert.ok(rejected.html.includes('&lt;script&gt;'), 'note must be HTML-escaped');
  assert.ok(rejected.text.includes('resubmit your payment proof'));
});

test('templates tolerate missing optional data', () => {
  const submitted = notificationTemplates[NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED].render({
    customer: CUSTOMER,
    data: { entityRef: 'pay-2' },
  });
  assert.match(submitted.subject, /Payment received for order/);
  assert.ok(submitted.html && submitted.text);

  const rejected = notificationTemplates[NOTIFICATION_EVENT_TYPES.PAYMENT_REJECTED].render({
    customer: CUSTOMER,
    data: { order: { orderNumber: null }, note: null },
  });
  assert.match(rejected.subject, /Action needed/);
});

test('admin order template renders a readable summary with no internal ids', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED].render({
    data: {
      entityRef: '507f1f77bcf86cd799439999',
      orderNumber: 'TAQ-20260808-000001',
      customerName: 'Amina Rahman',
      itemCount: 2,
      grandTotalMinorUnits: 248000,
      paymentMethod: 'COD',
    },
  });
  assert.match(rendered.title, /New order TAQ-20260808-000001/);
  assert.match(rendered.message, /Amina Rahman placed an order TAQ-20260808-000001/);
  assert.match(rendered.message, /2 items/);
  assert.match(rendered.message, /2,480\.00/);
  assert.match(rendered.message, /COD/);
  assert.ok(!rendered.title.includes('507f1f77'), 'no Mongo id in the title');
  assert.ok(!rendered.message.includes('507f1f77'), 'no Mongo id in the message');
});

test('admin review template renders customer + product + rating and escapes unsafe text', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ADMIN_REVIEW_SUBMITTED].render({
    data: {
      entityRef: '507f1f77bcf86cd799439888',
      customerName: 'Amina <script>',
      productName: 'Premium Abaya & Co',
      rating: 5,
      comment: 'Excellent <b>fit</b>',
    },
  });
  assert.match(rendered.title, /New review: Premium Abaya/);
  assert.match(rendered.message, /Amina &lt;script&gt;/);
  assert.match(rendered.message, /Premium Abaya &amp; Co/);
  assert.match(rendered.message, /5\/5/);
  assert.match(rendered.message, /&lt;b&gt;fit&lt;\/b&gt;/);
  assert.ok(!rendered.title.includes('507f1f77'));
  assert.ok(!rendered.message.includes('507f1f77'));
});

test('admin templates tolerate missing optional data', () => {
  const order = notificationTemplates[NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED].render({
    data: { entityRef: 'order-9' },
  });
  assert.ok(order.title && order.message);
  assert.ok(!order.title.includes('undefined'));
  assert.ok(!order.message.includes('undefined'));

  const review = notificationTemplates[NOTIFICATION_EVENT_TYPES.ADMIN_REVIEW_SUBMITTED].render({
    data: { entityRef: 'review-9', rating: 3 },
  });
  assert.ok(review.title && review.message);
  assert.ok(!review.message.includes('undefined'));
});

function adminEmailData(overrides = {}) {
  return {
    entityRef: '507f1f77bcf86cd799439999',
    adminOrderUrl: 'https://admin.taqwa.com/admin/orders/507f1f77bcf86cd799439999',
    orderNumber: 'TAQ-20260808-000001',
    createdAt: new Date('2026-08-08T10:24:00Z'),
    status: 'PENDING',
    paymentMethod: 'COD',
    paymentStatus: 'Pending — collect on delivery',
    customerName: 'Amina Rahman',
    customerPhone: '+8801712345678',
    customerEmail: 'amina@example.com',
    address: {
      line1: 'House 12, Road 5',
      line2: null,
      area: 'GEC Circle',
      city: 'Chattogram',
      district: 'Chattogram',
      postalCode: '4000',
      country: 'BD',
    },
    notes: 'Call before delivery',
    totals: {
      itemsSubtotalMinorUnits: 200000,
      totalDiscountMinorUnits: 20000,
      deliveryFeeMinorUnits: 10000,
      grandTotalMinorUnits: 190000,
    },
    items: [
      { productName: 'Premium Abaya & Co', variantAttributes: { size: '52' }, quantity: 2, unitPriceMinorUnits: 90000, lineTotalMinorUnits: 180000 },
    ],
    ...overrides,
  };
}

test('admin order email template renders the full order summary with a dashboard button and no internal ids in visible text', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL].render({
    data: adminEmailData(),
  });

  assert.equal(rendered.subject, 'New order TAQ-20260808-000001 received');
  assert.match(rendered.html, /New Order Received/);
  assert.match(rendered.html, /TAQ-20260808-000001/);
  assert.match(rendered.html, /Pending &mdash; collect on delivery|Pending — collect on delivery/);
  assert.match(rendered.html, /Amina Rahman/);
  assert.match(rendered.html, /\+8801712345678/);
  assert.match(rendered.html, /amina@example\.com/);
  assert.match(rendered.html, /Call before delivery/);
  assert.match(rendered.html, /Premium Abaya &amp; Co/);
  assert.match(rendered.html, /Size: 52/);
  assert.match(rendered.html, /\u09F31,800\.00/);
  assert.match(rendered.html, /\u09F32,000\.00/);
  assert.match(rendered.html, /-?\u09F3200\.00/);
  assert.match(rendered.html, /\u09F31,900\.00/);
  assert.match(rendered.html, /View Order in Admin Dashboard/);
  assert.match(
    rendered.html,
    /https:\/\/admin\.taqwa\.com\/admin\/orders\/507f1f77bcf86cd799439999/
  );

  assert.ok(
    !rendered.html.includes('undefined') && !rendered.html.includes('null'),
    'no undefined/null literals in the HTML'
  );
  assert.match(rendered.text, /NEW ORDER RECEIVED/);
  assert.match(rendered.text, /Grand total: \u09F31,900\.00/);
  assert.match(rendered.text, /View in admin dashboard: https:\/\/admin\.taqwa\.com\/admin\/orders\/507f1f77bcf86cd799439999/);
});

test('admin order email template HTML-escapes user-controlled values', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL].render({
    data: adminEmailData({
      customerName: 'Amina <script>alert(1)</script>',
      notes: '<b>urgent</b> & "now"',
      items: [{ productName: 'Abaya "Luxe" <i>x</i>', variantAttributes: { size: 'L' }, quantity: 1, unitPriceMinorUnits: 5000, lineTotalMinorUnits: 5000 }],
    }),
  });
  assert.ok(rendered.html.includes('Amina &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(rendered.html.includes('&lt;b&gt;urgent&lt;/b&gt; &amp; &quot;now&quot;'));
  assert.ok(rendered.html.includes('Abaya &quot;Luxe&quot; &lt;i&gt;x&lt;/i&gt;'));
});

test('admin order email template omits the discount row and button when not provided', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL].render({
    data: adminEmailData({
      adminOrderUrl: null,
      customerEmail: null,
      notes: null,
      totals: { itemsSubtotalMinorUnits: 100000, totalDiscountMinorUnits: 0, deliveryFeeMinorUnits: 0, grandTotalMinorUnits: 100000 },
    }),
  });
  assert.ok(!rendered.html.includes('Discount'), 'no discount row when discount is 0');
  assert.ok(!rendered.html.includes('View Order in Admin Dashboard'), 'no button without a URL');
  assert.ok(!rendered.html.includes('undefined'));
});

test('admin order email template tolerates missing data', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL].render({
    data: { entityRef: 'order-9' },
  });
  assert.match(rendered.subject, /New order  received/);
  assert.ok(rendered.html.includes('New Order Received'));
  assert.ok(!rendered.html.includes('undefined'));
  assert.ok(!rendered.html.includes('null'));
});

function orderPlacedData(overrides = {}) {
  const createdAt = new Date('2026-08-08T10:24:00Z');
  return {
    entityRef: '507f1f77bcf86cd799439999',
    trackOrderUrl: 'https://taqwactg.com/track/TAQ-20260808-000001',
    order: {
      orderNumber: 'TAQ-20260808-000001',
      status: 'PENDING',
      paymentMethod: 'COD',
      createdAt,
      notes: 'Call before delivery',
      totals: {
        itemsSubtotalMinorUnits: 200000,
        totalDiscountMinorUnits: 0,
        deliveryFeeMinorUnits: 10000,
        grandTotalMinorUnits: 210000,
      },
      items: [
        { productName: 'Premium Abaya & Co', variantAttributes: { size: '52' }, quantity: 2, unitPriceMinorUnits: 90000, lineTotalMinorUnits: 180000, productImageUrl: null },
        { productName: 'Embroidered Hijab', variantAttributes: { color: 'Beige' }, quantity: 1, unitPriceMinorUnits: 20000, lineTotalMinorUnits: 20000, productImageUrl: 'https://media.taqwa.test/hijab.jpg' },
      ],
      delivery: {
        address: {
          fullName: 'Amina Rahman',
          phone: '+8801712345678',
          line1: 'House 12, Road 5',
          line2: null,
          area: 'GEC',
          city: 'Chattogram',
          district: 'Chattogram',
          postalCode: '4000',
        },
      },
    },
    ...overrides,
  };
}

test('customer ORDER_PLACED email renders the full premium order confirmation', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ORDER_PLACED].render({
    customer: CUSTOMER,
    data: orderPlacedData(),
  });

  assert.equal(rendered.subject, 'Order TAQ-20260808-000001 received');
  assert.match(rendered.html, /Order Confirmation/);
  assert.match(rendered.html, /Order confirmed/);
  assert.ok(rendered.html.includes('TAQ-20260808-000001'));
  const { formatLongDate } = require('../../../src/modules/notifications/templates/helpers');
  assert.ok(rendered.html.includes(formatLongDate(new Date('2026-08-08T10:24:00Z'))));
  assert.match(rendered.html, /Cash on Delivery/);
  assert.match(rendered.html, /please keep the order amount ready at delivery/);
  assert.match(rendered.html, /Amina Rahman/);
  assert.match(rendered.html, /\+8801712345678/);
  assert.match(rendered.html, /House 12, Road 5/);
  assert.match(rendered.html, /Premium Abaya &amp; Co/);
  assert.match(rendered.html, /Embroidered Hijab/);
  assert.match(rendered.html, /https:\/\/media\.taqwa\.test\/hijab\.jpg/);
  assert.match(rendered.html, />52</);
  assert.match(rendered.html, /Beige/);
  assert.match(rendered.html, /\u09F3900\.00/);
  assert.match(rendered.html, /\u09F31,800\.00/);
  assert.match(rendered.html, /\u09F32,000\.00/);
  assert.match(rendered.html, /\u09F3100\.00/);
  assert.match(rendered.html, /\u09F32,100\.00/);
  assert.match(rendered.html, /Call before delivery/);
  assert.match(rendered.html, /Track Your Order/);
  assert.match(
    rendered.html,
    /href="https:\/\/www\.asiaelectronicsonline\.com\/track-order"/
  );
  assert.ok(
    !rendered.html.includes('undefined') && !rendered.html.includes('null'),
    'no undefined/null literals in the HTML'
  );
  assert.ok(!rendered.html.includes('507f1f77'), 'no Mongo id in the customer HTML');

  assert.match(rendered.text, /Order number: TAQ-20260808-000001/);
  assert.match(rendered.text, /Grand total: \u09F32,100\.00/);
  assert.match(rendered.text, /Track your order: https:\/\/www\.asiaelectronicsonline\.com\/track-order/);
});

test('customer ORDER_PLACED email omits product images when none are available', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ORDER_PLACED].render({
    customer: CUSTOMER,
    data: orderPlacedData({
      order: {
        ...orderPlacedData().order,
        items: [
          { productName: 'Abaya', variantAttributes: { size: '52' }, quantity: 1, unitPriceMinorUnits: 5000, lineTotalMinorUnits: 5000 },
        ],
      },
    }),
  });
  assert.ok(!rendered.html.includes('<img'), 'no image markup without an image URL');
});

test('customer ORDER_PLACED email uses the bank-transfer note for non-COD orders', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ORDER_PLACED].render({
    customer: CUSTOMER,
    data: orderPlacedData({
      order: { ...orderPlacedData().order, paymentMethod: 'BANK_TRANSFER' },
    }),
  });
  assert.match(rendered.html, /bank transfer details shortly/);
});

test('customer ORDER_PLACED email HTML-escapes user-controlled values', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ORDER_PLACED].render({
    customer: CUSTOMER,
    data: orderPlacedData({
      order: {
        ...orderPlacedData().order,
        notes: '<b>urgent</b> & "now"',
        items: [
          { productName: 'Abaya "Luxe" <i>x</i>', variantAttributes: { size: 'L & XL' }, quantity: 1, unitPriceMinorUnits: 5000, lineTotalMinorUnits: 5000 },
        ],
        delivery: {
          address: {
            ...orderPlacedData().order.delivery.address,
            fullName: 'Amina <script>alert(1)</script>',
          },
        },
      },
    }),
  });
  assert.ok(rendered.html.includes('&lt;b&gt;urgent&lt;/b&gt; &amp; &quot;now&quot;'));
  assert.ok(rendered.html.includes('Abaya &quot;Luxe&quot; &lt;i&gt;x&lt;/i&gt;'));
  assert.ok(rendered.html.includes('Amina &lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('customer ORDER_PLACED email tolerates missing data', () => {
  const rendered = notificationTemplates[NOTIFICATION_EVENT_TYPES.ORDER_PLACED].render({
    customer: CUSTOMER,
    data: { entityRef: 'order-9' },
  });
  assert.match(rendered.subject, /Order  received/);
  assert.match(rendered.html, /Order confirmed/);
  assert.ok(!rendered.html.includes('undefined'));
  assert.ok(!rendered.html.includes('null'));
});

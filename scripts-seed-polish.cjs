'use strict';

const { connectDatabase, disconnectDatabase } = require('./src/config/database');
const Category = require('./src/modules/categories/category.model');
const Product = require('./src/modules/products/product.model');
const ProductVariant = require('./src/modules/products/variants/productVariant.model');
const Inventory = require('./src/modules/inventory/inventory.model');
const Review = require('./src/modules/reviews/review.model');
const User = require('./src/modules/users/user.model');

function buildAttributeKey(attributes) {
  const sorted = Object.keys(attributes)
    .sort()
    .map((key) => [key, attributes[key]]);
  return JSON.stringify(sorted);
}

const CATEGORY_SLUG = 'e2e-polish-collection';
const PRODUCT_SLUG = 'e2e-silk-abaya';

async function seed() {
  await connectDatabase();

  const existingProduct = await Product.findOne({ slug: PRODUCT_SLUG });
  if (existingProduct) {
    const variants = await ProductVariant.find({ productId: existingProduct._id });
    await Review.deleteMany({ productId: existingProduct._id });
    await Inventory.deleteMany({ productVariantId: { $in: variants.map((v) => v._id) } });
    await ProductVariant.deleteMany({ productId: existingProduct._id });
    await Product.deleteMany({ slug: PRODUCT_SLUG });
  }
  await Category.deleteMany({ slug: CATEGORY_SLUG });
  await User.deleteMany({ authProviderId: 'seed-polish-review-author' });

  const category = await Category.create({
    name: 'E2E Polish Collection',
    slug: CATEGORY_SLUG,
    description: 'Temporary collection for storefront polish verification.',
    isActive: true,
    sortOrder: 0,
  });

  const product = await Product.create({
    name: 'E2E Silk Abaya',
    slug: PRODUCT_SLUG,
    description:
      'Polished storefront test piece used to verify the product detail, cart and review UX against the live backend.',
    categoryId: category._id,
    sellingPrice: 450000,
    discount: { type: 'percentage', value: 10 },
    featured: true,
    newArrival: true,
    images: [],
    isActive: true,
  });

  const variantsData = [
    { sku: 'E2E-SILK-BLK-S', attributes: { size: 'S', color: 'Black' } },
    { sku: 'E2E-SILK-BLK-M', attributes: { size: 'M', color: 'Black' } },
    { sku: 'E2E-SILK-BLK-L', attributes: { size: 'L', color: 'Black' }, isActive: false },
  ];
  const variants = [];
  for (const v of variantsData) {
    variants.push(
      await ProductVariant.create({
        productId: product._id,
        sku: v.sku,
        attributes: v.attributes,
        attributeKey: buildAttributeKey(v.attributes),
        isActive: v.isActive !== false,
      })
    );
  }

  await Inventory.create({
    productVariantId: variants[0]._id,
    onlineQuantity: 5,
    reservedQuantity: 1,
    offlineQuantity: 0,
    lowStockThreshold: 2,
  });
  await Inventory.create({
    productVariantId: variants[1]._id,
    onlineQuantity: 0,
    reservedQuantity: 0,
    offlineQuantity: 0,
    lowStockThreshold: 0,
  });

  const author = await User.create({
    authProviderId: 'seed-polish-review-author',
    email: 'seed-polish-review@example.com',
    role: 'CUSTOMER',
    status: 'ACTIVE',
    displayName: 'E2E Review Author',
  });

  const now = new Date();
  const approvedReview = (rating, comment, customerDisplayName) => ({
    productId: product._id,
    customerId: author._id,
    customerDisplayName,
    rating,
    comment,
    status: 'APPROVED',
    approvedBy: author._id,
    approvedAt: now,
    statusHistory: [
      { status: 'PENDING', at: new Date(now.getTime() - 86400000), by: author._id },
      { status: 'APPROVED', at: now, by: author._id, note: 'Seeded approved review' },
    ],
  });

  await Review.create(approvedReview(5, 'Absolutely beautiful fabric and perfect stitching.', 'Ayesha K.'));
  await Review.create(approvedReview(4, 'Lovely abaya, slightly long for my height.', 'Nadia R.'));
  await Review.create({
    productId: product._id,
    customerId: author._id,
    customerDisplayName: 'Pending Author',
    rating: 3,
    comment: 'Pending review — must not appear publicly.',
    status: 'PENDING',
    statusHistory: [{ status: 'PENDING', at: now, by: author._id }],
  });

  console.log(
    `SEED-POLISH-OK productId=${product._id} slug=${product.slug} categoryId=${category._id} variants=${variants.length}`
  );
  await disconnectDatabase();
  process.exit(0);
}

seed().catch(async (err) => {
  console.error('SEED-POLISH-ERR', err);
  await disconnectDatabase();
  process.exit(1);
});

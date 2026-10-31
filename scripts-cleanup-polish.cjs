'use strict';

const { connectDatabase, disconnectDatabase } = require('./src/config/database');
const Category = require('./src/modules/categories/category.model');
const Product = require('./src/modules/products/product.model');
const ProductVariant = require('./src/modules/products/variants/productVariant.model');
const Inventory = require('./src/modules/inventory/inventory.model');
const Review = require('./src/modules/reviews/review.model');
const User = require('./src/modules/users/user.model');

const PRODUCT_SLUG = 'e2e-silk-abaya';
const CATEGORY_SLUG = 'e2e-polish-collection';
const TEST_EMAILS = [
  'seed-polish-review@example.com',
  'e2e-polish-review-customer@example.com',
];

async function cleanup() {
  await connectDatabase();

  const deleted = { reviews: 0, inventory: 0, variants: 0, products: 0, categories: 0, users: 0, liveReviews: 0 };

  const product = await Product.findOne({ slug: PRODUCT_SLUG });
  if (product) {
    const variants = await ProductVariant.find({ productId: product._id });
    const variantIds = variants.map((v) => v._id);
    deleted.reviews = (await Review.deleteMany({ productId: product._id })).deletedCount;
    deleted.inventory = (await Inventory.deleteMany({ productVariantId: { $in: variantIds } })).deletedCount;
    deleted.variants = (await ProductVariant.deleteMany({ productId: product._id })).deletedCount;
    deleted.products = (await Product.deleteMany({ slug: PRODUCT_SLUG })).deletedCount;
  }
  deleted.categories = (await Category.deleteMany({ slug: CATEGORY_SLUG })).deletedCount;

  const users = await User.find({ email: { $in: TEST_EMAILS } });
  deleted.users = users.length;
  for (const user of users) {
    deleted.liveReviews += (await Review.deleteMany({ customerId: user._id })).deletedCount;
    await User.deleteMany({ _id: user._id });
  }

  console.log('CLEANUP-POLISH-OK ' + JSON.stringify(deleted));
  await disconnectDatabase();
  process.exit(0);
}

cleanup().catch(async (err) => {
  console.error('CLEANUP-POLISH-ERR', err);
  await disconnectDatabase();
  process.exit(1);
});

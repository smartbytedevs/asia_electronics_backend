'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { CART_LIMITS, CART_MESSAGES } = require('./cart.constants');
const { assertObjectId } = require('./cart.validation');
const { serializeCart } = require('./cart.serializer');
const { variantSizeTokens } = require('../products/variants/variantSizes');

/**
 * Cart business logic (Phase 07, ADR-0015).
 *
 * The cart is a SERVER-SIDE draft, one per customer, storing ONLY variant
 * references + quantities. All prices shown are derived live from the catalog
 * at read time; the AUTHORITATIVE numbers are recomputed at checkout.
 *
 * Safety:
 * - Customer scoping is enforced HERE: every operation uses the `customerId`
 *   passed by the controller (always `req.user.id`). A cart body can never
 *   carry a customer id or money.
 * - Item mutations compute the new items array and write it in ONE atomic
 *   `setItems` update (never read-modify-write), so concurrent cart edits
 *   cannot lose updates.
 * - Unknown/operator fields and client money are rejected by validation.
 */
class CartService {
  constructor({
    cartRepository,
    productRepository,
    variantRepository,
    inventoryRepository,
  }) {
    if (!cartRepository || typeof cartRepository.findByCustomer !== 'function') {
      throw new Error('CartService requires a cartRepository');
    }
    if (!productRepository || typeof productRepository.findById !== 'function') {
      throw new Error('CartService requires a productRepository');
    }
    if (!variantRepository || typeof variantRepository.findById !== 'function') {
      throw new Error('CartService requires a variantRepository');
    }
    if (
      typeof variantRepository.findOneByProduct !== 'function' &&
      typeof variantRepository.findByProduct !== 'function'
    ) {
      throw new Error(
        'CartService requires a variantRepository with findOneByProduct or findByProduct'
      );
    }
    if (
      !inventoryRepository ||
      typeof inventoryRepository.findByProductVariantId !== 'function' ||
      typeof inventoryRepository.findByProductId !== 'function'
    ) {
      throw new Error('CartService requires an inventoryRepository');
    }
    this.cartRepository = cartRepository;
    this.productRepository = productRepository;
    this.variantRepository = variantRepository;
    this.inventoryRepository = inventoryRepository;
  }

  invalidItem(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_CART_ITEM);
  }

  itemNotFound() {
    return new ApiError(
      404,
      CART_MESSAGES.INVALID_CART_ITEM,
      ERROR_CODES.INVALID_CART_ITEM
    );
  }

  cartNotFound() {
    return new ApiError(404, CART_MESSAGES.CART_NOT_FOUND, ERROR_CODES.CART_NOT_FOUND);
  }

  itemLimit() {
    return new ApiError(409, CART_MESSAGES.CART_ITEM_LIMIT, ERROR_CODES.CART_ITEM_LIMIT);
  }

  /**
   * Loads (creating on demand) the customer's cart and enriches every line
   * with LIVE catalog + availability data. `enrich` is true by default and
   * false for internal transactional reads (checkout recomputes everything
   * itself).
   */
  async getCart(customerId, { enrich = true } = {}) {
    assertObjectId(customerId, 'customerId');
    let cart = await this.cartRepository.findByCustomer(customerId);
    if (!cart) {
      cart = await this.cartRepository.create({ customerId, items: [], isCheckedOut: false });
    }
    if (!enrich) {
      return cart;
    }
    const lines = await this.loadLines(cart.items);
    return serializeCart(cart, lines);
  }

  /**
   * Enriches every cart line with its live product, variant, and inventory.
   * Missing/inactive catalog docs are represented as unavailable lines rather
   * than errors — a cart stays listable/cleared even when the catalog changed.
   */
  async loadLines(items) {
    const lines = {};
    await Promise.all(
      (items || []).map(async (item) => {
        const productId = item.productId ? String(item.productId) : null;
        const productVariantId = item.productVariantId
          ? String(item.productVariantId)
          : null;
        const [product, variant, inventory] = await Promise.all([
          productId
            ? this.productRepository.findById(productId).catch(() => null)
            : Promise.resolve(null),
          productVariantId
            ? this.variantRepository.findById(productVariantId).catch(() => null)
            : Promise.resolve(null),
          productVariantId
            ? this.inventoryRepository
                .findByProductVariantId(productVariantId)
                .catch(() => null)
            : productId
              ? this.inventoryRepository.findByProductId(productId).catch(() => null)
              : Promise.resolve(null),
        ]);
        lines[String(item._id)] = { product, variant, inventory };
      })
    );
    return lines;
  }

  /**
   * A Simple Product (no variant) may only be added when the product has NO
   * active variants. Never silently picks a variant on the customer's behalf.
   */
  async hasActiveVariants(productId) {
    if (typeof this.variantRepository.findOneByProduct === 'function') {
      const variant = await this.variantRepository.findOneByProduct(productId, {
        isActive: true,
      });
      return Boolean(variant);
    }
    const variants = await this.variantRepository.findByProduct(productId);
    return (variants || []).some((variant) => variant.isActive);
  }

  /**
   * ADD (or bump) an item. Requires an ACTIVE variant of an ACTIVE product.
   * Adding an already-present variant + selectedSize combination increments its
   * quantity; a NEW line must respect the item limit.
   *
   * Size selection: when the variant carries MULTIPLE sizes ("L, M, S"),
   * `selectedSize` is REQUIRED and must be one of those tokens. For a variant
   * with a single (or no) size, `selectedSize` is optional. This keeps size
   * identity on the line so "S" and "M" of the same variant are distinct cart
   * items that never merge or get overwritten by a later size.
   */
  async addItem({
    customerId,
    productId = null,
    productVariantId = null,
    quantity,
    selectedSize = null,
  }) {
    assertObjectId(customerId, 'customerId');
    productId = productId || null;
    productVariantId = productVariantId || null;
    if (!productId && !productVariantId) {
      throw this.invalidItem('productId or productVariantId is required');
    }

    let product;
    let variant = null;
    if (productVariantId) {
      assertObjectId(productVariantId, 'productVariantId');
      variant = await this.variantRepository.findById(productVariantId);
      if (!variant || !variant.isActive) {
        throw this.itemNotFound();
      }
      if (productId && String(productId) !== String(variant.productId)) {
        throw this.itemNotFound();
      }
      product = await this.productRepository.findById(String(variant.productId));
      if (!product || !product.isActive) {
        throw this.itemNotFound();
      }
      productId = String(product._id);
    } else {
      assertObjectId(productId, 'productId');
      product = await this.productRepository.findById(productId);
      if (!product || !product.isActive) {
        throw this.itemNotFound();
      }
      if (await this.hasActiveVariants(productId)) {
        throw this.invalidItem('This product requires a variant selection');
      }
    }

    const sizeTokens = variant ? variantSizeTokens(variant) : [];
    if (selectedSize != null) {
      if (sizeTokens.length === 0) {
        throw this.invalidItem('This product has no size to select');
      }
      if (!sizeTokens.includes(selectedSize)) {
        throw this.invalidItem(
          `selectedSize must be one of: ${sizeTokens.join(', ')}`
        );
      }
    } else if (sizeTokens.length > 1) {
      throw this.invalidItem('A size selection is required for this product');
    }

    const matchesLine = (item) =>
      productVariantId
        ? String(item.productVariantId) === String(productVariantId) &&
          (item.selectedSize ?? null) === (selectedSize ?? null)
        : !item.productVariantId &&
          String(item.productId) === String(productId) &&
          (item.selectedSize ?? null) === (selectedSize ?? null);

    let cart = await this.cartRepository.findByCustomer(customerId);
    if (!cart) {
      try {
        cart = await this.cartRepository.create({
          customerId,
          items: [
            {
              productVariantId: productVariantId || null,
              productId: product._id,
              quantity,
              selectedSize,
            },
          ],
          isCheckedOut: false,
        });
      } catch (err) {
        if (err && (err.code === 11000 || err.name === 'MongoServerError')) {
          cart = await this.cartRepository.findByCustomer(customerId);
          if (!cart) {
            throw this.cartNotFound();
          }
        } else {
          throw err;
        }
      }
      const lines = await this.loadLines(cart.items);
      return serializeCart(cart, lines);
    }

    const existing = cart.items.find(matchesLine);

    let items;
    if (existing) {
      const newQuantity = existing.quantity + quantity;
      if (newQuantity > CART_LIMITS.QUANTITY_MAX) {
        throw this.invalidItem(
          `quantity must be at most ${CART_LIMITS.QUANTITY_MAX}`
        );
      }
      items = cart.items.map((item) =>
        matchesLine(item)
          ? { ...item.toObject(), quantity: newQuantity }
          : item
      );
    } else {
      if (cart.items.length >= CART_LIMITS.ITEMS_MAX) {
        throw this.itemLimit();
      }
      items = [
        ...cart.items,
        {
          productVariantId: productVariantId || null,
          productId: product._id,
          quantity,
          selectedSize,
        },
      ];
    }

    const updated = await this.cartRepository.setItems(customerId, items);
    if (!updated) {
      throw this.cartNotFound();
    }
    const lines = await this.loadLines(updated.items);
    return serializeCart(updated, lines);
  }

  /**
   * UPDATE an item's quantity. The item must already be in the customer's
   * cart.
   */
  async updateItem({ customerId, itemId, quantity }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(itemId, 'itemId');

    const cart = await this.cartRepository.findByCustomer(customerId);
    if (!cart) {
      throw this.cartNotFound();
    }
    const item = cart.items.find((i) => String(i._id) === String(itemId));
    if (!item) {
      throw this.itemNotFound();
    }

    const items = cart.items.map((i) =>
      String(i._id) === String(itemId) ? { ...i.toObject(), quantity } : i
    );
    const updated = await this.cartRepository.setItems(customerId, items);
    if (!updated) {
      throw this.cartNotFound();
    }
    const lines = await this.loadLines(updated.items);
    return serializeCart(updated, lines);
  }

  /**
   * REMOVE an item by its cart-item id.
   */
  async removeItem({ customerId, itemId }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(itemId, 'itemId');

    const cart = await this.cartRepository.findByCustomer(customerId);
    if (!cart) {
      throw this.cartNotFound();
    }
    const item = cart.items.find((i) => String(i._id) === String(itemId));
    if (!item) {
      throw this.itemNotFound();
    }

    const items = cart.items.filter((i) => String(i._id) !== String(itemId));
    const updated = await this.cartRepository.setItems(customerId, items);
    if (!updated) {
      throw this.cartNotFound();
    }
    const lines = await this.loadLines(updated.items);
    return serializeCart(updated, lines);
  }

  /**
   * CLEAR all items (idempotent — an empty/absent cart succeeds and returns
   * an empty cart).
   */
  async clearCart(customerId) {
    assertObjectId(customerId, 'customerId');
    let cart = await this.cartRepository.findByCustomer(customerId);
    if (!cart) {
      cart = await this.cartRepository.create({
        customerId,
        items: [],
        isCheckedOut: false,
      });
    } else {
      const updated = await this.cartRepository.setItems(customerId, []);
      cart = updated || cart;
    }
    return serializeCart(cart, {});
  }
}

module.exports = { CartService };

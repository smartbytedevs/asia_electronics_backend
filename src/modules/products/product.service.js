'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES, ROLES } = require('../../constants');
const {
  PRODUCT_LIST_FILTERS,
  PRODUCT_SORTS,
  PAGINATION,
  PRODUCT_MESSAGES,
  slugify,
} = require('./product.constants');
const {
  validateProductInput,
  assertDiscountWithinPrice,
  isPlainObject,
  OBJECT_ID_PATTERN,
} = require('./product.validation');
const { withTransaction } = require('../../config/database');
const {
  serializePublicProduct,
  serializeAdminProduct,
  serializeProductCard,
  serializeVariantAvailability,
  serializeProductAvailability,
} = require('./product.serializer');

/**
 * Roles that may read/write purchase-price information.
 * Role arrives from the authenticated User record (resolveCurrentUser), NOT
 * from JWT claims — a spoofed `role` claim never grants visibility.
 */
const PURCHASE_ACL = Object.freeze([ROLES.ADMIN]);

function isDuplicateKeyError(err) {
  return Boolean(err && err.code === 11000);
}

/**
 * Product business logic (Phase 05, ADR-0013).
 *
 * Owns catalog rules: field allowlist (unknown/immutable/operator keys are
 * rejected), object-id validation, slug generation + collision handling,
 * category-reference validation (create/update require an ACTIVE category),
 * measurement-guide ↔ variant-size consistency, product+initial-variants
 * ATOMIC creation via the injected `runTransaction`, public-vs-admin
 * visibility (purchase price private to ADMIN), and the safe catalog list
 * with allowlisted filters/sort/pagination.
 *
 * Persistence goes through the injected repositories; it never talks to
 * MongoDB or HTTP directly.
 */
class ProductService {
  constructor({
    repository,
    variantService,
    variantRepository,
    categoryRepository,
    inventoryRepository,
    runTransaction = withTransaction,
  }) {
    if (!repository || typeof repository.create !== 'function') {
      throw new Error('ProductService requires a repository');
    }
    if (!variantService || typeof variantService.createVariant !== 'function') {
      throw new Error('ProductService requires a variantService');
    }
    if (!variantRepository || typeof variantRepository.updateById !== 'function') {
      throw new Error('ProductService requires a variantRepository');
    }
    if (!categoryRepository || typeof categoryRepository.findById !== 'function') {
      throw new Error('ProductService requires a categoryRepository');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('ProductService requires a runTransaction function');
    }
    this.repository = repository;
    this.variantService = variantService;
    this.variantRepository = variantRepository;
    this.categoryRepository = categoryRepository;
    // Optional: required only for the PUBLIC availability endpoint.
    this.inventoryRepository = inventoryRepository || null;
    this.runTransaction = runTransaction;
  }

  invalid(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_PRODUCT);
  }

  notFound() {
    return new ApiError(
      404,
      PRODUCT_MESSAGES.PRODUCT_NOT_FOUND,
      ERROR_CODES.PRODUCT_NOT_FOUND
    );
  }

  slugExists() {
    return new ApiError(
      400,
      PRODUCT_MESSAGES.PRODUCT_SLUG_ALREADY_EXISTS,
      ERROR_CODES.PRODUCT_SLUG_ALREADY_EXISTS
    );
  }

  forbidden(message) {
    return new ApiError(
      403,
      message || PRODUCT_MESSAGES.PURCHASE_PRICE_ADMIN_ONLY,
      ERROR_CODES.FORBIDDEN
    );
  }

  isAdmin(role) {
    return PURCHASE_ACL.includes(role);
  }

  assertValidObjectId(id) {
    if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
      throw this.invalid('product id must be a valid 24-character hex ObjectId');
    }
  }

  /**
   * A product can only reference an ACTIVE category (ADR-0012): creating or
   * moving a product into an inactive category is rejected. Inside a
   * transaction the same check runs again with the session snapshot.
   */
  async assertCategoryActive(categoryId, session) {
    const category = await this.categoryRepository.findById(
      categoryId,
      session ? { session } : {}
    );
    if (!category || !category.isActive) {
      throw new ApiError(
        400,
        PRODUCT_MESSAGES.INVALID_CATEGORY,
        ERROR_CODES.INVALID_CATEGORY
      );
    }
    return category;
  }

  async generateUniqueSlug(name) {
    const base = slugify(name);
    if (!base) {
      throw this.invalid('slug could not be derived from the product name');
    }
    let candidate = base;
    let suffix = 2;
    while (await this.repository.existsBySlug(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  async resolveCreateSlug(explicitSlug, name) {
    if (explicitSlug) {
      // Explicit client slug is respected; a collision is rejected. The
      // unique index remains the final guard against a concurrent race.
      const clash = await this.repository.findBySlug(explicitSlug);
      if (clash) {
        throw this.slugExists();
      }
      return explicitSlug;
    }
    return this.generateUniqueSlug(name);
  }

  productSkuExists() {
    return new ApiError(
      400,
      PRODUCT_MESSAGES.PRODUCT_SKU_ALREADY_EXISTS,
      ERROR_CODES.PRODUCT_SKU_ALREADY_EXISTS
    );
  }

  mapDuplicateKeyError(err) {
    const keyPattern = err && err.keyPattern ? err.keyPattern : {};
    if (keyPattern.slug) {
      return this.slugExists();
    }
    if (keyPattern.stockKeepingUnit) {
      return this.productSkuExists();
    }
    return this.invalid(PRODUCT_MESSAGES.INVALID_PRODUCT);
  }

  /**
   * Loads a product's full representation: category summary + variants.
   * Public detail exposes only ACTIVE variants; admin views include inactive
   * variants and purchase-price information.
   */
  async loadFullProduct(doc, { includePurchasePrice = false, includeInactive = false } = {}) {
    const category = doc.categoryId
      ? await this.categoryRepository.findById(String(doc.categoryId))
      : null;
    const variants = await this.variantService.listVariantsForProduct(String(doc._id), {
      includeInactive,
    });
    const serialize = includePurchasePrice ? serializeAdminProduct : serializePublicProduct;
    return serialize(doc, variants, category);
  }

  /**
   * Public storefront listing — ACTIVE products only.
   *
   * Query controls are allowlisted: filters { categoryId, featured, newArrival,
   * bestDeal }, sort { newest, priceAsc, priceDesc, featured }, and 1-indexed
   * page/limit (default 20, max 100). Arbitrary MongoDB expressions never pass
   * through. The response is product cards (no variants/measurement guide) for
   * a fast grid; detail endpoints serve the full product.
   */
  async listProducts({ page, limit, filters, sort } = {}) {
    const query = this.normalizeListQuery({ page, limit, filters, sort });
    const skip = (query.page - 1) * query.limit;

    const [docs, total] = await Promise.all([
      this.repository.findMany(query.filter, {
        sort: query.sort,
        skip,
        limit: query.limit,
      }),
      this.repository.count(query.filter),
    ]);

    const products = [];
    for (const doc of docs) {
      const category = doc.categoryId
        ? await this.categoryRepository.findById(String(doc.categoryId))
        : null;
      products.push(serializeProductCard(doc, category));
    }

    return {
      products,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  normalizeListQuery({ page, limit, filters, sort } = {}) {
    const parsedPage = this.parsePositiveInteger(page, PAGINATION.DEFAULT_PAGE, 'page');
    const parsedLimit = this.parsePositiveInteger(limit, PAGINATION.DEFAULT_LIMIT, 'limit');
    const safeLimit = Math.min(parsedLimit, PAGINATION.MAX_LIMIT);

    const filter = { isActive: true };
    if (filters !== undefined) {
      if (!isPlainObject(filters)) {
        throw this.invalid('filters must be an object');
      }
      const unknown = Object.keys(filters).filter(
        (key) => !PRODUCT_LIST_FILTERS.includes(key)
      );
      if (unknown.length > 0) {
        throw this.invalid(`unknown filter(s): ${unknown.join(', ')}`);
      }
      for (const key of PRODUCT_LIST_FILTERS) {
        if (filters[key] === undefined) {
          continue;
        }
        filter[key] = this.normalizeFilterValue(key, filters[key]);
      }
    }

    let sortSpec;
    switch (sort || PRODUCT_SORTS.NEWEST) {
      case PRODUCT_SORTS.NEWEST:
        sortSpec = { createdAt: -1 };
        break;
      case PRODUCT_SORTS.PRICE_ASC:
        sortSpec = { sellingPrice: 1 };
        break;
      case PRODUCT_SORTS.PRICE_DESC:
        sortSpec = { sellingPrice: -1 };
        break;
      case PRODUCT_SORTS.FEATURED:
        sortSpec = { featured: -1, createdAt: -1 };
        break;
      default:
        throw this.invalid(
          `sort must be one of: ${Object.values(PRODUCT_SORTS).join(', ')}`
        );
    }

    return { page: parsedPage, limit: safeLimit, filter, sort: sortSpec };
  }

  parsePositiveInteger(value, fallback, name) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw this.invalid(`${name} must be a positive integer`);
    }
    return n;
  }

  normalizeFilterValue(key, value) {
    if (key === 'categoryId') {
      if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
        throw this.invalid('categoryId filter must be a valid 24-character hex ObjectId');
      }
      return value;
    }
    // featured / newArrival / bestDeal flags.
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    throw this.invalid(`${key} filter must be "true" or "false"`);
  }

  async getPublicProductById(id) {
    this.assertValidObjectId(id);
    const doc = await this.repository.findById(id);
    if (!doc || !doc.isActive) {
      throw this.notFound();
    }
    return this.loadFullProduct(doc);
  }

  async getPublicProductBySlug(slug) {
    const normalized = slugify(slug);
    if (!normalized) {
      throw this.invalid('product slug is required');
    }
    const doc = await this.repository.findBySlug(normalized);
    if (!doc || !doc.isActive) {
      throw this.notFound();
    }
    return this.loadFullProduct(doc);
  }

  /**
   * PUBLIC storefront availability for a product's ACTIVE variants (the
   * `/products/:id/availability` endpoint). No authentication is required.
   *
   * Only works for an ACTIVE product (inactive → 404, matching the existing
   * product detail behavior). For each ACTIVE variant it exposes exactly what
   * the storefront needs — `availableQuantity` (availableOnlineQuantity =
   * online - reserved, the backend's source of truth) and `isOutOfStock`.
   *
   * A variant WITHOUT an inventory record is treated as out-of-stock; the
   * storefront can never create inventory. Admin-only data (offline stock,
   * movements, reservations, costs, performedBy, internal ids) is never
   * serialized.
   */

  // ------------------ past one ---------------------

  // async getProductAvailability(id) {
  //   this.assertValidObjectId(id);
  //   if (
  //     !this.inventoryRepository ||
  //     typeof this.inventoryRepository.findByProductVariantId !== 'function'
  //   ) {
  //     throw new Error('ProductService requires an inventoryRepository to read availability');
  //   }
  //   const doc = await this.repository.findById(id);
  //   if (!doc || !doc.isActive) {
  //     throw this.notFound();
  //   }
  //   const activeVariants = await this.variantService.listVariantsForProduct(String(doc._id), {
  //     includeInactive: false,
  //   });
  //   const availability = [];
  //   for (const variant of activeVariants) {
  //     const inventory = await this.inventoryRepository.findByProductVariantId(String(variant._id));
  //     availability.push(serializeVariantAvailability(String(variant._id), inventory));
  //   }
  //   return availability;
  // }

  /**
   * PUBLIC storefront availability endpoint (/products/:id/availability).
   *
   * If the product has active variants, computes stock per variant.
   * If the product HAS NO variants (Simple Product), computes stock for the base product.
   */
  async getProductAvailability(id) {
    this.assertValidObjectId(id);
    if (
      !this.inventoryRepository ||
      (typeof this.inventoryRepository.findByProductVariantId !== 'function' &&
        typeof this.inventoryRepository.findByProductId !== 'function')
    ) {
      throw new Error('ProductService requires an inventoryRepository to read availability');
    }

    const doc = await this.repository.findById(id);
    if (!doc || !doc.isActive) {
      throw this.notFound();
    }

    const activeVariants = await this.variantService.listVariantsForProduct(String(doc._id), {
      includeInactive: false,
    });

    // 1. Variant Product Path
    if (activeVariants.length > 0) {
      const availability = [];
      for (const variant of activeVariants) {
        const inventory = await this.inventoryRepository.findByProductVariantId(String(variant._id));
        availability.push(serializeVariantAvailability(String(variant._id), inventory));
      }
      return { product: null, variants: availability };
    }

    // 2. Simple Product Path (No variants)
    const productInventory = await this.inventoryRepository.findByProductId(String(doc._id));
    return {
      product: serializeProductAvailability(String(doc._id), productInventory),
      variants: [],
    };
  }

  /**
   * Creates a product and its INITIAL variants ATOMICALLY (POST, STAFF+ADMIN).
   *
   * - Validates the product payload + every provided variant payload up front.
   * - Requires an ACTIVE category. Variants are OPTIONAL — a product can be
   *   created without any variants (`variants: []` or omitted).
   * - Resolves the slug (explicit or derived from name with `-2` suffix).
   * - Writes the product (+ variants when present) inside ONE MongoDB
   *   transaction; any failure aborts the whole batch (no orphan products or
   *   half-created variants).
   *
   * Purchase price is ACCEPTED on create (staff enter cost data) but the
   * response only ever includes it for ADMIN callers.
   */
  async createProduct(raw, { role = null } = {}) {
    const { value, variants } = validateProductInput(raw);
    const normalizedVariants = (variants || []).map((variant) =>
      this.variantService.validateVariantInput(variant)
    );

    this.variantService.assertGuideMatchesVariantSizes(
      value.measurementGuide || null,
      normalizedVariants
    );
    assertDiscountWithinPrice(value.discount, value.sellingPrice);
    await this.assertCategoryActive(value.categoryId);
    const slug = await this.resolveCreateSlug(value.slug, value.name);

    let result;
    try {
      result = await this.runTransaction(async (session) => {
        // Re-verify the category inside the transaction snapshot.
        await this.assertCategoryActive(value.categoryId, session);
        const payload = { ...value, slug };
        delete payload.variants;
        const product = await this.repository.create(payload, { session });
        const createdVariants = [];
        for (const variant of normalizedVariants) {
          const created = await this.variantService.createVariant({
            productId: String(product._id),
            raw: variant,
            session,
          });
          createdVariants.push(created);
        }
        return { product, createdVariants };
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw this.mapDuplicateKeyError(err);
      }
      throw err;
    }

    return this.loadFullProduct(result.product, {
      includePurchasePrice: this.isAdmin(role),
      includeInactive: true,
    });
  }

  /**
   * PATCH-style update (ADMIN only). Only the provided fields change; omitted
   * fields are preserved. Deactivation is `{ isActive: false }` — there is no
   * DELETE.
   *
   * `variants` (optional) is the FULL replacement spec for the product's
   * variant set, applied atomically:
   * - entry WITH `id` → updates that existing variant (SKU immutable; changing
   *   it is rejected).
   * - entry WITHOUT `id` → creates a new variant.
   * - existing variant NOT referenced by any `id` → deactivated (never
   *   physically deleted).
   *
   * Purchase-price fields on a PATCH are rejected for non-ADMIN callers
   * (defense in depth; the route already restricts PATCH to ADMIN).
   */
  async updateProduct(id, raw, { role = null } = {}) {
    this.assertValidObjectId(id);
    const { value, variants } = validateProductInput(raw, { partial: true });
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw this.notFound();
    }

    // Purchase-price writes require an ADMIN caller.
    if (value.purchasePrice !== undefined && !this.isAdmin(role)) {
      throw this.forbidden();
    }
    if (
      variants &&
      variants.some((variant) => variant.purchasePriceOverride !== undefined) &&
      !this.isAdmin(role)
    ) {
      throw this.forbidden();
    }

    const update = {};
    if (value.name !== undefined) {
      update.name = value.name;
    }
    if (value.slug !== undefined) {
      const clash = await this.repository.findBySlug(value.slug);
      if (clash && String(clash._id) !== String(id)) {
        throw this.slugExists();
      }
      update.slug = value.slug;
    }
    if (value.description !== undefined) {
      update.description = value.description;
    }
    if (value.categoryId !== undefined) {
      // The target category must be ACTIVE, exactly like create.
      await this.assertCategoryActive(value.categoryId);
      update.categoryId = value.categoryId;
    }
    if (value.images !== undefined) {
      update.images = value.images;
    }
    if (value.sellingPrice !== undefined) {
      update.sellingPrice = value.sellingPrice;
    }
    if (value.purchasePrice !== undefined) {
      update.purchasePrice = value.purchasePrice;
    }
    if (value.discount !== undefined) {
      update.discount = value.discount;
    }
    for (const flag of ['featured', 'newArrival', 'bestDeal']) {
      if (value[flag] !== undefined) {
        update[flag] = value[flag];
      }
    }
    if (value.isActive !== undefined) {
      update.isActive = value.isActive;
    }
    if (value.measurementGuide !== undefined) {
      update.measurementGuide = value.measurementGuide;
    }
    // Electronics extensions (accepted on create; persisted here on PATCH).
    if (value.brand !== undefined) {
      update.brand = value.brand;
    }
    if (value.modelNumber !== undefined) {
      update.modelNumber = value.modelNumber;
    }
    if (value.warrantyPeriod !== undefined) {
      update.warrantyPeriod = value.warrantyPeriod;
    }
    if (value.specifications !== undefined) {
      update.specifications = value.specifications;
    }
    // Product-level SKU is optional but globally unique. Uniqueness is
    // enforced against OTHER products only — a product keeps its own SKU
    // without re-checking itself (the admin form always sends the field).
    let skuRetained = false;
    if (value.stockKeepingUnit !== undefined) {
      const currentSku =
        typeof existing.stockKeepingUnit === 'string'
          ? existing.stockKeepingUnit.trim().toUpperCase()
          : null;
      if (value.stockKeepingUnit === currentSku) {
        // Retaining the current SKU is not a collision. Skipping the write also
        // keeps an unchanged save from touching the unique index at all.
        skuRetained = true;
      } else {
        const clash = await this.repository.findOne({
          stockKeepingUnit: value.stockKeepingUnit,
        });
        if (clash && String(clash._id) !== String(id)) {
          throw this.productSkuExists();
        }
        update.stockKeepingUnit = value.stockKeepingUnit;
      }
    } else if (
      raw.stockKeepingUnit === null ||
      (typeof raw.stockKeepingUnit === 'string' && raw.stockKeepingUnit.trim() === '')
    ) {
      // The validator normalizes an empty SKU to undefined; an explicit clear
      // from the admin form must still remove the stored value. Unset instead
      // of storing null so the sparse unique index does not treat every
      // SKU-less product as a duplicate of the others.
      if (existing.stockKeepingUnit !== undefined && existing.stockKeepingUnit !== null) {
        update.$unset = { stockKeepingUnit: 1 };
      }
    }
    if (value.warrantyPeriod === undefined && raw.warrantyPeriod === null) {
      update.warrantyPeriod = null;
    }

    const finalSellingPrice = value.sellingPrice ?? existing.sellingPrice;
    const finalDiscount = value.discount !== undefined ? value.discount : existing.discount;
    assertDiscountWithinPrice(finalDiscount, finalSellingPrice);

    const finalGuide =
      value.measurementGuide !== undefined ? value.measurementGuide : existing.measurementGuide;

    const existingVariants = await this.variantService.listVariantsForProduct(id, {
      includeInactive: true,
    });

    // Resolve the variant replacement spec (null when not provided).
    let replacement = null;
    if (variants) {
      replacement = await this.prepareVariantReplacement(id, variants, existingVariants);
      this.variantService.assertGuideMatchesVariantSizes(
        finalGuide,
        this.computeFinalVariantAttributes(existingVariants, replacement)
      );
    } else if (finalGuide) {
      // Guide changed while variants are untouched — existing sizes must match.
      this.variantService.assertGuideMatchesVariantSizes(finalGuide, existingVariants);
    }

    if (Object.keys(update).length === 0 && !replacement && !skuRetained) {
      throw this.invalid('No valid fields to update');
    }

    let updatedProduct;
    if (Object.keys(update).length === 0 && !replacement) {
      // The only supplied field was the product's existing SKU — a no-op.
      updatedProduct = existing;
    } else {
      try {
        updatedProduct = await this.runTransaction(async (session) => {
          const product = await this.repository.updateById(id, update, { session });
          if (!product) {
            throw this.notFound();
          }
          if (replacement) {
            await this.applyVariantReplacement(id, replacement, existingVariants, session);
          }
          return product;
        });
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw this.mapDuplicateKeyError(err);
        }
        throw err;
      }
    }

    return this.loadFullProduct(updatedProduct, {
      includePurchasePrice: this.isAdmin(role),
      includeInactive: true,
    });
  }

  /**
   * Converts the raw `variants` PATCH payload into an actionable replacement
   * list with every entry validated. Throws on SKU change attempts, duplicate
   * attribute sets, duplicate SKUs, and unknown ids.
   */
  async prepareVariantReplacement(productId, variants, existingVariants) {
    const byId = new Map(existingVariants.map((v) => [String(v._id), v]));
    const seenIds = new Set();
    const replacement = [];

    for (const entry of variants) {
      if (entry && typeof entry === 'object' && entry.id !== undefined) {
        const { id: variantId, ...rest } = entry;
        if (typeof variantId !== 'string' || !OBJECT_ID_PATTERN.test(variantId)) {
          throw this.invalid('variant id must be a valid 24-character hex ObjectId');
        }
        if (seenIds.has(variantId)) {
          throw this.invalid(`duplicate variant id in variants payload: ${variantId}`);
        }
        const target = byId.get(variantId);
        if (!target) {
          throw new ApiError(
            404,
            PRODUCT_MESSAGES.VARIANT_NOT_FOUND,
            ERROR_CODES.VARIANT_NOT_FOUND
          );
        }
        seenIds.add(variantId);

        const norm = this.variantService.validateVariantInput(rest, { partial: true });
        if (norm.sku !== undefined && norm.sku !== target.sku) {
          throw this.invalid('SKU cannot be changed after creation');
        }
        if (norm.sku !== undefined && (await this.variantService.existsBySku(norm.sku))) {
          throw new ApiError(
            400,
            PRODUCT_MESSAGES.VARIANT_SKU_ALREADY_EXISTS,
            ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS
          );
        }
        if (norm.attributes !== undefined) {
          const attributeKey = this.variantService.buildAttributeKey(norm.attributes);
          const duplicate = await this.variantService.existsAttributesForProduct(
            productId,
            attributeKey,
            target._id
          );
          if (duplicate) {
            throw new ApiError(
              400,
              PRODUCT_MESSAGES.VARIANT_DUPLICATE_ATTRIBUTES,
              ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES
            );
          }
        }
        replacement.push({ kind: 'update', id: variantId, norm });
      } else {
        const norm = this.variantService.validateVariantInput(entry);
        if (norm.sku !== undefined && (await this.variantService.existsBySku(norm.sku))) {
          throw new ApiError(
            400,
            PRODUCT_MESSAGES.VARIANT_SKU_ALREADY_EXISTS,
            ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS
          );
        }
        const attributeKey = this.variantService.buildAttributeKey(norm.attributes || {});
        if (await this.variantService.existsAttributesForProduct(productId, attributeKey, null)) {
          throw new ApiError(
            400,
            PRODUCT_MESSAGES.VARIANT_DUPLICATE_ATTRIBUTES,
            ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES
          );
        }
        replacement.push({ kind: 'create', norm });
      }
    }

    return replacement;
  }

  /**
   * The final variant attribute set AFTER the replacement, used to verify
   * measurement-guide ↔ variant-size consistency. Variants being deactivated
   * (not referenced) are excluded.
   */
  computeFinalVariantAttributes(existingVariants, replacement) {
    const keptAttributes = [];
    const byId = new Map(replacement.filter((r) => r.kind === 'update').map((r) => [r.id, r]));

    for (const variant of existingVariants) {
      const entry = byId.get(String(variant._id));
      if (!entry) {
        continue; // deactivated — no longer offered
      }
      keptAttributes.push({
        attributes: entry.norm.attributes !== undefined ? entry.norm.attributes : variant.attributes,
      });
    }
    for (const item of replacement) {
      if (item.kind === 'create') {
        keptAttributes.push({ attributes: item.norm.attributes || {} });
      }
    }
    return keptAttributes;
  }

  async applyVariantReplacement(productId, replacement, existingVariants, session) {
    for (const item of replacement) {
      if (item.kind === 'create') {
        await this.variantService.createVariant({
          productId,
          raw: item.norm,
          session,
        });
      } else {
        const norm = item.norm;
        const patch = {};
        if (norm.sku !== undefined) {
          patch.sku = norm.sku;
        }
        if (norm.attributes !== undefined) {
          patch.attributes = norm.attributes;
          patch.attributeKey = this.variantService.buildAttributeKey(norm.attributes);
        }
        if (norm.sellingPriceOverride !== undefined) {
          patch.sellingPriceOverride = norm.sellingPriceOverride;
        }
        if (norm.purchasePriceOverride !== undefined) {
          patch.purchasePriceOverride = norm.purchasePriceOverride;
        }
        if (norm.isActive !== undefined) {
          patch.isActive = norm.isActive;
        }
        if (Object.keys(patch).length > 0) {
          const updated = await this.variantRepository.updateById(item.id, patch, { session });
          if (!updated) {
            throw new ApiError(
              404,
              PRODUCT_MESSAGES.VARIANT_NOT_FOUND,
              ERROR_CODES.VARIANT_NOT_FOUND
            );
          }
        }
      }
    }

    // Deactivate (never delete) existing variants dropped from the spec.
    const kept = new Set(replacement.filter((r) => r.kind === 'update').map((r) => r.id));
    for (const variant of existingVariants) {
      if (!kept.has(String(variant._id)) && variant.isActive) {
        await this.variantRepository.updateById(
          String(variant._id),
          { isActive: false },
          { session }
        );
      }
    }
  }

  /**
   * Soft-deactivation is the Phase 05 archival mechanism (no DELETE). A thin
   * wrapper over updateProduct for API clarity.
   */
  async deactivateProduct(id, { role = null } = {}) {
    return this.updateProduct(id, { isActive: false }, { role });
  }
}

module.exports = { ProductService, PURCHASE_ACL };

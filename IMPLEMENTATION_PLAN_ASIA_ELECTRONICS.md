# Implementation Plan: Taqwa → Asia Electronics Backend Customization

This plan details all files to be modified to transform the Taqwa e-commerce backend (fashions/jewelry/abayas) into the Asia Electronics backend while preserving all core logic.

## Overview
- **Goal**: Retain core e-commerce structures, patterns, database schemas, and business logic; adapt for electronics retailer
- **Branding**: Taqwa/taqwa-backend/taqwactg.com → Asia Electronics/asia-electronics
- **Product Extensions**: Add `brand`, `model_number`, `warranty_period` (months), `specifications` (JSON), `stock_keeping_unit` (SKU)

---

## Phase 1: Branding & Context Updates

### 1.1 Package Configuration
| File | Changes | Notes |
|------|---------|-------|
| `package.json` | Update `name` from `"taqwa-backend"` to `"asia-electronics-backend"`, `description` from `"Taqwa E-commerce Backend REST API (taqwactg.com)"` to `"Asia Electronics Backend REST API"` | Core package metadata |

### 1.2 Root Documentation
| File | Changes | Notes |
|------|---------|-------|
| `README.md` | Update title from `# Taqwa Backend` to `# Asia Electronics Backend`, update all references to Taqwa/taqwactg.com, update health check example message | Main documentation |
| `.env.example` | Update header comments, example MongoDB DB name if desired, update references to Taqwa | Environment template |

### 1.3 Source Code - Core Application
| File | Changes | Notes |
|------|---------|-------|
| `src/server.js` | Change log prefixes from `[taqwa]` to `[asia-electronics]` in all console.log/error messages (lines ~59, 81, 85, 106, 122, 134, 136) | Startup/shutdown logs |
| `src/config/database.js` | Change log prefixes from `[taqwa]` to `[asia-electronics]` in connection listeners and transaction abort (lines ~75, 79, 83, 87, 180) | DB connection logs |
| `src/routes/health.routes.js` | Change health message from `"Taqwa API is healthy"` to `"Asia Electronics API is healthy"` | Health endpoint response |

### 1.4 Documentation Files
All files under `docs/` need branding updates:
| File | Changes |
|------|---------|
| `docs/architecture.md` | Update title, product name, references to Taqwa/taqwactg.com |
| `docs/api-contract.md` | Update branding references |
| `docs/business-rules.md` | Update branding references |
| `docs/database-schema.md` | Update branding references |
| `docs/rbac-matrix.md` | Update branding references |
| `docs/order-state-machine.md` | Update references if any |
| `docs/payment-state-machine.md` | Update references if any |
| `docs/inventory-state-machine.md` | Update references if any |
| `docs/return-state-machine.md` | Update references if any |
| `docs/refund-state-machine.md` | Update references if any |
| `docs/courier-state-machine.md` | Update references if any |
| `docs/notification-state-machine.md` | Update references if any |
| `docs/phase-10-final-report.md` | Update references if any |
| `docs/decisions/*.md` | Update references to Taqwa/taqwactg.com where applicable |

---

## Phase 2: Electronics Product Extensions

### 2.1 Product Constants
**File:** `src/modules/products/product.constants.js`

Add limits for new fields:
```javascript
const PRODUCT_LIMITS = Object.freeze({
  // ... existing
  BRAND_MAX: 100,
  MODEL_NUMBER_MAX: 100,
  WARRANTY_PERIOD_MIN: 0,
  WARRANTY_PERIOD_MAX: 120, // 10 years
  SPECIFICATIONS_MAX_DEPTH: 10, // for validation
  SKU_MAX: 64, // may already exist in variant, ensure product level
});
```

Add to `PRODUCT_FIELDS` whitelist:
```javascript
const PRODUCT_FIELDS = Object.freeze([
  // ... existing
  'brand',
  'modelNumber',
  'warrantyPeriod',
  'specifications',
  'stockKeepingUnit',
]);
```

### 2.2 Product Model
**File:** `src/modules/products/product.model.js`

Add fields to `productSchema`:
```javascript
brand: {
  type: String,
  trim: true,
  maxlength: PRODUCT_LIMITS.BRAND_MAX,
  default: '',
},
modelNumber: {
  type: String,
  trim: true,
  maxlength: PRODUCT_LIMITS.MODEL_NUMBER_MAX,
  default: '',
},
warrantyPeriod: {
  type: Number,
  min: PRODUCT_LIMITS.WARRANTY_PERIOD_MIN,
  max: PRODUCT_LIMITS.WARRANTY_PERIOD_MAX,
  // warranty period in months
},
specifications: {
  type: Schema.Types.Mixed,
  default: {},
  // JSON metadata object for hardware specs (e.g., {processor: '...', ram: '...', storage: '...'})
},
stockKeepingUnit: {
  type: String,
  trim: true,
  uppercase: true,
  maxlength: PRODUCT_LIMITS.SKU_MAX,
  // Product-level SKU (separate from variant SKUs)
},
```

Add index if needed: `productSchema.index({ stockKeepingUnit: 1 }, { unique: true, sparse: true });`

### 2.3 Product Validation
**File:** `src/modules/products/product.validation.js`

Add normalization functions:
```javascript
function normalizeBrand(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') throw invalid('brand must be a string');
  const brand = raw.trim();
  if (brand.length > PRODUCT_LIMITS.BRAND_MAX) throw invalid(`brand must be at most ${PRODUCT_LIMITS.BRAND_MAX} characters`);
  return brand;
}

function normalizeModelNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') throw invalid('modelNumber must be a string');
  const modelNumber = raw.trim();
  if (modelNumber.length > PRODUCT_LIMITS.MODEL_NUMBER_MAX) throw invalid(`modelNumber must be at most ${PRODUCT_LIMITS.MODEL_NUMBER_MAX} characters`);
  return modelNumber;
}

function normalizeWarrantyPeriod(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Number.isInteger(raw)) throw invalid('warrantyPeriod must be an integer (months)');
  if (raw < PRODUCT_LIMITS.WARRANTY_PERIOD_MIN || raw > PRODUCT_LIMITS.WARRANTY_PERIOD_MAX) {
    throw invalid(`warrantyPeriod must be between ${PRODUCT_LIMITS.WARRANTY_PERIOD_MIN} and ${PRODUCT_LIMITS.WARRANTY_PERIOD_MAX} months`);
  }
  return raw;
}

function normalizeSpecifications(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('specifications must be a JSON object');
  // Basic validation - ensure it's serializable
  try {
    JSON.stringify(raw);
  } catch (e) {
    throw invalid('specifications must be valid JSON');
  }
  return raw;
}

function normalizeStockKeepingUnit(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw invalid('stockKeepingUnit must be a string');
  const sku = raw.trim().toUpperCase();
  if (sku.length === 0) return undefined;
  if (sku.length > PRODUCT_LIMITS.SKU_MAX) throw invalid(`stockKeepingUnit must be at most ${PRODUCT_LIMITS.SKU_MAX} characters`);
  // Allow alphanumeric and hyphens/underscores like variant SKUs
  if (!/^[A-Z0-9][A-Z0-9-_]*$/.test(sku)) throw invalid('stockKeepingUnit contains invalid characters');
  return sku;
}
```

Update `validateProductInput` to handle these fields.

### 2.4 Product Serializer
**File:** `src/modules/products/product.serializer.js`

Ensure new fields are included in serialized output (public and admin views as appropriate). Check if purchasePrice is admin-only - electronics fields like brand/model/specs should be public.

### 2.5 Product Service/Repository/Controller
**Files:** `product.service.js`, `product.repository.js`, `product.controller.js`

Update to pass through new fields. Repository should be fine as it uses generic operations. Service may need updates for validation/business logic. Controller should be fine.

### 2.6 Product Routes (if needed)
**File:** `product.routes.js` - likely no changes needed

### 2.7 Variant Considerations
The requirement says "Expand the core product schemas..." - could also apply to ProductVariant. Review if warranty might be per-variant or product-level (product-level makes sense). SKU - variants already have SKU; product-level SKU might be different (master SKU). Keep both flexible.

---

## Phase 3: Validation & Testing

### 3.1 Verify Core Systems Remain Intact
- **Authentication**: `src/middlewares/authenticate.js`, `src/middlewares/resolveCurrentUser.js`, `src/middlewares/authorizeRoles.js` - no changes needed
- **Ordering Logic**: `src/modules/orders/*` - no changes needed (uses product/variant data)
- **Cart Logic**: `src/modules/cart/*` - no changes needed
- **Payment Processing**: `src/modules/payments/*` - no changes needed
- **Relational Schemas**: All models and relationships remain intact

### 3.2 Run Tests
```bash
npm test
```

### 3.3 Manual Verification
- Check health endpoint
- Verify product creation with new fields
- Ensure existing functionality works

---

## Implementation Order
1. **Start with branding** (less risky, affects many files but straightforward string replacements)
2. **Update product schemas/models/constants/validation** (core data model changes)
3. **Update serializers/services as needed**
4. **Test everything**
5. **Update remaining docs**

---

## Notes
- Preserve all existing behavior - new fields should be optional where reasonable
- SKU on product level: make it optional and unique if provided (sparse index)
- Warranty period in months (integer)
- Specifications as freeform JSON object
- Follow existing code style and patterns exactly
- Don't break existing API contracts for existing fields
- All money handling, transactions, validations must remain unchanged

---

Let us proceed with implementation.
'use strict';

const { validateCategoryInput } = require('./category.validation');
const { CATEGORY_MESSAGES } = require('./category.constants');

/**
 * Thin category controller: validate input, delegate to the service, serialize
 * the response envelope. No MongoDB access, no slug generation, no duplicate
 * detection, no business rules here.
 */
function createCategoryController({ categoryService } = {}) {
  if (
    !categoryService ||
    typeof categoryService.listCategories !== 'function'
  ) {
    throw new Error('createCategoryController requires a categoryService');
  }

  return {
    // GET /api/v1/categories — public, ACTIVE only.
    listCategories: async (req, res) => {
      const categories = await categoryService.listCategories();
      res.status(200).json({
        success: true,
        message: CATEGORY_MESSAGES.LIST_FETCHED,
        data: { categories },
      });
    },

    // GET /api/v1/categories/:id — public, ACTIVE only.
    getCategoryById: async (req, res) => {
      const category = await categoryService.getCategoryById(req.params.id);
      res.status(200).json({
        success: true,
        message: CATEGORY_MESSAGES.CATEGORY_FETCHED,
        data: { category },
      });
    },

    // GET /api/v1/categories/slug/:slug — public, ACTIVE only.
    getCategoryBySlug: async (req, res) => {
      const category = await categoryService.getCategoryBySlug(req.params.slug);
      res.status(200).json({
        success: true,
        message: CATEGORY_MESSAGES.CATEGORY_FETCHED,
        data: { category },
      });
    },

    // POST /api/v1/categories — ADMIN only.
    createCategory: async (req, res) => {
      const { value } = validateCategoryInput(req.body);
      const category = await categoryService.createCategory(value);
      res.status(201).json({
        success: true,
        message: CATEGORY_MESSAGES.CATEGORY_CREATED,
        data: { category },
      });
    },

    // PATCH /api/v1/categories/:id — ADMIN only.
    updateCategory: async (req, res) => {
      const { value } = validateCategoryInput(req.body, { partial: true });
      const category = await categoryService.updateCategory(req.params.id, value);
      res.status(200).json({
        success: true,
        message: CATEGORY_MESSAGES.CATEGORY_UPDATED,
        data: { category },
      });
    },
  };
}

module.exports = { createCategoryController };

'use strict';

const { DELIVERY_ZONES } = require('./order.constants');

/**
 * Delivery zone classification (Phase 07, ADR-0015).
 *
 * `classifyDeliveryZone(address)` is a PURE function (no I/O, no randomness):
 * given a validated delivery address it returns `INSIDE_CHITTAGONG` or
 * `OUTSIDE_CHITTAGONG`. `delivery.zone` is ALWAYS server-derived from this
 * function — a client-supplied `zone` is rejected, never trusted.
 *
 * The boundary rule is centralized HERE so the fee table
 * (`DELIVERY_FEES_MINOR_UNITS` in order.constants.js) can change in one place.
 */

const CHITTAGONG_CITY_ALIASES = Object.freeze([
  'chattogram',
  'chittagong',
  'ctg',
  'chatgaon',
]);

const CHITTAGONG_DISTRICT_ALIASES = Object.freeze([
  'chattogram',
  'chittagong',
  'ctg',
  'chatgaon',
]);

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, ' ');
}

/**
 * Classifies an address into a delivery zone.
 *
 * Decision (Phase 07): an address is INSIDE_CHITTAGONG when its `city` matches
 * a Chittagong alias AND its `district` matches a Chittagong district alias.
 * Everything else is OUTSIDE_CHITTAGONG.
 *
 * @param {object} address - validated address `{ city, district, ... }`.
 * @returns {string} DELIVERY_ZONES.INSIDE_CHITTAGONG | OUTSIDE_CHITTAGONG
 */
function classifyDeliveryZone(address) {
  const city = normalize(address && address.city);
  const district = normalize(address && address.district);
  const cityInside = CHITTAGONG_CITY_ALIASES.includes(city);
  const districtInside = CHITTAGONG_DISTRICT_ALIASES.includes(district);
  if (cityInside && districtInside) {
    return DELIVERY_ZONES.INSIDE_CHITTAGONG;
  }
  return DELIVERY_ZONES.OUTSIDE_CHITTAGONG;
}

module.exports = { classifyDeliveryZone };

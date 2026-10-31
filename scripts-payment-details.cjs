'use strict';

const { connectDatabase, disconnectDatabase } = require('./src/config/database');
const PaymentMethod = require('./src/modules/payments/paymentMethod.model');

/**
 * Installs the real customer-facing manual-payment details on the live
 * database, replacing the DEV placeholder PaymentMethod documents.
 *
 * Idempotent: re-running overwrites the same methods with the same values.
 * MANUAL (the generic legacy method) is soft-deactivated (isActive: false) so
 * no placeholder remains customer-facing while past payments keep their
 * snapshot. Deactivation is always soft per ADR-0016.
 */

const METHODS = [
  {
    code: 'BKASH',
    displayName: 'bKash',
    sortOrder: 10,
    metadata: {
      accountName: 'TAQWA',
      accountNumber: '+880 16 2670 6941',
      accountType: 'Personal',
      instructions: 'Send the exact total to the bKash number above (Personal), then submit your transaction ID (TrxID) as payment proof at checkout.',
    },
  },
  {
    code: 'BANK_TRANSFER',
    displayName: 'Bank Transfer',
    sortOrder: 20,
    metadata: {
      accountName: 'TAQWA',
      accountNumber: '4101-781713-000',
      bankName: 'AB Bank Limited',
      branch: 'Agrabad',
      district: 'Chittagong',
      instructions: 'Send the exact total to the AB Bank account above, then submit your transfer reference or a copy of the slip as payment proof at checkout.',
    },
  },
];

async function main() {
  await connectDatabase();

  for (const method of METHODS) {
    const saved = await PaymentMethod.findOneAndUpdate(
      { code: method.code },
      { $set: method },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );
    console.log(
      `PAYMENT-DETAILS-UPSERT code=${saved.code} displayName=${saved.displayName} sortOrder=${saved.sortOrder} isActive=${saved.isActive}`
    );
  }

  const manual = await PaymentMethod.findOneAndUpdate(
    { code: 'MANUAL' },
    { $set: { isActive: false, displayName: 'Manual Payment', metadata: {} } },
    { returnDocument: 'after', runValidators: true }
  );
  if (manual) {
    console.log(
      `PAYMENT-DETAILS-DEACTIVATE code=${manual.code} displayName=${manual.displayName} isActive=${manual.isActive}`
    );
  } else {
    console.log('PAYMENT-DETAILS-MANUAL-MISSING (nothing to deactivate)');
  }

  const all = await PaymentMethod.find({}).sort({ sortOrder: 1, code: 1 });
  console.log(`PAYMENT-DETAILS-TOTAL methods=${all.length}`);
  const placeholderPattern = /placeholder|\(dev/i;
  for (const doc of all) {
    const fields = [doc.displayName, doc.metadata && doc.metadata.accountName, doc.metadata && doc.metadata.accountNumber]
      .filter(Boolean)
      .join(' | ');
    if (placeholderPattern.test(fields)) {
      console.warn(`PAYMENT-DETAILS-PLACEHOLDER-REMAINING code=${doc.code} ${fields}`);
    } else {
      console.log(
        `PAYMENT-DETAILS-OK code=${doc.code} isActive=${doc.isActive} displayName=${doc.displayName} accountNumber=${doc.metadata ? doc.metadata.accountNumber : null}`
      );
    }
  }

  await disconnectDatabase();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('PAYMENT-DETAILS-ERR', err);
  await disconnectDatabase();
  process.exit(1);
});

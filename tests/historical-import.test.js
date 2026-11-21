process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-history-test-secret-at-least-32-characters';

const { validateSources } = require('../src/modules/historical/validation');
const { loadSources, importHistorical } = require('../scripts/import-historical');

describe('Original Data Analyst historical dataset', () => {
  it('validates source IDs, totals, payment references and original status values', () => {
    const checked = validateSources(loadSources());
    expect(checked.summary.rows).toEqual({
      bookings: 500, guests: 431, payments: 500, 'service-requests': 500,
    });
    expect(checked.summary.distinctGuestIds).toBe(171);
    expect(checked.summary.conflictingGuestIds).toBe(135);
    expect(checked.summary.verifiedGatewayPayments).toBe(0);
    expect(checked.summary.importedLoyaltyPoints).toBe(0);
    expect(checked.summary.historicalPaymentStatuses).toEqual({
      Successful: 379, Refunded: 37, Failed: 42, Pending: 42,
    });
    expect(checked.rows.length).toBe(1931);
    const sameGuest = checked.rows.filter(row => row.source === 'guests' && row.sourceId === 'G0008');
    expect(sameGuest.length).toBeGreaterThan(1);
    expect(new Set(sameGuest.map(row => row.rowKey)).size).toBe(sameGuest.length);
    expect(new Set(checked.rows.map(row => row.source + ':' + row.rowKey)).size).toBe(1931);
    expect(checked.rows.filter(row => row.source === 'payments')[0].payload.Payment_Status).toBe('Successful');
  });

  it('rejects malformed and mismatched original rows without altering the source JSON', () => {
    const sources = loadSources();
    const wrongMoney = { ...sources, bookings: sources.bookings.map((row, index) =>
      index === 0 ? { ...row, Total_Revenue_NGN: row.Total_Revenue_NGN + 1 } : row) };
    expect(() => validateSources(wrongMoney)).toThrow('Booking dates and revenue must reconcile');
    const wrongGateway = { ...sources, payments: sources.payments.map((row, index) =>
      index === 0 ? { ...row, Payment_Status: 'Pending' } : row) };
    expect(() => validateSources(wrongGateway)).toThrow('booking/payment source values disagree');
    const repeatedPaymentId = { ...sources, payments: sources.payments.map((row, index) =>
      index === 1 ? { ...row, Payment_ID: sources.payments[0].Payment_ID } : row) };
    expect(() => validateSources(repeatedPaymentId)).toThrow('duplicate source ID');
    expect(sources.bookings[0].Total_Revenue_NGN).toBe(70644);
  });

  it('defaults to dry-run and imports each original row once without replacing anything', async () => {
    const map = new Map();
    const model = {
      find: jest.fn(({ source }) => ({
        select: () => ({
          lean: async () => [...map.values()].filter(item => item.source === source).map(item => ({ rowKey: item.rowKey, hash: item.hash })),
        }),
      })),
      bulkWrite: jest.fn(async updates => {
        let count = 0;
        for (const { updateOne: item } of updates) {
          const key = item.filter.source + ':' + item.filter.rowKey;
          if (!map.has(key)) { map.set(key, item.update.$setOnInsert); count++; }
        }
        return { upsertedCount: count };
      }),
    };
    const preview = await importHistorical({ model });
    expect(preview).toMatchObject({ mode: 'dry-run', inserted: 0, distinctGuestIds: 171, conflictingGuestIds: 135 });
    expect(map.size).toBe(0);
    const imported = await importHistorical({ model, apply: true });
    expect(imported).toMatchObject({ mode: 'applied', inserted: 1931, alreadyPresent: 0 });
    const again = await importHistorical({ model, apply: true });
    expect(again).toMatchObject({ inserted: 0, alreadyPresent: 1931 });
    expect(map.size).toBe(1931);
    expect(model.bulkWrite).toHaveBeenCalled();
  });

  it('stops if an earlier import has a changed payload hash', async () => {
    const model = {
      find: () => ({ select: () => ({ lean: async () => [{ rowKey: 'B0001', hash: 'f'.repeat(64) }] }) }),
      bulkWrite: jest.fn(),
    };
    await expect(importHistorical({ model, apply: true })).rejects.toThrow('source record changed');
    expect(model.bulkWrite).not.toHaveBeenCalled();
  });
});

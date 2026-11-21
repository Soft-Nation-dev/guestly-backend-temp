process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-integration-test';
process.env.JWT_SECRET = 'integration-test-secret-at-least-32-characters';

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../src/app');
const Historical = require('../src/modules/historical/model');
const Booking = require('../src/modules/bookings/model');
const Payment = require('../src/modules/payments/model');
const { importHistorical } = require('../scripts/import-historical');

jest.setTimeout(180000);

let replicaSet;

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replicaSet.getUri(), { dbName: 'guestly-integration' });
  await Promise.all([Historical.init(), Booking.init(), Payment.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

describe('MongoDB deployment checks', () => {
  it('keeps readiness unavailable until the real database is connected', async () => {
    const response = await request(app).get('/ready');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { status: 'ready', database: 'connected' },
    });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    expect(hello.setName).toBeTruthy();
  });

  it('preserves every historical row and stays safe when an import is repeated', async () => {
    const dryRun = await importHistorical();
    expect(dryRun).toMatchObject({
      mode: 'dry-run', inserted: 0, distinctGuestIds: 171, conflictingGuestIds: 135,
    });
    expect(await Historical.countDocuments()).toBe(0);
    const first = await importHistorical({ apply: true });
    expect(first).toMatchObject({ mode: 'applied', inserted: 1931, alreadyPresent: 0 });
    expect(await Historical.countDocuments()).toBe(1931);
    const repeated = await importHistorical({ apply: true });
    expect(repeated).toMatchObject({ inserted: 0, alreadyPresent: 1931 });
    expect(await Historical.countDocuments({ source: 'guests' })).toBe(431);
    expect(await Historical.countDocuments({ source: 'payments' })).toBe(500);
    expect(await Historical.countDocuments()).toBe(1931);
  });

  it('commits booking and payment changes together and enforces the payment index', async () => {
    const guest = new mongoose.Types.ObjectId();
    const room = new mongoose.Types.ObjectId();
    const booking = await Booking.create({
      guest, room, requestId: 'group8-transaction-check',
      roomSlug: 'standard-cozy-haven', roomName: 'Standard Cozy Haven',
      guestName: 'Test Guest', checkIn: '2026-12-01', checkOut: '2026-12-03',
      guests: 1, nightlyRate: 55000, totalAmount: 11000000, currency: 'NGN',
      status: 'pending', expiresAt: new Date(Date.now() + 600000),
    });
    const payment = await Payment.create({
      booking: booking._id, guest, reference: 'GST-GROUP8-TEST-01',
      amount: booking.totalAmount, currency: 'NGN', status: 'pending',
    });
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Booking.updateOne(
          { _id: booking._id, status: 'pending' },
          { $set: { status: 'confirmed', payment: payment._id } },
          { session },
        );
        await Payment.updateOne(
          { _id: payment._id, status: 'pending' },
          { $set: { status: 'success' } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    expect((await Booking.findById(booking._id)).status).toBe('confirmed');
    expect((await Payment.findById(payment._id)).status).toBe('success');
    await expect(Payment.create({
      booking: booking._id, guest, reference: 'GST-GROUP8-TEST-02',
      amount: booking.totalAmount, currency: 'NGN', status: 'success',
    })).rejects.toThrow(/E11000/);
  });
});

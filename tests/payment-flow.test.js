process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-payment-test-secret-at-least-32-characters';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_secret_key';
process.env.PAYSTACK_CALLBACK_URL = 'https://soft-nation-dev.github.io/guestly/payment/return';

jest.mock('../src/modules/users/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/payments/model', () => ({
  findOne: jest.fn(), findOneAndUpdate: jest.fn(), exists: jest.fn(),
  create: jest.fn(), updateOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../src/modules/bookings/model', () => ({
  findById: jest.fn(), updateOne: jest.fn(), findOne: jest.fn(),
}));
jest.mock('../src/modules/payments/paystack', () => ({
  verifyWebhookSignature: jest.fn(),
  generateReference: jest.fn(),
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  createRefund: jest.fn(),
}));
jest.mock('../src/modules/auditlogs/service', () => ({ record: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../src/app');
const Payment = require('../src/modules/payments/model');
const Booking = require('../src/modules/bookings/model');
const User = require('../src/modules/users/model');
const paystack = require('../src/modules/payments/paystack');

const guestId = '507f1f77bcf86cd799439011';
const bookingId = '507f1f77bcf86cd799439033';
const paymentId = '507f1f77bcf86cd799439044';
const reference = 'GST-123456789-abcdef';
const session = { withTransaction: jest.fn(), endSession: jest.fn(async () => {}) };
const token = role => 'Bearer ' + jwt.sign({ id: guestId, role, sessionVersion: 0 }, process.env.JWT_SECRET);
const active = role => ({ _id: guestId, role, isActive: true, sessionVersion: 0, firstName: 'Alex', lastName: 'Morgan', email: 'guest@guestly.test' });

function booking() {
  return {
    _id: bookingId, guest: guestId, status: 'pending', totalAmount: 11000000, currency: 'NGN',
    expiresAt: new Date(Date.now() + 600000),
  };
}
function payment(status = 'pending') {
  return {
    _id: paymentId, booking: bookingId, guest: guestId, reference, amount: 11000000,
    currency: 'NGN', status, refundStatus: 'none', authorizationUrl: '', save: jest.fn(async () => {}),
  };
}
function verified(amount = 11000000) {
  return { status: 'success', amount, currency: 'NGN', reference, paid_at: new Date().toISOString(), channel: 'card' };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
  session.withTransaction.mockImplementation(async callback => callback());
  User.findById.mockResolvedValue(active('guest'));
  Booking.findById.mockResolvedValue(booking());
  Booking.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Payment.findOne.mockResolvedValue(payment());
  Payment.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Payment.exists.mockResolvedValue(false);
  Payment.findOneAndUpdate.mockResolvedValue(null);
  Payment.create.mockResolvedValue(payment());
  paystack.generateReference.mockReturnValue(reference);
  paystack.initializeTransaction.mockResolvedValue({ reference, authorization_url: 'https://checkout.paystack.com/fixture' });
  paystack.verifyTransaction.mockResolvedValue(verified());
  paystack.createRefund.mockResolvedValue({ status: 'pending', reference: 'REF-TEST' });
  paystack.verifyWebhookSignature.mockReturnValue(true);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('Paystack booking payments', () => {
  it('prevents unauthenticated users and wrong roles from initializing payment', async () => {
    expect((await request(app).post('/api/v1/payments/initialize').send({ bookingId })).status).toBe(401);
    User.findById.mockResolvedValue(active('manager'));
    expect((await request(app).post('/api/v1/payments/initialize').set('Authorization', token('manager')).send({ bookingId })).status).toBe(403);
  });

  it('initializes using the saved booking total in kobo and configured callback URL', async () => {
    Payment.findOne.mockReturnValue({ sort: jest.fn().mockResolvedValue(null) });
    const response = await request(app).post('/api/v1/payments/initialize')
      .set('Authorization', token('guest')).send({ bookingId });
    expect(response.status).toBe(200);
    expect(response.body.data.amount).toBe(11000000);
    expect(paystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({
      email: 'guest@guestly.test', amount: 11000000, reference,
      callbackUrl: 'https://soft-nation-dev.github.io/guestly/payment/return',
    }));
    expect(Booking.updateOne).toHaveBeenCalledWith(
      { _id: bookingId, status: 'pending' }, { $set: { latestPaymentReference: reference } },
    );
  });

  it('never initializes another guest’s booking or an expired hold', async () => {
    Booking.findById.mockResolvedValue({ ...booking(), guest: paymentId });
    expect((await request(app).post('/api/v1/payments/initialize').set('Authorization', token('guest')).send({ bookingId })).status).toBe(403);
    Booking.findById.mockResolvedValue({ ...booking(), expiresAt: new Date(0) });
    expect((await request(app).post('/api/v1/payments/initialize').set('Authorization', token('guest')).send({ bookingId })).status).toBe(409);
  });

  it('rejects unsigned webhooks and never confirms unverified charges', async () => {
    paystack.verifyWebhookSignature.mockReturnValue(false);
    expect((await request(app).post('/api/v1/payments/webhook').set('Content-Type', 'application/json').send({ event: 'charge.success' })).status).toBe(401);
    paystack.verifyWebhookSignature.mockReturnValue(true);
    paystack.verifyTransaction.mockResolvedValue(verified(20));
    const changed = await request(app).post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json').send({ event: 'charge.success', data: { reference } });
    expect(changed.status).toBe(200);
    expect(Payment.updateOne).toHaveBeenCalledWith(expect.any(Object), { $set: { status: 'review_required' } });
    expect(Booking.updateOne).not.toHaveBeenCalled();
  });

  it('confirms only holds that are still active after verifying Paystack', async () => {
    const result = await request(app).post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json').send({ event: 'charge.success', data: { reference } });
    expect(result.status).toBe(200);
    expect(paystack.verifyTransaction).toHaveBeenCalledWith(reference);
    expect(Booking.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: bookingId, status: 'pending', expiresAt: { $gt: expect.any(Date) } }),
      { $set: { status: 'confirmed', payment: paymentId } },
      { session },
    );
    expect(Payment.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'success' }) }),
      { session },
    );
  });

  it('flags late payments and duplicate successful charges for refund instead of booking', async () => {
    Booking.updateOne.mockResolvedValue({ modifiedCount: 0 });
    const result = await request(app).post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json').send({ event: 'charge.success', data: { reference } });
    expect(result.status).toBe(200);
    expect(Payment.updateOne).toHaveBeenCalledWith(
      expect.any(Object), expect.objectContaining({ $set: expect.objectContaining({ status: 'refund_required' }) }),
      { session },
    );
    Payment.findOne.mockResolvedValue(payment('success'));
    await request(app).post('/api/v1/payments/webhook').set('Content-Type', 'application/json')
      .send({ event: 'charge.success', data: { reference } });
    expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
  });

  it('protects payment status and manager refund requests', async () => {
    Payment.findOne.mockResolvedValue(payment('refund_required'));
    const own = await request(app).get('/api/v1/payments/' + reference + '/status').set('Authorization', token('guest'));
    expect(own.status).toBe(200);
    expect(own.body.data.needsRefund).toBe(true);
    Payment.findOne.mockResolvedValue({ ...payment('refund_required'), guest: bookingId });
    expect((await request(app).get('/api/v1/payments/' + reference + '/status').set('Authorization', token('guest'))).status).toBe(404);
    expect((await request(app).post('/api/v1/payments/' + reference + '/refund').set('Authorization', token('guest'))).status).toBe(403);
    User.findById.mockResolvedValue(active('manager'));
    Payment.findOneAndUpdate.mockResolvedValue(payment('refund_required'));
    const refund = await request(app).post('/api/v1/payments/' + reference + '/refund').set('Authorization', token('manager'));
    expect(refund.status).toBe(200);
    expect(paystack.createRefund).toHaveBeenCalledWith(reference);
  });

  it('marks refund webhook states without changing booking confirmation', async () => {
    Payment.findOne.mockResolvedValue({ ...payment('refund_required'), refundStatus: 'pending' });
    const changed = await request(app).post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json').send({ event: 'refund.processed', data: { transaction: { reference } } });
    expect(changed.status).toBe(200);
    expect(Payment.updateOne).toHaveBeenCalledWith(
      expect.any(Object), { $set: { refundStatus: 'processed', status: 'refunded' } },
    );
    expect(Booking.updateOne).not.toHaveBeenCalled();
  });

  it('does not confirm a booking from a failed transaction', async () => {
    paystack.verifyTransaction.mockResolvedValue({ status: 'failed', reference });
    const result = await request(app).post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json').send({ event: 'charge.success', data: { reference } });
    expect(result.status).toBe(200);
    expect(Booking.updateOne).not.toHaveBeenCalled();
  });
});

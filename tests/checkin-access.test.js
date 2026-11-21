process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-checkin-test-secret-at-least-32-characters';
process.env.CHECKIN_DOCUMENT_KEY = Buffer.alloc(32, 7).toString('base64');

jest.mock('../src/modules/users/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/bookings/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/checkins/model', () => ({
  create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(),
  find: jest.fn(), countDocuments: jest.fn(), updateMany: jest.fn(),
}));
jest.mock('../src/modules/roomkeys/model', () => ({ create: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/modules/auditlogs/service', () => ({ record: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const User = require('../src/modules/users/model');
const Booking = require('../src/modules/bookings/model');
const CheckIn = require('../src/modules/checkins/model');
const RoomKey = require('../src/modules/roomkeys/model');
const { encryptDocument, decryptDocument, validImage } = require('../src/modules/checkins/documents');
const { getAccess } = require('../src/modules/roomkeys/service');
const { purgeDocuments } = require('../src/jobs/purgeCheckinDocuments');

const id = '507f1f77bcf86cd799439011';
const bookingId = '507f1f77bcf86cd799439022';
const checkinId = '507f1f77bcf86cd799439033';
const png = Buffer.from('89504e470d0a1a0a123456789abcdef0', 'hex');
const actor = role => ({ _id: id, role, firstName: 'Amina', lastName: 'Bello', isActive: true, sessionVersion: 0 });
const token = role => 'Bearer ' + jwt.sign({ id, role, sessionVersion: 0 }, process.env.JWT_SECRET);

function booking(status = 'confirmed') {
  return { _id: bookingId, guest: id, status, roomName: 'Standard Cozy Haven',
    checkIn: '2026-11-21', checkOut: '2099-01-05' };
}
function checkin(status = 'pending') {
  return {
    _id: checkinId, booking: bookingId, guest: id, guestName: 'Amina Bello',
    roomName: 'Standard Cozy Haven', checkIn: '2026-11-21', checkOut: '2099-01-05',
    status, arrivalTime: '14:00', documentKind: 'Passport',
    submittedAt: new Date(), reviewedAt: new Date('2026-11-21T14:00:00Z'),
    reviewNote: '', history: [{ status, at: new Date(), actor: id }],
  };
}
const session = { withTransaction: jest.fn(async fn => fn()), endSession: jest.fn(async () => {}) };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
  session.withTransaction.mockImplementation(async fn => fn());
  User.findById.mockResolvedValue(actor('guest'));
  Booking.findById.mockResolvedValue(booking());
  CheckIn.findOne.mockResolvedValue(null);
  CheckIn.create.mockImplementation(async data => ({ ...data, _id: checkinId }));
  CheckIn.findOneAndUpdate.mockResolvedValue(checkin('approved'));
  CheckIn.find.mockImplementation(() => ({ sort: () => ({ skip: () => ({ limit: async () => [] }) }) }));
  CheckIn.countDocuments.mockResolvedValue(0);
  CheckIn.updateMany.mockResolvedValue({ modifiedCount: 2 });
  RoomKey.create.mockResolvedValue([]);
  RoomKey.findOne.mockImplementation(() => ({ select: jest.fn().mockResolvedValue({ nonce: '123abc' }) }));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('Encrypted check-in and simulated access', () => {
  it('encrypts images and rejects MIME spoofing or corrupted authentication tags', () => {
    const file = { mimetype: 'image/png', buffer: png, size: png.length };
    expect(validImage(file)).toBe(true);
    expect(validImage({ ...file, mimetype: 'image/jpeg' })).toBe(false);
    const encrypted = encryptDocument(file);
    expect(encrypted.documentEncrypted.equals(png)).toBe(false);
    expect(decryptDocument(encrypted)).toEqual(png);
    encrypted.documentTag[0] ^= 1;
    expect(() => decryptDocument(encrypted)).toThrow();
  });

  it('requires a confirmed guest booking, validates files and never returns encrypted bytes', async () => {
    const url = '/api/v1/checkins';
    const upload = () => request(app).post(url).set('Authorization', token('guest'))
      .field('bookingId', bookingId).field('arrivalTime', '14:00').field('documentKind', 'Passport');
    const created = await upload().attach('document', png, { filename: 'test.png', contentType: 'image/png' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ bookingId, status: 'pending', documentAvailable: true });
    expect(JSON.stringify(created.body)).not.toMatch(/documentEncrypted|documentIv|documentTag|documentMime|nonce/);
    expect(CheckIn.create).toHaveBeenCalledWith(expect.objectContaining({
      documentEncrypted: expect.any(Buffer), documentDeleteAt: expect.any(Date),
    }));
    Booking.findById.mockResolvedValue(booking('pending'));
    expect((await upload().attach('document', png, { filename: 'test.png', contentType: 'image/png' })).status).toBe(409);
    Booking.findById.mockResolvedValue(booking());
    expect((await upload().attach('document', Buffer.from('bad'), { filename: 'bad.png', contentType: 'image/png' })).status).toBe(400);
    expect((await upload().attach('document', Buffer.alloc(2 * 1024 * 1024 + 1), { filename: 'big.png', contentType: 'image/png' })).status).toBe(413);
    User.findById.mockResolvedValue(actor('staff'));
    expect((await request(app).post(url).set('Authorization', token('staff')).send({})).status).toBe(403);
  });

  it('permits resubmission after rejection but not overwriting pending documents', async () => {
    const upload = () => request(app).post('/api/v1/checkins').set('Authorization', token('guest'))
      .field('bookingId', bookingId).field('arrivalTime', '15:00').field('documentKind', 'Passport')
      .attach('document', png, { filename: 'test.png', contentType: 'image/png' });
    CheckIn.findOne.mockResolvedValue(checkin('pending'));
    expect((await upload()).status).toBe(409);
    CheckIn.findOne.mockResolvedValue(checkin('rejected'));
    CheckIn.findOneAndUpdate.mockResolvedValue(checkin('pending'));
    expect((await upload()).status).toBe(201);
    expect(CheckIn.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ $push: expect.any(Object) }),
      expect.objectContaining({ runValidators: true }),
    );
  });

  it('restricts staff review, requires rejection reasons and atomically issues a simulation nonce', async () => {
    const url = '/api/v1/checkins/' + bookingId + '/review';
    expect((await request(app).patch(url).set('Authorization', token('guest')).send({ approved: true })).status).toBe(403);
    User.findById.mockResolvedValue(actor('staff'));
    expect((await request(app).patch(url).set('Authorization', token('staff')).send({ approved: false, note: '' })).status).toBe(400);
    expect((await request(app).patch(url).set('Authorization', token('staff')).send({ approved: false, note: 'Upload a clearer ID' })).status).toBe(200);
    expect(RoomKey.create).not.toHaveBeenCalled();
    const approved = await request(app).patch(url).set('Authorization', token('staff')).send({ approved: true, note: '' });
    expect(approved.status).toBe(200);
    expect(RoomKey.create).toHaveBeenCalledWith(
      [expect.objectContaining({ booking: bookingId, nonce: expect.any(String) })],
      { session },
    );
    expect(JSON.stringify(approved.body)).not.toContain('nonce');
    expect(session.endSession).toHaveBeenCalled();
  });

  it('protects ID document downloads using private no-store attachment headers', async () => {
    const url = '/api/v1/checkins/' + bookingId + '/document';
    expect((await request(app).get(url).set('Authorization', token('guest'))).status).toBe(403);
    User.findById.mockResolvedValue(actor('staff'));
    const encrypted = encryptDocument({ mimetype: 'image/png', buffer: png, size: png.length });
    CheckIn.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue({ ...checkin(), ...encrypted }) });
    const result = await request(app).get(url).set('Authorization', token('staff'));
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['content-disposition']).toContain('attachment');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never exposes codes before approval, before stay or after checkout', async () => {
    const user = actor('guest');
    CheckIn.findOne.mockResolvedValue(checkin('pending'));
    expect((await getAccess(bookingId, user, new Date('2026-11-23T15:00:00Z'))).code).toBeNull();
    CheckIn.findOne.mockResolvedValue(checkin('rejected'));
    expect((await getAccess(bookingId, user, new Date('2026-11-23T15:00:00Z'))).status).toBe('unavailable');
    CheckIn.findOne.mockResolvedValue(checkin('approved'));
    const early = await getAccess(bookingId, user, new Date('2026-11-21T11:00:00Z'));
    expect(early.code).toBeNull();
    const active = await getAccess(bookingId, user, new Date('2026-11-23T15:00:00Z'));
    expect(active).toMatchObject({ status: 'active', simulated: true });
    expect(active.code).toMatch(/^SIM-[0-9A-F]{8}$/);
    const expired = await getAccess(bookingId, user, new Date('2099-01-06T12:00:00Z'));
    expect(expired).toMatchObject({ status: 'expired', code: null });
    Booking.findById.mockResolvedValue({ ...booking(), guest: checkinId });
    await expect(getAccess(bookingId, user)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('protects the room-key endpoint from staff and other guests', async () => {
    const path = '/api/v1/roomkeys/' + bookingId;
    expect((await request(app).get(path)).status).toBe(401);
    User.findById.mockResolvedValue(actor('staff'));
    expect((await request(app).get(path).set('Authorization', token('staff'))).status).toBe(403);
    User.findById.mockResolvedValue(actor('guest'));
    Booking.findById.mockResolvedValue({ ...booking(), guest: checkinId });
    expect((await request(app).get(path).set('Authorization', token('guest'))).status).toBe(404);
    Booking.findById.mockResolvedValue(booking());
    CheckIn.findOne.mockResolvedValue(checkin('pending'));
    const result = await request(app).get(path).set('Authorization', token('guest'));
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ code: null, status: 'unavailable', simulated: true });
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it('never creates an access key on a repeated approval', async () => {
    User.findById.mockResolvedValue(actor('staff'));
    CheckIn.findOneAndUpdate.mockResolvedValue(null);
    const result = await request(app).patch('/api/v1/checkins/' + bookingId + '/review')
      .set('Authorization', token('staff')).send({ approved: true, note: '' });
    expect(result.status).toBe(409);
    expect(RoomKey.create).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
  });

  it('purges encrypted bytes but keeps the check-in status and audit history', async () => {
    expect(await purgeDocuments()).toBe(2);
    const update = CheckIn.updateMany.mock.calls[0][1];
    expect(update.$unset).toHaveProperty('documentEncrypted');
    expect(update.$unset).not.toHaveProperty('history');
    expect(update.$set.documentDeletedAt).toBeInstanceOf(Date);
  });
});

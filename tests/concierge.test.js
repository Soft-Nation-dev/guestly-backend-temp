process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-concierge-tests-secret-at-least-32-characters';

jest.mock('../src/modules/users/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/concierge/model', () => ({
  create: jest.fn(), find: jest.fn(), countDocuments: jest.fn(), exists: jest.fn(), aggregate: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/modules/users/model');
const Message = require('../src/modules/concierge/model');

const guestId = '507f1f77bcf86cd799439011';
const otherGuest = '507f1f77bcf86cd799439077';
const staffId = '507f1f77bcf86cd799439012';
const managerId = '507f1f77bcf86cd799439013';
const messageId = '507f1f77bcf86cd799439033';
const person = role => ({
  _id: role === 'guest' ? guestId : role === 'manager' ? managerId : staffId, role,
  firstName: role === 'guest' ? 'Alex' : 'Amina',
  lastName: role === 'guest' ? 'Morgan' : 'Bello',
  isActive: true, sessionVersion: 0,
});
const token = role => 'Bearer ' + jwt.sign({ id: person(role)._id, role, sessionVersion: 0 }, process.env.JWT_SECRET);
const message = (sender = 'guest') => ({
  _id: messageId, guest: guestId, guestName: 'Alex Morgan', sender,
  senderName: sender === 'guest' ? 'Alex Morgan' : 'Amina Bello',
  text: 'Can you help with my arrival?', createdAt: new Date(),
});

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockImplementation(async id => String(id) === guestId ? person('guest') : String(id) === managerId ? person('manager') : person('staff'));
  Message.create.mockImplementation(async data => ({ ...data, _id: messageId, createdAt: new Date() }));
  Message.exists.mockResolvedValue({ _id: messageId });
  Message.find.mockReturnValue({ sort: () => ({ skip: () => ({ limit: async () => [message()] }) }) });
  Message.countDocuments.mockResolvedValue(1);
  Message.aggregate.mockResolvedValue([{ items: [{
    _id: guestId, guestName: 'Alex Morgan', sender: 'guest',
    lastText: 'Can you help with my arrival?', updatedAt: new Date(),
  }], total: [{ value: 1 }] }]);
});

describe('Group 6 human concierge', () => {
  it('requires login, trims messages, prevents role spoofing and restricts sender roles', async () => {
    expect((await request(app).get('/api/v1/concierge/me')).status).toBe(401);
    expect((await request(app).post('/api/v1/concierge/me').send({ text: 'hello' })).status).toBe(401);
    expect((await request(app).post('/api/v1/concierge/me').set('Authorization', token('staff')).send({ text: 'hello' })).status).toBe(403);
    expect((await request(app).post('/api/v1/concierge/me').set('Authorization', token('guest')).send({ text: '   ' })).status).toBe(400);
    expect((await request(app).post('/api/v1/concierge/me').set('Authorization', token('guest')).send({ text: 'Hello', sender: 'staff' })).status).toBe(400);
    const sent = await request(app).post('/api/v1/concierge/me').set('Authorization', token('guest')).send({ text: '  Hello there  ' });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ guestId, sender: 'guest', text: 'Hello there' });
    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({ guest: guestId, sender: 'guest', text: 'Hello there' }));
  });

  it('guests see only their own messages while staff use the protected inbox', async () => {
    const mine = await request(app).get('/api/v1/concierge/me?limit=10').set('Authorization', token('guest'));
    expect(mine.status).toBe(200);
    expect(Message.find).toHaveBeenCalledWith({ guest: guestId });
    expect((await request(app).get('/api/v1/concierge/conversations').set('Authorization', token('guest'))).status).toBe(403);
    expect((await request(app).get('/api/v1/concierge/' + otherGuest).set('Authorization', token('guest'))).status).toBe(403);
    expect((await request(app).get('/api/v1/concierge/me').set('Authorization', token('staff'))).status).toBe(403);
    const inbox = await request(app).get('/api/v1/concierge/conversations').set('Authorization', token('staff'));
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.items[0]).toMatchObject({ guestId, waiting: true, sender: 'guest' });
    const guest = await request(app).get('/api/v1/concierge/' + guestId).set('Authorization', token('staff'));
    expect(guest.status).toBe(200);
  });

  it('staff replies only to existing guest conversations and cannot forge a guest sender', async () => {
    const route = '/api/v1/concierge/' + guestId;
    expect((await request(app).post(route).set('Authorization', token('guest')).send({ text: 'No' })).status).toBe(403);
    expect((await request(app).post(route).set('Authorization', token('manager')).send({ text: 'No' })).status).toBe(403);
    const sent = await request(app).post(route).set('Authorization', token('staff')).send({ text: 'Welcome to Guestly.' });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ sender: 'staff', guestId });
    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({ sender: 'staff', guest: guestId, senderUser: staffId }));
    Message.exists.mockResolvedValue(null);
    expect((await request(app).post(route).set('Authorization', token('staff')).send({ text: 'No conversation yet' })).status).toBe(404);
    expect((await request(app).post('/api/v1/concierge/' + otherGuest).set('Authorization', token('staff')).send({ text: 'No guest' })).status).toBe(404);
  });
});

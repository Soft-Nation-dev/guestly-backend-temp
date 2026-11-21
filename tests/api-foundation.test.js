process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-api-test-secret-at-least-32-characters';
process.env.CORS_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000,https://soft-nation-dev.github.io';

const request = require('supertest');
const app = require('../src/app');

describe('Guestly API foundation', () => {
  it('allows the Guestly GitHub Pages origin', async () => {
    const response = await request(app).get('/health').set('Origin', 'https://soft-nation-dev.github.io');
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://soft-nation-dev.github.io');
    expect(response.body).toEqual({
      success: true,
      message: 'Service is healthy',
      data: { status: 'ok', database: 'disconnected' },
    });
  });

  it('allows local frontend origins', async () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      const response = await request(app).get('/health').set('Origin', origin);
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('allows browser preflight requests with authentication headers', async () => {
    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://soft-nation-dev.github.io')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://soft-nation-dev.github.io');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('rejects unlisted origins without exposing response headers', async () => {
    const response = await request(app).get('/health').set('Origin', 'https://another-example.invalid');
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.body).toEqual({ success: false, message: 'Origin not allowed by CORS' });
  });

  it('uses the existing error response shape', async () => {
    const noSession = await request(app).get('/api/v1/auth/me');
    expect(noSession.status).toBe(401);
    expect(noSession.body).toMatchObject({ success: false, message: 'Authentication required' });

    const missing = await request(app).get('/api/v1/not-a-route');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ success: false });
  });
});

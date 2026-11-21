const corsMethods = 'GET,HEAD,OPTIONS';
const corsHeaders = origin => ({
  'Access-Control-Allow-Origin': origin || 'null',
  'Access-Control-Allow-Methods': corsMethods,
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Vary': 'Origin',
});

function respond(data, message, status, origin) {
  return new Response(JSON.stringify({ success: status < 400, message, ...(data !== undefined ? { data } : {}) }), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function serializeRoom(row) {
  return {
    id: row.slug,
    name: row.name,
    category: row.category,
    image: row.image,
    nightlyRate: row.nightly_rate,
    capacity: row.capacity,
    size: row.size,
    bed: row.bed,
    view: row.view,
    amenities: JSON.parse(row.amenities || '[]'),
    description: row.description,
    inventory: row.inventory,
    featured: row.featured === 1,
  };
}

function permittedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return { origin: '' };
  const allowed = (env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  return allowed.includes(origin) ? { origin } : { rejected: true };
}

async function readiness(env, origin) {
  if (!env.GUESTLY_DB || !env.GUESTLY_PUBLIC_FILES || !env.GUESTLY_PRIVATE_FILES) {
    return respond(undefined, 'Cloudflare database or file storage is not configured', 503, origin);
  }
  try {
    const row = await env.GUESTLY_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").bind('users').first();
    if (!row) return respond(undefined, 'Database tables have not been created', 503, origin);
    await Promise.all([
      env.GUESTLY_PUBLIC_FILES.head('__guestly_readiness__'),
      env.GUESTLY_PRIVATE_FILES.head('__guestly_readiness__'),
    ]);
    return respond({ status: 'ready', database: 'connected', storage: 'connected' }, 'Service is ready', 200, origin);
  } catch (error) {
    console.error('Cloudflare readiness check failed', error.message);
    return respond(undefined, 'Database or file storage is unavailable', 503, origin);
  }
}

async function listRooms(env, origin) {
  const rows = await env.GUESTLY_DB.prepare('SELECT * FROM rooms ORDER BY created_at ASC, name ASC LIMIT 500').all();
  return respond(rows.results.map(serializeRoom), 'Rooms retrieved', 200, origin);
}

async function showRoom(env, origin, slug) {
  if (!/^[a-z0-9-]{1,100}$/.test(slug)) return respond(undefined, 'Invalid room name', 400, origin);
  const room = await env.GUESTLY_DB.prepare('SELECT * FROM rooms WHERE slug = ?1').bind(slug).first();
  return room
    ? respond(serializeRoom(room), 'Room retrieved', 200, origin)
    : respond(undefined, 'Room type not found', 404, origin);
}

async function showHotel(env, origin) {
  const row = await env.GUESTLY_DB.prepare('SELECT * FROM hotel_profile WHERE id = ?1').bind('primary').first();
  if (!row) return respond(undefined, 'Hotel profile has not been added', 404, origin);
  return respond({
    id: 'primary',
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    location: row.location,
    heroImage: row.hero_image,
    currency: 'NGN',
  }, 'Hotel retrieved', 200, origin);
}

async function handle(request, env) {
  const allowed = permittedOrigin(request, env);
  if (allowed.rejected) return respond(undefined, 'Origin not allowed by CORS', 403, '');
  const origin = allowed.origin;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders(origin), 'Access-Control-Max-Age': '600' },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return respond(undefined, 'This API feature is not available in the Cloudflare trial yet', 501, origin);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/health') {
    return respond({ status: 'ok', database: 'unknown' }, 'Service is healthy', 200, origin);
  }
  if (path === '/ready') return readiness(env, origin);
  if (path === '/api/v1/rooms') return listRooms(env, origin);
  if (path === '/api/v1/hotels/current') return showHotel(env, origin);
  if (path === '/api/v1/rooms/availability') {
    return respond(undefined, 'Availability checks are not available in the Cloudflare trial yet', 501, origin);
  }
  if (path.startsWith('/api/v1/rooms/')) {
    return showRoom(env, origin, decodeURIComponent(path.slice('/api/v1/rooms/'.length)));
  }
  if (path.startsWith('/api/v1/')) {
    return respond(undefined, 'This API feature has not been migrated to Cloudflare yet', 501, origin);
  }
  return respond(undefined, 'Not found', 404, origin);
}

export default {
  fetch(request, env) {
    return handle(request, env).catch(error => {
      console.error('Cloudflare API request failed', error.message);
      const allowed = permittedOrigin(request, env);
      return respond(undefined, 'Service temporarily unavailable', 503, allowed.origin || '');
    });
  },
};

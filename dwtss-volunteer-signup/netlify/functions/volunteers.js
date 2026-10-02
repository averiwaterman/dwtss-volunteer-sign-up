// DWTSS Broadway Edition volunteer sign-up backend (Netlify function + Upstash Redis)
const KEY = 'dwtss-volunteers';
const PASSCODE = process.env.ADMIN_PASSCODE || 'dwtss2026';
const R_URL = process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const SEED = {
  roles: [
    { id: 'vip-bags', category: 'Before the show', name: 'VIP bag placement', time: 'Before doors (time TBD)', needed: 2, description: 'Place VIP gift bags on the correct seats before guests arrive.', order: 10, visible: true },
    { id: 'cascade-support', category: 'Before the show', name: 'Cascade Theatre support', time: 'Before the show (time TBD)', needed: 4, description: 'Help the Cascade team with tickets and possibly the bar.', order: 20, visible: true },
    { id: 'payments', category: 'Intermissions', name: 'Payment table', time: 'Arrive 3:00 pm, work during intermission', needed: 4, description: 'Take payments from guests during intermission.', order: 30, visible: true },
    { id: 'concession-bins', category: 'Intermissions', name: 'Concession bins', time: 'Arrive 3:00 pm, work during intermission', needed: 4, description: 'Work the concession bins during intermission.', order: 40, visible: true },
    { id: 'faces-on-sticks', category: 'Intermissions', name: 'Faces on sticks sales', time: 'Arrive 3:00 pm, work during intermission', needed: 4, description: 'Help sell Star faces on sticks to the audience.', order: 50, visible: true },
    { id: 'green-room', category: 'During the show', name: 'Green room', time: 'Time TBD', needed: 2, description: 'Support the Stars and their partners backstage in the green room.', order: 60, visible: true },
    { id: 'go-to-staff', category: 'During the show', name: 'Go-to staff', time: 'All evening', needed: 2, description: 'Staff point people volunteers can find with questions throughout the night.', order: 70, visible: true },
    { id: 'clean-up', category: 'After the show', name: 'Clean up', time: '9:00 pm to 10:30 or 11:00 pm', needed: 5, description: 'Help reset and clean the theatre after the final number.', order: 80, visible: true }
  ],
  bookings: []
};

async function redis(cmd) {
  const res = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

async function load() {
  const raw = await redis(['GET', KEY]);
  if (!raw) {
    await redis(['SET', KEY, JSON.stringify(SEED)]);
    return JSON.parse(JSON.stringify(SEED));
  }
  return JSON.parse(raw);
}

async function save(data) {
  await redis(['SET', KEY, JSON.stringify(data)]);
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

function shortName(full) {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function publicView(data) {
  return {
    roles: data.roles
      .filter(r => r.visible !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(r => {
        const people = data.bookings.filter(b => b.roleId === r.id);
        return {
          id: r.id, category: r.category, name: r.name, time: r.time,
          description: r.description, needed: r.needed,
          filled: people.length,
          names: people.map(p => shortName(p.name))
        };
      })
  };
}

function adminView(data) {
  return {
    roles: [...data.roles].sort((a, b) => (a.order || 0) - (b.order || 0)),
    bookings: [...data.bookings].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
  };
}

function roleFrom(input, existing = {}) {
  const needed = parseInt(input.needed, 10);
  const order = parseInt(input.order, 10);
  return {
    ...existing,
    category: clean(input.category ?? existing.category, 80) || 'Other',
    name: clean(input.name ?? existing.name, 100),
    time: clean(input.time ?? existing.time, 120),
    description: clean(input.description ?? existing.description, 500),
    needed: Number.isFinite(needed) && needed > 0 ? needed : (existing.needed || 1),
    order: Number.isFinite(order) ? order : (existing.order || 999),
    visible: input.visible === undefined ? existing.visible !== false : !!input.visible
  };
}

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  try {
    if (!R_URL || !R_TOKEN) return reply(500, { error: 'Missing Upstash environment variables.' });

    const isAdmin = (event.headers['x-admin-passcode'] || '') === PASSCODE;

    if (event.httpMethod === 'GET') {
      const data = await load();
      if (event.queryStringParameters && event.queryStringParameters.admin) {
        if (!isAdmin) return reply(401, { error: 'Incorrect passcode.' });
        return reply(200, adminView(data));
      }
      return reply(200, publicView(data));
    }

    if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });

    const body = JSON.parse(event.body || '{}');
    const data = await load();

    if (body.action === 'signup') {
      const role = data.roles.find(r => r.id === body.roleId && r.visible !== false);
      if (!role) return reply(404, { error: 'That role is no longer available.' });
      const name = clean(body.name, 100);
      const email = clean(body.email, 120);
      const phone = clean(body.phone, 40);
      if (!name || !email || !phone) return reply(400, { error: 'Add your name, email, and phone to sign up.' });
      const taken = data.bookings.filter(b => b.roleId === role.id);
      if (taken.length >= role.needed) return reply(409, { error: `${role.name} just filled up. Pick another role.`, ...publicView(data) });
      if (taken.some(b => b.name.toLowerCase() === name.toLowerCase())) return reply(409, { error: `${name} is already signed up for ${role.name}.` });
      data.bookings.push({ id: uid(), roleId: role.id, name, email, phone, createdAt: new Date().toISOString() });
      await save(data);
      return reply(200, { ok: true, ...publicView(data) });
    }

    if (!isAdmin) return reply(401, { error: 'Incorrect passcode.' });

    switch (body.action) {
      case 'addRole': {
        const role = roleFrom(body.role || {});
        if (!role.name) return reply(400, { error: 'Give the role a name.' });
        role.id = uid();
        data.roles.push(role);
        break;
      }
      case 'updateRole': {
        const i = data.roles.findIndex(r => r.id === body.id);
        if (i < 0) return reply(404, { error: 'Role not found.' });
        data.roles[i] = roleFrom(body.role || {}, data.roles[i]);
        if (!data.roles[i].name) return reply(400, { error: 'Give the role a name.' });
        break;
      }
      case 'deleteRole': {
        data.roles = data.roles.filter(r => r.id !== body.id);
        data.bookings = data.bookings.filter(b => b.roleId !== body.id);
        break;
      }
      case 'addBooking': {
        if (!data.roles.some(r => r.id === body.roleId)) return reply(404, { error: 'Role not found.' });
        const name = clean(body.name, 100);
        if (!name) return reply(400, { error: 'Add a name.' });
        data.bookings.push({ id: uid(), roleId: body.roleId, name, email: clean(body.email, 120), phone: clean(body.phone, 40), createdAt: new Date().toISOString(), addedByAdmin: true });
        break;
      }
      case 'updateBooking': {
        const b = data.bookings.find(x => x.id === body.id);
        if (!b) return reply(404, { error: 'Volunteer not found.' });
        if (body.roleId && data.roles.some(r => r.id === body.roleId)) b.roleId = body.roleId;
        if (body.name !== undefined) b.name = clean(body.name, 100) || b.name;
        if (body.email !== undefined) b.email = clean(body.email, 120);
        if (body.phone !== undefined) b.phone = clean(body.phone, 40);
        break;
      }
      case 'deleteBooking': {
        data.bookings = data.bookings.filter(b => b.id !== body.id);
        break;
      }
      default:
        return reply(400, { error: 'Unknown action.' });
    }

    await save(data);
    return reply(200, { ok: true, ...adminView(data) });
  } catch (err) {
    return reply(500, { error: err.message });
  }
};

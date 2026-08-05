// Talking to /api.
//
// Two things every call needs and none of the screens should repeat: the
// session cookie goes along automatically (same-origin), and a 401 anywhere
// means the session ended, which is a redirect rather than an error for a
// screen to render.

// Thrown for any non-2xx. `details` carries the API's per-field errors, which
// is what lets a form mark the offending input rather than showing one message
// at the top and making you hunt.
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status  = status;
    this.details = details || null;
  }
}

async function request(method, path, body) {
  let response;

  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body:    body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Offline, DNS, the container restarting mid-deploy. Distinguished from an
    // API error because there is nothing the input could have done about it.
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  if (response.status === 401) {
    // The session expired or was signed out elsewhere. Nothing on screen can
    // recover from that, so hand over to the login page.
    window.location.href = '/login';
    throw new ApiError(401, 'Session ended');
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (payload && payload.error) || `Request failed (${response.status})`,
      payload && payload.details
    );
  }

  return payload;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

export const api = {
  me:     ()  => request('GET',  '/api/me'),
  logout: ()  => request('POST', '/api/logout'),

  contacts: {
    list:   ()          => request('GET',    '/api/contacts'),
    create: (data)      => request('POST',   '/api/contacts', data),
    update: (id, data)  => request('PATCH', `/api/contacts/${id}`, data),
    remove: (id)        => request('DELETE', `/api/contacts/${id}`),
  },

  messages: {
    list:   ()          => request('GET',    '/api/messages'),
    create: (data)      => request('POST',   '/api/messages', data),
    update: (id, data)  => request('PATCH', `/api/messages/${id}`, data),
    remove: (id)        => request('DELETE', `/api/messages/${id}`),
  },

  schedules: {
    list:      ()         => request('GET',    '/api/schedules'),
    create:    (data)     => request('POST',   '/api/schedules', data),
    update:    (id, data) => request('PATCH', `/api/schedules/${id}`, data),
    remove:    (id)       => request('DELETE', `/api/schedules/${id}`),
    setEnabled: (id, enabled) => request('POST', `/api/schedules/${id}/enabled`, { enabled }),
  },

  history: {
    list: (filters) => request('GET', `/api/call-history${qs(filters)}`),
  },

  // Not under /api: /trigger predates it and accepts either the session or the
  // shared secret. From here the cookie is what authenticates.
  trigger: (dose, target) => request('POST', `/trigger${qs({ dose, target })}`),
};

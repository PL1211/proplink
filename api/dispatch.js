import { createSupabaseRuntime } from '../server/supabase.js';

const { app } = createSupabaseRuntime();

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/dispatch' || url.pathname === '/api/dispatch.js') {
    const route = url.searchParams.get('bcRoute');
    if (route && /^[a-z0-9_/-]+$/i.test(route)) {
      url.searchParams.delete('bcRoute');
      req.url = '/api/' + route + url.search;
    }
  }
  return app(req, res);
}

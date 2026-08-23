import { GameRoom } from './room.js';

export { GameRoom };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Debug endpoint — open this in browser to check bindings
    if (url.pathname === '/debug') {
      return new Response(JSON.stringify({
        hasGAME_ROOM: !!env.GAME_ROOM,
        hasASSETS: !!env.ASSETS,
        path: url.pathname,
        time: new Date().toISOString()
      }, null, 2), {
        headers: { 'content-type': 'application/json' }
      });
    }

    // WebSocket rooms
    if (url.pathname.startsWith('/ws/')) {
      const roomCode = (url.pathname.split('/')[2] || '').toUpperCase();
      if (!roomCode || roomCode.length !== 4) {
        return new Response('Invalid room code (need 4 letters)', { status: 400 });
      }
      if (!env.GAME_ROOM) {
        return new Response('ERROR: GAME_ROOM Durable Object binding is missing. Check Cloudflare settings.', {
          status: 500,
          headers: { 'content-type': 'text/plain' }
        });
      }
      try {
        const id = env.GAME_ROOM.idFromName(roomCode);
        const stub = env.GAME_ROOM.get(id);
        return await stub.fetch(request);
      } catch (err) {
        return new Response('DO error: ' + (err.message || String(err)), {
          status: 500,
          headers: { 'content-type': 'text/plain' }
        });
      }
    }

    // Static files
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('ASSETS binding missing', { status: 500 });
  }
};

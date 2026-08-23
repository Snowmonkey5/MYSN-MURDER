import { GameRoom } from './room.js';

export { GameRoom };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/ws/')) {
      const roomCode = (url.pathname.split('/')[2] || '').toUpperCase();
      if (!roomCode || roomCode.length !== 4) {
        return new Response(JSON.stringify({ error: 'Invalid room code' }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (!env.GAME_ROOM) {
        return new Response(JSON.stringify({ error: 'GAME_ROOM binding missing — check Durable Object binding' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
      try {
        const id = env.GAME_ROOM.idFromName(roomCode);
        const stub = env.GAME_ROOM.get(id);
        return await stub.fetch(request);
      } catch (err) {
        return new Response(JSON.stringify({ error: 'DO error: ' + (err.message || String(err)) }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
    }

    // Health check
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({
        ok: true,
        hasGameRoom: !!env.GAME_ROOM,
        hasAssets: !!env.ASSETS
      }), { headers: { 'content-type': 'application/json' } });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('No assets', { status: 500 });
  }
};

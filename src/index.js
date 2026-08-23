import { GameRoom } from './room.js';

export { GameRoom };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check – open /health in browser to test Worker
    if (url.pathname === '/health') {
      const hasDO = !!env.GAME_ROOM;
      const hasAssets = !!env.ASSETS;
      return new Response(
        JSON.stringify({
          ok: true,
          durableObject: hasDO,
          assets: hasAssets,
          message: hasDO
            ? 'Worker + Durable Object OK'
            : 'ERROR: GAME_ROOM binding missing – add Durable Object binding in Cloudflare settings'
        }, null, 2),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    // WebSocket rooms
    if (url.pathname.startsWith('/ws/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      // parts: ['ws', 'CODE']
      const roomCode = (parts[1] || '').toUpperCase();

      if (!roomCode || roomCode.length !== 4) {
        return new Response('Invalid room code', { status: 400 });
      }

      if (!env.GAME_ROOM) {
        return new Response(
          'GAME_ROOM Durable Object binding is missing. In Cloudflare go to Settings → Bindings → Add Durable Object: name=GAME_ROOM class=GameRoom',
          { status: 500 }
        );
      }

      try {
        const id = env.GAME_ROOM.idFromName(roomCode);
        const stub = env.GAME_ROOM.get(id);
        return await stub.fetch(request);
      } catch (err) {
        return new Response('DO error: ' + (err && err.message ? err.message : String(err)), {
          status: 500
        });
      }
    }

    // Static files
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      'No ASSETS binding. Deploy with public/ folder.',
      { status: 500 }
    );
  }
};

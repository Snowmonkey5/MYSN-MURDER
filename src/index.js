import { GameRoom } from './room.js';

export { GameRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket for game rooms
    if (url.pathname.startsWith('/ws/')) {
      const roomCode = url.pathname.split('/')[2]?.toUpperCase();
      if (!roomCode || roomCode.length !== 4) {
        return new Response('Invalid room code', { status: 400 });
      }
      if (!env.GAME_ROOM) {
        return new Response('GAME_ROOM binding missing', { status: 500 });
      }
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // Serve static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Assets not configured', { status: 500 });
  }
};

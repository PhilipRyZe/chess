import { DurableObject } from "cloudflare:workers";

// Ein Raum = ein Spiel. Er verbindet genau zwei Spieler und leitet Nachrichten weiter.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // "ping" wird automatisch mit "pong" beantwortet, ohne den Raum aufzuwecken
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  players() {
    return this.ctx.getWebSockets().filter((w) => w.deserializeAttachment());
  }

  async fetch(request) {
    const mode = new URL(request.url).searchParams.get("mode");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const current = this.players();
    this.ctx.acceptWebSocket(server);

    const reject = (code, text) => {
      server.send(JSON.stringify({ type: "error", code }));
      server.close(code, text);
    };

    if (mode === "create" && current.length > 0) {
      reject(4409, "Code vergeben");
    } else if (mode === "join" && current.length === 0) {
      reject(4404, "Kein Spiel gefunden");
    } else if (mode === "join" && current.length >= 2) {
      reject(4409, "Spiel ist voll");
    } else if (mode === "create") {
      server.serializeAttachment({ color: "w" });
      server.send(JSON.stringify({ type: "waiting" }));
    } else if (mode === "join") {
      server.serializeAttachment({ color: "b" });
      current[0].send(JSON.stringify({ type: "start", color: "w" }));
      server.send(JSON.stringify({ type: "start", color: "b" }));
    } else {
      reject(4400, "Ungültige Anfrage");
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 300) return;
    if (!ws.deserializeAttachment()) return;
    for (const other of this.players()) {
      if (other !== ws) other.send(message);
    }
  }

  webSocketClose(ws, code) {
    const wasPlayer = ws.deserializeAttachment();
    try { ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "bye"); } catch (e) {}
    if (!wasPlayer) return;
    for (const other of this.players()) {
      if (other !== ws) other.send(JSON.stringify({ type: "left" }));
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws, 1011);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("Nicht gefunden", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket erwartet", { status: 426 });

    // nur Aufrufe von der eigenen Seite zulassen (schützt dein Gratis-Kontingent)
    const origin = request.headers.get("Origin");
    if (origin) {
      let host = "";
      try { host = new URL(origin).host; } catch (e) {}
      if (host !== url.host) return new Response("Nicht erlaubt", { status: 403 });
    }

    const room = (url.searchParams.get("room") || "").toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(room)) return new Response("Ungültiger Code", { status: 400 });

    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
  },
};

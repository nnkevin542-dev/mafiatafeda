import express from "express";
import http from "http";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { GameState, PlayerSlot, SocketMessage } from "./src/types";

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  // Initialize authoratative Game State
  const initialSlots: PlayerSlot[] = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    name: i + 1 === 12 ? "Ведущий" : `Игрок ${i + 1}`,
    alive: true,
    connected: false,
    connectionId: null,
    webcamFrame: null,
    deathFrame: null,
    onVote: false,
    voteCount: 0,
  }));

  let gameState: GameState = {
    slots: initialSlots,
    victory: null,
    killAnnouncement: null,
  };

  // Setup WebSocket Server
  const wss = new WebSocketServer({ server });

  interface ClientSocket extends WebSocket {
    connectionId?: string;
  }

  function broadcast(msg: any) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  function broadcastState() {
    broadcast({ type: "state_update", state: gameState });
  }

  wss.on("connection", (ws: ClientSocket) => {
    const connectionId = Math.random().toString(36).substring(2, 9);
    ws.connectionId = connectionId;

    // Send initial full game state to the newly connected user
    ws.send(JSON.stringify({ type: "init", state: gameState }));

    ws.on("message", (messageStr: string) => {
      try {
        const msg = JSON.parse(messageStr);

        switch (msg.type) {
          case "join": {
            const slot = gameState.slots.find((s) => s.id === msg.slotId);
            if (slot) {
              // Disconnect previous occupant if necessary
              gameState.slots.forEach((s) => {
                if (s.connectionId === connectionId) {
                  s.connected = false;
                  s.connectionId = null;
                }
              });

              slot.name = msg.name || (slot.id === 12 ? "Ведущий" : `Игрок ${slot.id}`);
              slot.connected = true;
              slot.connectionId = connectionId;
              broadcastState();
            }
            break;
          }

          case "leave": {
            const slot = gameState.slots.find((s) => s.id === msg.slotId);
            if (slot && slot.connectionId === connectionId) {
              slot.connected = false;
              slot.connectionId = null;
              broadcastState();
            }
            break;
          }

          case "webcam": {
            const slot = gameState.slots.find((s) => s.id === msg.slotId);
            if (slot) {
              slot.webcamFrame = msg.frame;
              
              // Broadcast frame delta to all other clients directly for low bandwidth latency
              const deltaPayload = JSON.stringify({
                type: "webcam",
                slotId: msg.slotId,
                frame: msg.frame,
              });

              wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                  client.send(deltaPayload);
                }
              });
            }
            break;
          }

          case "toggle_life": {
            const slot = gameState.slots.find((s) => s.id === msg.slotId);
            if (slot) {
              slot.alive = msg.alive;
              if (!msg.alive) {
                // If they died, store their frozen frame
                slot.deathFrame = msg.lastSnapshot || slot.webcamFrame || null;

                // Set server level announcement
                gameState.killAnnouncement = {
                  playerId: slot.id,
                  name: slot.name,
                  timestamp: Date.now(),
                };

                // Trigger kill announcement banner event to all clients
                broadcast({
                  type: "trigger_kill",
                  playerId: slot.id,
                  name: slot.name,
                });
              } else {
                slot.deathFrame = null;
              }
              broadcastState();
            }
            break;
          }

          case "victory": {
            gameState.victory = msg.victory;
            broadcastState();
            break;
          }

          case "reset_game": {
            gameState.victory = null;
            gameState.killAnnouncement = null;
            gameState.slots.forEach((s) => {
              s.alive = true;
              s.deathFrame = null;
              s.onVote = false;
              s.voteCount = 0;
            });
            broadcastState();
            break;
          }

          case "set_vote_status": {
            const slot = gameState.slots.find((s) => s.id === msg.slotId);
            if (slot) {
              slot.onVote = msg.onVote;
              if (!msg.onVote) {
                slot.voteCount = 0; // reset votes if taken off vote
              }
              broadcastState();
            }
            break;
          }

          case "set_vote_count": {
            const slot = gameState.slots.find((s) => s.id === msg.slotId);
            if (slot) {
              slot.voteCount = msg.voteCount;
              broadcastState();
            }
            break;
          }

          default:
            console.warn("Unknown message type:", msg.type);
        }
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    });

    ws.on("close", () => {
      let changed = false;
      gameState.slots.forEach((s) => {
        if (s.connectionId === ws.connectionId) {
          s.connected = false;
          s.connectionId = null;
          changed = true;
        }
      });
      if (changed) {
        broadcastState();
      }
    });
  });

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Serve static assets or use Vite development middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Mafia Tafida Server running on http://localhost:${PORT}`);
  });
}

startServer();

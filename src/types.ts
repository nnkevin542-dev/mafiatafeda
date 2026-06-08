export interface PlayerSlot {
  id: number; // 1 to 11 for players, 12 for host
  name: string;
  alive: boolean;
  connected: boolean;
  connectionId: string | null; // socket ID
  webcamFrame: string | null; // latest live jpeg/webp base64 frame
  deathFrame: string | null; // frozen frame when the player was killed
  onVote?: boolean;
  voteCount?: number;
}

export interface KillAnnouncement {
  playerId: number;
  name: string;
  timestamp: number;
}

export interface GameState {
  slots: PlayerSlot[];
  victory: 'mafia' | 'civilians' | null;
  killAnnouncement: KillAnnouncement | null;
}

export type SocketMessage =
  | { type: 'init'; state: GameState }
  | { type: 'join'; slotId: number; name: string }
  | { type: 'leave'; slotId: number }
  | { type: 'webcam'; slotId: number; frame: string }
  | { type: 'toggle_life'; slotId: number; alive: boolean; lastSnapshot?: string }
  | { type: 'victory'; victory: 'mafia' | 'civilians' | null }
  | { type: 'reset_game' }
  | { type: 'state_update'; state: GameState }
  | { type: 'trigger_kill'; playerId: number; name: string }
  | { type: 'set_vote_status'; slotId: number; onVote: boolean }
  | { type: 'set_vote_count'; slotId: number; voteCount: number };

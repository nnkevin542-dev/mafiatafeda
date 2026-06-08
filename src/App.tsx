import React, { useState, useEffect, useRef } from 'react';
import { 
  Skull, 
  Heart, 
  Camera, 
  Tv, 
  RefreshCw, 
  Volume2, 
  VolumeX, 
  Users, 
  Check, 
  Crown, 
  ShieldAlert, 
  VideoOff, 
  Edit3, 
  ShieldCheck, 
  Play, 
  Sparkles,
  Award,
  Video
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GameState, PlayerSlot, SocketMessage } from './types';
import { 
  playGunshotSound, 
  playMafiaVictorySound, 
  playCiviliansVictorySound 
} from './audio';

// Constants
const WEBCAM_FPS = 15; // Stable, smooth FPS that won't overload websockets
const WS_RECONNECT_INTERVAL = 3000;

// Inline worker to force background timer execution without browser throttling (1000ms clamp)
const timerWorkerBlob = new Blob([`
  let timerId = null;
  self.onmessage = function(e) {
    if (e.data.action === 'start') {
      if (timerId) clearInterval(timerId);
      timerId = setInterval(() => self.postMessage('tick'), e.data.ms);
    } else if (e.data.action === 'stop') {
      clearInterval(timerId);
      timerId = null;
    }
  }
`], { type: 'application/javascript' });

export default function App() {
  // Navigation tabs: 'overlay' | 'host' | 'player'
  const [activeTab, setActiveTab] = useState<'overlay' | 'host' | 'player'>('overlay');
  
  // Real-time states
  const [gameState, setGameState] = useState<GameState>({
    slots: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      name: i + 1 === 12 ? 'Ведущий' : `Игрок ${i + 1}`,
      alive: true,
      connected: false,
      connectionId: null,
      webcamFrame: null,
      deathFrame: null,
    })),
    victory: null,
    killAnnouncement: null,
  });

  const [soundEnabled, setSoundEnabled] = useState(true);
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem('mafia_volume');
    return saved !== null ? parseFloat(saved) : 0.5;
  });
  const [cleanMode, setCleanMode] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [currentPlayerSlotId, setCurrentPlayerSlotId] = useState<number | null>(null);
  const [playerNickname, setPlayerNickname] = useState('');
  const [isWebcamActive, setIsWebcamActive] = useState(false);
  const [mockCameraEnabled, setMockCameraEnabled] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  
  // Local overlay triggers for death/victory
  const [showDeathOverlay, setShowDeathOverlay] = useState<string | null>(null);
  const [lastAnnouncementTime, setLastAnnouncementTime] = useState<number>(0);

  // References
  const wsRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraWorkerRef = useRef<Worker | null>(null);
  const mockWorkerRef = useRef<Worker | null>(null);
  const captureIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const webcamFramesRef = useRef<Record<number, string>>({});
  
  // Reconnection refs
  const currentSlotIdRef = useRef(currentPlayerSlotId);
  const currentNicknameRef = useRef(playerNickname);

  useEffect(() => {
    currentSlotIdRef.current = currentPlayerSlotId;
    currentNicknameRef.current = playerNickname;
  }, [currentPlayerSlotId, playerNickname]);

  // Save volume preference to localStorage
  useEffect(() => {
    localStorage.setItem('mafia_volume', volume.toString());
  }, [volume]);

  // 1. Establish real-time WebSocket connection
  useEffect(() => {
    let reconnectTimeout: NodeJS.Timeout;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      console.log('Connecting to WebSocket:', wsUrl);
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket successfully connected!');
        setWsConnected(true);
        
        // Auto-rejoin if reconnected
        if (currentSlotIdRef.current) {
          ws.send(JSON.stringify({
            type: 'join',
            slotId: currentSlotIdRef.current,
            name: currentNicknameRef.current || 'Возврат'
          }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'init' || data.type === 'state_update') {
            setGameState(data.state);
            // Populate initial frames into references
            data.state.slots.forEach((s: any) => {
              if (s.webcamFrame) {
                webcamFramesRef.current[s.id] = s.webcamFrame;
                
                // Directly sync existing DOM images to avoid flashing
                const imgEl = document.getElementById(`cam-feed-${s.id}`) as HTMLImageElement;
                if (imgEl) {
                  imgEl.src = s.webcamFrame;
                  imgEl.style.display = 'block';
                }
                const fallbackEl = document.getElementById(`cam-fallback-${s.id}`);
                if (fallbackEl) {
                  fallbackEl.style.display = 'none';
                }
              } else if (!s.alive) {
                // If dead and has a death frame, display it
                if (s.deathFrame) {
                  const imgEl = document.getElementById(`cam-feed-${s.id}`) as HTMLImageElement;
                  if (imgEl) {
                    imgEl.src = s.deathFrame;
                    imgEl.style.display = 'block';
                  }
                }
              }
            });
          } else if (data.type === 'webcam') {
            // Ignore our own incoming frames so they don't overwrite the much faster local preview with delayed frames causing jitter
            if (data.slotId === currentSlotIdRef.current) {
              return;
            }
            // Save webcam frame into mutable reference to bypass React render completely (extreme speed boost)
            webcamFramesRef.current[data.slotId] = data.frame;

            // Direct DOM update instead of re-rendering whole React view 4 times/sec per user
            const imgEl = document.getElementById(`cam-feed-${data.slotId}`) as HTMLImageElement;
            if (imgEl) {
              imgEl.src = data.frame;
              imgEl.style.display = 'block';
            }
            const fallbackEl = document.getElementById(`cam-fallback-${data.slotId}`);
            if (fallbackEl) {
              fallbackEl.style.display = 'none';
            }
          } else if (data.type === 'trigger_kill') {
            // Active full screen announcement
            setShowDeathOverlay(data.name);
            if (soundEnabled) {
              playGunshotSound(volume);
            }
            // Auto hide after 4 seconds
            setTimeout(() => {
              setShowDeathOverlay(null);
            }, 4200);
          }
        } catch (e) {
          console.error('Error handling websocket message:', e);
        }
      };

      ws.onclose = () => {
        console.warn('WebSocket closed, reconnecting in background...');
        setWsConnected(false);
        reconnectTimeout = setTimeout(connect, WS_RECONNECT_INTERVAL);
      };

      ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
        ws.close();
      };
    }

    connect();

    return () => {
      if (wsRef.current) wsRef.current.close();
      clearTimeout(reconnectTimeout);
    };
  }, [soundEnabled, volume]);

  // Sync Victory Sounds
  useEffect(() => {
    if (gameState.victory && soundEnabled) {
      if (gameState.victory === 'mafia') {
        playMafiaVictorySound(volume);
      } else if (gameState.victory === 'civilians') {
        playCiviliansVictorySound(volume);
      }
    }
  }, [gameState.victory, soundEnabled, volume]);

  // Hidden elements for continuous global webcam capture
  const globalVideoRef = useRef<HTMLVideoElement>(document.createElement('video'));
  const globalCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));

  // 2. Local Desktop Webcame capture handler
  useEffect(() => {
    // Run if webcam is active, regardless of activeTab so the stream doesn't die when switching tabs
    if (isWebcamActive && currentPlayerSlotId) {
      // Initalize camera using ideal standard 16:9 HD resolution for local fluid preview
      navigator.mediaDevices.getUserMedia({ 
        video: { 
          width: { ideal: 1280 }, 
          height: { ideal: 720 }, 
        }, 
        audio: false 
      })
      .then((stream) => {
        setLocalStream(stream);

        // Bind stream to our global persistent video reference
        const vid = globalVideoRef.current;
        vid.autoplay = true;
        vid.playsInline = true;
        vid.muted = true;
        vid.srcObject = stream;
        vid.onloadedmetadata = () => {
          vid.play().catch(e => console.warn('Global video play failed:', e));
        };

        // Setup ticked canvas snapshot
        if (!cameraWorkerRef.current) {
          cameraWorkerRef.current = new Worker(URL.createObjectURL(timerWorkerBlob));
        }

        cameraWorkerRef.current.onmessage = () => {
          // Do not pause on visibilityState so OBS/Twitch captures continue without lag when streamer minimizes
          if (vid && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            // CRITICAL: Drop frames if the connection is struggling to keep up to eliminate 1-second delay lag
            if (wsRef.current.bufferedAmount > 1024 * 64) {
              return; // Skip this frame to prevent buffer bloat
            }
            
            const canvas = globalCanvasRef.current;
            const context = canvas.getContext('2d');
            if (context) {
              // Ensure size is exactly 16:9 (480x270) to look perfectly crisp
              canvas.width = 480;
              canvas.height = 270;
              context.drawImage(vid, 0, 0, 480, 270);
              
              // Compress to jpeg for faster main thread encoding (WebP is too slow and causes mouth latency)
              const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.40);
              
              // IMMEDIATELY update local ref so the Overlay tab can see our own camera without waiting for server response
              if (currentPlayerSlotId) {
                webcamFramesRef.current[currentPlayerSlotId] = jpegDataUrl;
                // Direct DOM update for local viewing
                const imgEl = document.getElementById(`cam-feed-${currentPlayerSlotId}`) as HTMLImageElement;
                if (imgEl) {
                  imgEl.src = jpegDataUrl;
                  imgEl.style.display = 'block';
                }
                const fallbackEl = document.getElementById(`cam-fallback-${currentPlayerSlotId}`);
                if (fallbackEl) {
                  fallbackEl.style.display = 'none';
                }
              }

              // Send off
              wsRef.current.send(JSON.stringify({
                type: 'webcam',
                slotId: currentPlayerSlotId,
                frame: jpegDataUrl
              }));
            }
          }
        };

        cameraWorkerRef.current.postMessage({ action: 'start', ms: 1000 / WEBCAM_FPS });
      })
      .catch((err) => {
        console.error('Error starting camera stream:', err);
        alert('Не удалось получить доступ к веб-камере. Пожалуйста, предоставьте разрешения в браусере или переключитесь на "Демо-Камеру".');
        setIsWebcamActive(false);
      });
    } else {
      // Clean up camera slots when explicitly turned off
      if (cameraWorkerRef.current) {
        cameraWorkerRef.current.postMessage({ action: 'stop' });
      }
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        setLocalStream(null);
      }
    }

    return () => {
      // Don't kill tracks on tab change unmount, wait for explicit deactivate
      if (cameraWorkerRef.current) {
        cameraWorkerRef.current.postMessage({ action: 'stop' });
      }
      // If we are unmounting completely we can stop the track, but useEffect re-runs shouldn't kill it unless we want to
      // Wait, to keep track stable we ONLY stop the track on explicit isWebcamActive change which is handled by the else block.
    };
  }, [isWebcamActive, currentPlayerSlotId]);

  // Demo Camera Generator Loop (for easier offline twitch layout testing)
  useEffect(() => {
    if (mockCameraEnabled && currentPlayerSlotId) {
      if (!mockWorkerRef.current) {
        mockWorkerRef.current = new Worker(URL.createObjectURL(timerWorkerBlob));
      }

      mockWorkerRef.current.onmessage = () => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          // Generate a thematic canvas graphics frame with randomized visual values & noise
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            // Draw gradient background
            const grad = ctx.createRadialGradient(160, 120, 10, 160, 120, 180);
            grad.addColorStop(0, '#1c1917');
            grad.addColorStop(1, '#0c0a09');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 320, 240);

            // Vintage crosshair design
            ctx.strokeStyle = 'rgba(223, 186, 115, 0.4)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(10, 120); ctx.lineTo(310, 120);
            ctx.moveTo(160, 10); ctx.lineTo(160, 230);
            ctx.stroke();

            // Retro circles
            ctx.strokeStyle = 'rgba(223, 186, 115, 0.15)';
            ctx.beginPath();
            ctx.arc(160, 120, 60, 0, Math.PI * 2);
            ctx.stroke();

            // Animated fake wave represent camera activity
            ctx.fillStyle = 'rgba(185, 28, 28, 0.25)';
            const time = Date.now();
            ctx.beginPath();
            for (let x = 0; x < 320; x += 10) {
              const y = 200 + Math.sin((x + time) * 0.04) * 15;
              ctx.lineTo(x, y);
            }
            ctx.lineTo(320, 240);
            ctx.lineTo(0, 240);
            ctx.fill();

            // Animated blinking recording dot
            const isDotVisible = Math.floor(time / 500) % 2 === 0;
            if (isDotVisible) {
              ctx.fillStyle = '#ef4444';
              ctx.beginPath();
              ctx.arc(30, 30, 6, 0, Math.PI * 2);
              ctx.fill();
            }

            // Text info
            ctx.fillStyle = '#dfba73';
            ctx.font = '10px monospace';
            ctx.fillText('REC MOCK FEED', 45, 33);
            ctx.fillText(`SLOT ${currentPlayerSlotId}`, 230, 33);
            ctx.fillText(new Date().toLocaleTimeString(), 220, 220);

            // Compress & stream
            const frameData = canvas.toDataURL('image/jpeg', 0.5);
            
            // Immediately update local webcam frames for overlay self-testing
            if (currentPlayerSlotId) {
              webcamFramesRef.current[currentPlayerSlotId] = frameData;
              // Direct DOM update for local viewing
              const imgEl = document.getElementById(`cam-feed-${currentPlayerSlotId}`) as HTMLImageElement;
              if (imgEl) {
                imgEl.src = frameData;
                imgEl.style.display = 'block';
              }
              const fallbackEl = document.getElementById(`cam-fallback-${currentPlayerSlotId}`);
              if (fallbackEl) {
                fallbackEl.style.display = 'none';
              }
            }

            wsRef.current.send(JSON.stringify({
              type: 'webcam',
              slotId: currentPlayerSlotId,
              frame: frameData
            }));
          }
        }
      };
      
      mockWorkerRef.current.postMessage({ action: 'start', ms: 300 });
    } else {
       if (mockWorkerRef.current) {
         mockWorkerRef.current.postMessage({ action: 'stop' });
       }
    }

    return () => {
      // Don't kill worker on unmount unless needed, though unmount does clean it up.
      if (mockWorkerRef.current) {
        mockWorkerRef.current.postMessage({ action: 'stop' });
      }
    };
  }, [mockCameraEnabled, currentPlayerSlotId, activeTab]);

  // 3. Administrative / Host Control Messages
  const handleToggleLife = (slotId: number, aliveStatus: boolean) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const slot = gameState.slots.find(s => s.id === slotId);
      const lastSnapshot = slot?.webcamFrame || null;

      wsRef.current.send(JSON.stringify({
        type: 'toggle_life',
        slotId,
        alive: aliveStatus,
        lastSnapshot: !aliveStatus ? lastSnapshot : null // Pass snapshot to lock as death frame
      }));
    }
  };

  const handleUpdateSlotName = (slotId: number, currentName: string) => {
    const newName = prompt(`Редактировать имя игрока #${slotId}:`, currentName);
    if (newName !== null) {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'join',
          slotId,
          name: newName
        }));
      }
    }
  };

  const handleSetVictory = (victoryType: 'mafia' | 'civilians' | null) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'victory',
        victory: victoryType
      }));
    }
  };

  const handleResetGame = () => {
    if (confirm('Вы уверены, что хотите сбросить статус всех игроков и начать новую игру?')) {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'reset_game'
        }));
      }
    }
  };

  // 4. Lobby User Join / Leave actions
  const handleJoinLobby = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPlayerSlotId) {
      alert('Пожалуйста, выберите номер слота для участия в игре!');
      return;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'join',
        slotId: currentPlayerSlotId,
        name: playerNickname.trim()
      }));
      // Enable camera feed by default on join
      setIsWebcamActive(true);
    }
  };

  const handleLeaveLobby = () => {
    if (currentPlayerSlotId && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'leave',
        slotId: currentPlayerSlotId
      }));
      setIsWebcamActive(false);
      setMockCameraEnabled(false);
      setCurrentPlayerSlotId(null);
    }
  };

  // Helper selectors
  const hostSlot = gameState.slots.find(s => s.id === 12);
  const playerSlots = gameState.slots.filter(s => s.id !== 12);

  return (
    <div className="min-h-screen bg-wood-pattern text-stone-200 flex flex-col font-sans selection:bg-amber-950 selection:text-amber-200" id="mafia-app-root">
      
      {/* 1. Header & Branding Panels (Hidden completely in clean mode to allow pristine OBS captures) */}
      {!cleanMode && (
        <header className="bg-stone-950/70 py-4 px-6 border-b border-stone-800 shadow-md backdrop-blur-sm z-30 animate-fadeIn" id="header-bar">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            
            {/* Logo / Title (Strictly matching "Мафия Тафида") */}
            <div className="flex items-center gap-3" id="brand-panel">
              <div className="bg-amber-500/10 p-2.5 rounded-lg border border-gold/40 flex items-center justify-center shadow-lg" id="stamp-logo">
                <Skull className="w-8 h-8 text-gold animate-pulse" />
              </div>
              <div>
                <h1 className="text-3xl font-bold font-serif tracking-widest text-gold uppercase glow-text" id="brand-title">
                  Мафия Тафида
                </h1>
                <p className="text-xs font-mono text-stone-400 tracking-wider">
                  Twitch Stream Overlay & Host Deck
                </p>
              </div>
            </div>

            {/* Navigation Mode Selectors */}
            <div className="flex bg-stone-900 border border-stone-800 p-1.5 rounded-xl gap-1 shadow-inner" id="view-tabs">
              <button
                id="tab-overlay"
                onClick={() => setActiveTab('overlay')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === 'overlay' 
                    ? 'bg-amber-900/60 text-gold border border-gold/30 shadow' 
                    : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'
                }`}
              >
                <Tv className="w-4 h-4" />
                <span>Оверлей (Twitch/OBS)</span>
              </button>
              <button
                id="tab-player"
                onClick={() => setActiveTab('player')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === 'player' 
                    ? 'bg-amber-900/60 text-gold border border-gold/30 shadow' 
                    : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'
                }`}
              >
                <Camera className="w-4 h-4" />
                <span>Кабинет Участника</span>
              </button>
              <button
                id="tab-host"
                onClick={() => setActiveTab('host')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === 'host' 
                    ? 'bg-amber-900/60 text-gold border border-gold/30 shadow' 
                    : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'
                }`}
              >
                <Crown className="w-4 h-4" />
                <span>Пульт Ведущего</span>
              </button>
            </div>

            {/* Status Panel (Sound & Network Check) */}
            <div className="flex items-center gap-4" id="status-checks">
              {/* Sound Toggle and Elegant Volume Slider */}
              <div className="flex items-center gap-2 bg-stone-900 border border-stone-800 rounded-lg px-3 py-1.5" id="volume-wrapper">
                <button
                  id="sound-toggle"
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  className={`transition-colors cursor-pointer ${soundEnabled && volume > 0 ? 'text-gold hover:text-amber-400' : 'text-stone-500 hover:text-stone-350'}`}
                  title={soundEnabled ? 'Выключить звук' : 'Включить звук'}
                >
                  {soundEnabled && volume > 0 ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={soundEnabled ? volume : 0}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setVolume(val);
                    if (val > 0 && !soundEnabled) {
                      setSoundEnabled(true);
                    }
                  }}
                  className="w-16 md:w-20 h-1 bg-stone-700 accent-gold rounded-lg appearance-none cursor-pointer"
                  title={`Громкость: ${Math.round(volume * 100)}%`}
                />
                <span className="text-[10px] font-mono text-stone-500 w-8 text-right select-none">
                  {Math.round((soundEnabled ? volume : 0) * 100)}%
                </span>
              </div>

              {/* Network indicator */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-stone-950 rounded-lg border border-stone-800" id="connection-status">
                <span className={`w-2.5 h-2.5 rounded-full ${wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-xs font-mono text-stone-400">
                  {wsConnected ? 'СИНХРОНИЗАЦИЯ' : 'ОФФЛАЙН'}
                </span>
              </div>
            </div>

          </div>
        </header>
      )}

      {/* 2. Main Content View Area */}
      <main className={`flex-1 w-full mx-auto transition-all duration-300 ${cleanMode && activeTab === 'overlay' ? 'max-w-none p-2 min-h-screen flex flex-col justify-center' : 'max-w-7xl p-4 md:p-6'}`} id="view-container">

        {/* Clean Mode Hover Controller (Allows streamers to exit Clean Screen Mode easily) */}
        {cleanMode && activeTab === 'overlay' && (
          <div className="fixed top-4 right-4 z-50 opacity-10 hover:opacity-100 transition-opacity duration-300" id="clean-mode-floating-control">
            <button
              onClick={() => setCleanMode(false)}
              className="bg-stone-950/95 text-stone-200 hover:text-gold border border-stone-800 px-4 py-2 rounded-xl shadow-2xl flex items-center gap-2 text-xs font-mono font-bold hover:border-gold/30 cursor-pointer"
            >
              <Tv className="w-4 h-4 text-emerald-400" />
              <span>Показать панель управления</span>
            </button>
          </div>
        )}

        {/* ==================== A. OVERLAY MODE ==================== */}
        {activeTab === 'overlay' && (
          <div className={`animate-fadeIn ${cleanMode ? 'space-y-2' : 'space-y-6'}`} id="overlay-ui">
            
            {/* Upper Stage: Prominent Info Panel during setup & live status (Hidden in Clean Mode) */}
            {!cleanMode && (
              <div className="flex flex-col md:flex-row items-center justify-between bg-stone-950/80 p-5 rounded-xl border border-gold/20 shadow-xl gap-4" id="setup-banner">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs bg-red-950 text-red-450 font-mono px-2 py-0.5 rounded border border-red-800/40">РЕЖИМ ОБС</span>
                    <span className="text-xs text-stone-400">Данную страницу стример выводит на трансляцию через захват экрана</span>
                  </div>
                  <p className="text-stone-300 text-sm">
                    Участники заходят со своих устройств в <strong className="text-gold">"Кабинет Участника"</strong> для передачи веб-камер.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  {/* Status indicators */}
                  <div className="flex items-center gap-3 font-mono text-xs text-stone-400 bg-stone-900 border border-stone-850 px-3 py-1.5 rounded-lg">
                    <span>Живых: <strong className="text-emerald-400 text-sm">{gameState.slots.filter(s => s.id !== 12 && s.alive).length}</strong></span>
                    <span className="text-stone-700">|</span>
                    <span>Мертвых: <strong className="text-red-400 text-sm">{gameState.slots.filter(s => s.id !== 12 && !s.alive).length}</strong></span>
                  </div>

                  {/* OBS Clean Mode button */}
                  <button
                    onClick={() => setCleanMode(true)}
                    className="bg-amber-950/60 hover:bg-amber-900/80 text-gold border border-gold/35 px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 shadow-md cursor-pointer hover:scale-105 active:scale-95"
                    title="Спрятать шапку, кнопки и фон для чистого захвата камер на Twitch"
                  >
                    <Tv className="w-4 h-4 text-emerald-400 animate-pulse" />
                    <span>Чистая сетка (OBS)</span>
                  </button>
                </div>
              </div>
            )}

            {/* TWITCH WEB-CAMERA GRID GRID */}
            <div className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 gap-4 ${cleanMode ? 'md:gap-3 lg:gap-2' : ''}`} id="cams-grid">
              
              {/* Slots 1 to 11 (Players Group) */}
              {playerSlots.map((player) => {
                const recentFrame = webcamFramesRef.current[player.id] || player.webcamFrame;
                const hasFrame = !!recentFrame;
                
                return (
                  <div 
                    key={player.id} 
                    id={`overlay-player-${player.id}`}
                    className={`relative aspect-video rounded-xl overflow-hidden transition-all duration-500 flex flex-col justify-end ${
                      player.alive 
                        ? 'bg-leather-card border border-gold/15 shadow-xl hover:border-gold/30' 
                        : 'bg-leather-card-dead saturate-50 border border-red-950 shadow-md'
                    }`}
                  >
                    {/* Camera snapshot/live rendering container */}
                    <div className="absolute inset-0 w-full h-full bg-stone-950/95 flex items-center justify-center overflow-hidden">
                      {player.alive ? (
                        <>
                          {/* Live 16:9 camera feed, direct-DOM optimized to prevent lag/rendering dropouts */}
                          <img 
                            id={`cam-feed-${player.id}`}
                            src={recentFrame || ''} 
                            alt={player.name} 
                            className="w-full h-full object-cover aspect-video" 
                            referrerPolicy="no-referrer"
                            style={{ display: hasFrame ? 'block' : 'none' }}
                          />
                          
                          {/* Off-line camera tag */}
                          <div 
                            id={`cam-fallback-${player.id}`}
                            className="flex flex-col items-center gap-2 text-stone-700 animate-pulse"
                            style={{ display: hasFrame ? 'none' : 'flex' }}
                          >
                            <VideoOff className="w-7 h-7" />
                            <span className="text-[9px] font-mono tracking-widest uppercase">КАМЕРА ВЫКЛ</span>
                          </div>
                        </>
                      ) : (
                        // If dead - just show the offline screen with death tag, but keep original if needed, or normal styling
                        player.deathFrame ? (
                          <img 
                            src={player.deathFrame} 
                            alt={`${player.name} RIP`} 
                            className="w-full h-full object-cover aspect-video"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="flex flex-col items-center gap-1 text-red-950">
                            <Skull className="w-10 h-10 animate-bounce" />
                            <span className="text-[9px] font-mono tracking-widest text-red-900">МЕРТВ</span>
                          </div>
                        )
                      )}

                      {/* Dark gradient shadow behind labels */}
                      <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-black/90 to-transparent z-10" />
                    </div>

                    {/* Player Slot Labels (Nick & Slot Index) */}
                    <div className="relative z-10 p-2 flex items-center justify-between bg-stone-950/85 border-t border-stone-900" id={`label-player-${player.id}`}>
                      <div className="flex items-center gap-1.5 min-w-0" id={`user-details-${player.id}`}>
                        <span className="font-mono text-[11px] text-gold font-bold bg-amber-950/85 px-1.5 py-0.5 rounded border border-gold/30 leading-none">
                          {player.id}
                        </span>
                        <p className="font-semibold text-xs text-stone-200 truncate leading-none">
                          {player.name}
                        </p>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {player.connected ? (
                          <span className="text-[8px] font-mono bg-emerald-950/60 text-emerald-400 px-1 py-0.5 rounded border border-emerald-900/40">LIVE</span>
                        ) : (
                          <span className="text-[8px] font-mono bg-stone-900/60 text-stone-500 px-1 py-0.5 rounded border border-stone-850">DESK</span>
                        )}
                        
                        {player.alive ? (
                          <Heart className="w-3.5 h-3.5 text-emerald-500 fill-emerald-500/20 shrink-0" />
                        ) : (
                          <Skull className="w-3.5 h-3.5 text-red-500 shrink-0" />
                        )}
                      </div>
                    </div>

                    
                  </div>
                );
              })}

              {/* Host Webcamera Slot (Slot 12, always displayed as host at the bottom/end of grid) */}
              {hostSlot && (() => {
                const hostFrame = webcamFramesRef.current[12] || hostSlot.webcamFrame;
                const hasHostFrame = !!hostFrame;

                return (
                  <div 
                    id="overlay-host-card"
                    className="relative aspect-video rounded-xl overflow-hidden bg-leather-card border-gold border rounded-xl col-span-2 sm:col-span-1 shadow-2xl flex flex-col justify-end"
                  >
                    <div className="absolute inset-0 w-full h-full bg-stone-950/95 flex items-center justify-center overflow-hidden">
                      {/* Live 16:9 Host Webcam Feed, direct-DOM optimized */}
                      <img 
                        id="cam-feed-12"
                        src={hostFrame || ''} 
                        alt={hostSlot.name} 
                        className="w-full h-full object-cover aspect-video" 
                        referrerPolicy="no-referrer"
                        style={{ display: hasHostFrame ? 'block' : 'none' }}
                      />
                      
                      {/* Host offline tag */}
                      <div 
                        id="cam-fallback-12"
                        className="flex flex-col items-center gap-2 text-stone-700 text-center uppercase p-3 animate-pulse"
                        style={{ display: hasHostFrame ? 'none' : 'flex' }}
                      >
                        <Crown className="w-8 h-8 text-gold/25" />
                        <span className="text-[9px] font-mono tracking-widest">ВЕДУЩИЙ ВЫКЛ</span>
                      </div>
                      <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-black/90 to-transparent z-10" />
                    </div>

                    {/* Host Label bar with high glow crown status */}
                    <div className="relative z-10 p-2 flex items-center justify-between bg-stone-950/95 border-t border-gold/20" id="host-label-bar">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-center text-[10px] text-stone-950 font-bold bg-gold px-1.5 py-0.5 rounded leading-none">
                          👑
                        </span>
                        <p className="font-serif font-bold text-xs text-gold tracking-wider truncate leading-none uppercase">
                          {hostSlot.name}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span className="text-[8px] font-mono bg-amber-950/60 text-gold px-1.5 py-0.5 rounded border border-gold/20">ВЕДУЩИЙ</span>
                      </div>
                    </div>
                  </div>
                );
              })()}

            </div>
          </div>
        )}


        {/* ==================== B. PLAYER ROOM ==================== */}
        {activeTab === 'player' && (
          <div className="max-w-xl mx-auto bg-stone-950/80 p-6 rounded-2xl border border-gold/25 shadow-2xl space-y-6 animate-fadeIn" id="player-room-card">
            
            <div className="text-center pb-4 border-b border-stone-800" id="player-intro">
              <h2 className="text-2xl font-serif text-gold font-bold uppercase tracking-wider">Кабинет Участника Резидеции</h2>
              <p className="text-xs text-stone-400 mt-1">
                Подключайтесь, введите ник и транслируйте изображение вашей веб-камеры
              </p>
            </div>

            {/* Config setup before slot binding */}
            {!currentPlayerSlotId ? (
              <form onSubmit={handleJoinLobby} className="space-y-4" id="form-join">
                
                {/* 1. Enter nickname */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-mono text-stone-400 uppercase tracking-widest">Ваш Никнейм / Имя:</label>
                  <input
                    type="text"
                    required
                    maxLength={16}
                    placeholder="Например: Стример_Алекс"
                    value={playerNickname}
                    onChange={(e) => setPlayerNickname(e.target.value)}
                    className="w-full bg-stone-900 border border-stone-700 rounded-lg px-4 py-3 text-stone-100 placeholder-stone-500 focus:outline-none focus:border-gold/60 focus:ring-1 focus:ring-gold/30"
                  />
                </div>

                {/* 2. Choose player slot (1-11, or 12 for Host) */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-mono text-stone-400 uppercase tracking-widest">Выберите свободный Слот за столом:</label>
                  <div className="grid grid-cols-4 gap-2" id="slot-selector-grid">
                    {gameState.slots.map((slot) => {
                      const isOccupied = slot.connected;
                      return (
                        <button
                          key={slot.id}
                          type="button"
                          onClick={() => setCurrentPlayerSlotId(slot.id)}
                          className={`p-3 rounded-lg border text-center transition-all ${
                            isOccupied 
                              ? 'bg-stone-900 border-stone-800 text-stone-600 cursor-not-allowed' 
                              : 'border-stone-700 bg-stone-900 text-stone-300 hover:border-gold/50 hover:bg-stone-850'
                          }`}
                        >
                          <span className="block text-lg font-mono font-bold">{slot.id === 12 ? '👑' : slot.id}</span>
                          <span className="block text-[8px] truncate mt-1">
                            {slot.id === 12 ? 'Ведущий' : isOccupied ? slot.name : 'Свободно'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Submit trigger button */}
                <button
                  type="submit"
                  className="w-full bg-brass text-stone-950 font-bold py-3 px-6 rounded-lg transition-all transform hover:scale-[1.01] uppercase tracking-wider flex items-center justify-center gap-2 mt-6 cursor-pointer"
                  id="btn-join-lobby"
                >
                  <Play className="w-5 h-5 fill-stone-950" />
                  Присоединиться за стол
                </button>

              </form>
            ) : (
              // Connected state -> Render camera stream control
              <div className="space-y-6" id="player-connected-state">
                
                {/* Visual Status Panel */}
                <div className="bg-stone-900/60 p-4 rounded-xl border border-stone-800 flex items-center justify-between" id="slot-banner">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-amber-950/80 border border-gold/40 rounded-xl flex items-center justify-center">
                      <span className="text-xl font-mono text-gold font-bold">
                        {currentPlayerSlotId === 12 ? '👑' : currentPlayerSlotId}
                      </span>
                    </div>
                    <div>
                      <h3 className="font-serif text-lg text-gold font-bold">{gameState.slots.find(s => s.id === currentPlayerSlotId)?.name}</h3>
                      <p className="text-[10px] font-mono text-stone-400">Слот #{currentPlayerSlotId} • Подключен к сессии</p>
                    </div>
                  </div>

                  <button
                    onClick={handleLeaveLobby}
                    className="text-stone-500 hover:text-red-400 text-xs font-mono underline transition-colors cursor-pointer"
                  >
                    Выйти из слота
                  </button>
                </div>

                {/* Webcam Controls & Hidden buffers */}
                <div className="space-y-4" id="capture-console">
                  <div className="flex bg-stone-900 p-1.5 rounded-lg border border-stone-800 gap-2">
                    <button
                      onClick={() => {
                        setMockCameraEnabled(false);
                        setIsWebcamActive(!isWebcamActive);
                      }}
                      className={`flex-1 py-2 px-3 rounded text-xs font-medium transition-all cursor-pointer flex items-center justify-center gap-2 ${
                        isWebcamActive && !mockCameraEnabled 
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60' 
                          : 'bg-stone-950 text-stone-400 hover:text-stone-200'
                      }`}
                    >
                      <Video className="w-3.5 h-3.5" />
                      {isWebcamActive && !mockCameraEnabled ? 'Камера АКТИВНА' : 'Включить веб-камеру'}
                    </button>

                    <button
                      onClick={() => {
                        setIsWebcamActive(false);
                        setMockCameraEnabled(!mockCameraEnabled);
                      }}
                      className={`flex-1 py-2 px-3 rounded text-xs font-medium transition-all cursor-pointer flex items-center justify-center gap-2 ${
                        mockCameraEnabled 
                          ? 'bg-amber-950 text-gold border border-gold/30 shadow' 
                          : 'bg-stone-950 text-stone-400 hover:text-stone-200'
                      }`}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {mockCameraEnabled ? 'Демо-ФИД АКТИВЕН' : 'Запустить Демо-камеру'}
                    </button>
                  </div>

                  {/* Local Video Stream Preview */}
                  <div className="relative aspect-video rounded-xl overflow-hidden bg-stone-950 border border-stone-800 flex items-center justify-center" id="monitor-box">
                    <video 
                      ref={(el) => {
                        if (el && localStream && el.srcObject !== localStream) {
                          el.srcObject = localStream;
                        }
                      }} 
                      autoPlay
                      className={`w-full h-full object-cover transform scale-x-[-1] ${isWebcamActive && !mockCameraEnabled ? 'block' : 'hidden'}`}
                      muted 
                      playsInline
                    />
                    
                    {mockCameraEnabled && (
                      <div className="absolute inset-0 flex items-center justify-center bg-stone-950 text-center p-4">
                        <Sparkles className="w-10 h-10 text-gold/30 animate-spin mr-3" />
                        <div>
                          <p className="text-gold font-mono text-sm uppercase">Демонстрационный сигнал</p>
                          <p className="text-xs text-stone-500">Генерируется анимация для проверки OBS оверлея...</p>
                        </div>
                      </div>
                    )}

                    {!isWebcamActive && !mockCameraEnabled && (
                      <div className="text-center space-y-2 p-6 text-stone-600">
                        <VideoOff className="w-12 h-12 mx-auto" />
                        <p className="text-sm">Трансляция выключена.</p>
                        <p className="text-[10px] text-stone-500">Активируйте настоящую веб-камеру или Демо-камеру для вывода изображения</p>
                      </div>
                    )}
                  </div>

                  {/* Hidden worker canvases to generate JPG payloads */}
                  <canvas ref={canvasRef} className="hidden" />
                </div>

                <div className="bg-amber-950/20 border border-gold/15 p-4 rounded-xl space-y-2" id="connected-specs">
                  <h4 className="text-xs font-mono uppercase tracking-widest text-gold text-center">Как это работает?</h4>
                  <ul className="text-xs text-stone-400 list-disc list-inside space-y-1">
                    <li>Снимок вашего видео сжимается и транслируется всем зрителям.</li>
                    <li>Когда ведущий кликнет <strong className="text-red-400">"Убит"</strong> на пульте, ваш последний видеокадр заморозится и превратится в скриншот с траурной лентой.</li>
                    <li>Сверните эту вкладку (но не закрывайте), пока идет игра!</li>
                  </ul>
                </div>

              </div>
            )}

          </div>
        )}


        {/* ==================== C. HOST CONTROL PANEL ==================== */}
        {activeTab === 'host' && (
          <div className="space-y-6 animate-fadeIn" id="host-deck">
            
            {/* Real-time Administrator Master Controls Panel */}
            <div className="bg-stone-950/80 p-6 rounded-2xl border border-gold/25 shadow-2xl space-y-6" id="host-master-card">
              
              <div className="flex flex-col md:flex-row items-center justify-between pb-4 border-b border-stone-800 gap-4">
                <div>
                  <h2 className="text-2xl font-serif text-gold font-bold uppercase tracking-wider">Админ-Панель Ведущего</h2>
                  <p className="text-xs text-stone-400 mt-1">
                    Управляйте ролями, жизнями игроков и объявляйте доминирование над фракциями
                  </p>
                </div>

                {/* Master quick reset button */}
                <button
                  onClick={handleResetGame}
                  className="bg-red-800 hover:bg-red-700 text-stone-200 px-5 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-2 shadow-lg transition-colors border border-red-950 cursor-pointer"
                  id="btn-master-reset"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Сбросить новую игру</span>
                </button>
              </div>

              {/* Master Game end victory selectors */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4" id="victory-selectors">
                
                {/* 1. Mafia Win */}
                <button
                  onClick={() => handleSetVictory(gameState.victory === 'mafia' ? null : 'mafia')}
                  className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                    gameState.victory === 'mafia' 
                      ? 'bg-red-950 border-red-500 shadow-red-950/50 shadow-lg scale-[1.01]' 
                      : 'bg-stone-900 border-stone-800 text-stone-300 hover:bg-stone-850'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-red-500 font-serif font-bold uppercase text-base tracking-wide">Победа Мафии</span>
                    <ShieldAlert className="w-6 h-6 text-red-500" />
                  </div>
                  <p className="text-[11px] text-stone-400">
                    Окрашивает экран красным, воспроизводит мрачные басовые фанфары и замораживает живых.
                  </p>
                </button>

                {/* 2. Civilians Win */}
                <button
                  onClick={() => handleSetVictory(gameState.victory === 'civilians' ? null : 'civilians')}
                  className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                    gameState.victory === 'civilians' 
                      ? 'bg-emerald-950 border-emerald-500 shadow-emerald-950/50 shadow-lg scale-[1.01]' 
                      : 'bg-stone-900 border-stone-800 text-stone-300 hover:bg-stone-850'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-emerald-400 font-serif font-bold uppercase text-base tracking-wide">Победа Мирных</span>
                    <ShieldCheck className="w-6 h-6 text-emerald-400" />
                  </div>
                  <p className="text-[11px] text-stone-400">
                    Окрашивает экран зеленым, играет героический мажорный гимн.
                  </p>
                </button>

                {/* 3. Drop Victory State */}
                <button
                  disabled={gameState.victory === null}
                  onClick={() => handleSetVictory(null)}
                  className={`p-4 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-center ${
                    gameState.victory === null 
                      ? 'border-stone-850 bg-stone-950 text-stone-600 cursor-not-allowed opacity-50' 
                      : 'bg-stone-900 border-stone-850 text-stone-300 hover:bg-stone-850'
                  }`}
                >
                  <span className="font-serif font-bold text-sm text-amber-500 mb-1">Снять Победу</span>
                  <p className="text-[11px] text-stone-400">Отменяет статус победы мафии/мирных и возвращает обычный вид сетки.</p>
                </button>

              </div>

            </div>

            {/* Individual Table of Slots (Control Room list) */}
            <div className="bg-stone-950/80 rounded-2xl border border-stone-800 shadow-xl overflow-hidden" id="slots-deck-table">
              <div className="bg-stone-900 px-6 py-4 border-b border-stone-800 flex items-center justify-between" id="list-head">
                <span className="font-serif font-bold text-gold tracking-wide uppercase text-sm">Управление столом</span>
                <span className="text-xs font-mono text-stone-400">Всего слотов: 12 (11 Игроков, 1 Ведущий)</span>
              </div>

              <div className="divide-y divide-stone-800" id="list-body">
                {gameState.slots.map((slot) => {
                  const isHost = slot.id === 12;
                  return (
                    <div key={slot.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-stone-900/30 transition-colors">
                      
                      {/* Slot metadata */}
                      <div className="flex items-center gap-4 min-w-0">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-mono font-bold border ${
                          isHost 
                            ? 'bg-gold border-gold text-stone-950' 
                            : 'bg-stone-900 border-stone-700 text-stone-300'
                        }`}>
                          {isHost ? '👑' : slot.id}
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold text-stone-200 truncate">{slot.name}</h4>
                            <button
                              onClick={() => handleUpdateSlotName(slot.id, slot.name)}
                              className="text-stone-500 hover:text-gold transition-colors"
                              title="Изменить имя игрока"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          
                          <p className="text-xs text-stone-500 font-mono mt-0.5">
                            {isHost ? 'Хост вещания' : `Слот за столом #${slot.id}`} • 
                            {slot.connected ? (
                              <span className="text-emerald-500 font-bold ml-1">Онлайн</span>
                            ) : (
                              <span className="text-stone-600 ml-1">Отключен</span>
                            )}
                          </p>
                        </div>
                      </div>

                      {/* Visual status indicators and action buttons */}
                      <div className="flex items-center gap-3">
                        
                        {/* Status Label badge */}
                        <div className="text-right mr-2 hidden sm:block">
                          {slot.alive ? (
                            <span className="text-xs font-mono text-emerald-400 bg-emerald-950/50 border border-emerald-900/40 px-2 py-0.5 rounded">Живой</span>
                          ) : (
                            <span className="text-xs font-mono text-red-400 bg-red-950/50 border border-red-900/40 px-2 py-0.5 rounded">Убит</span>
                          )}
                        </div>

                        {/* Webcam Capture State Indicator */}
                        <div className="w-12 h-9 rounded bg-stone-950 border border-stone-850 overflow-hidden flex items-center justify-center" title="Мини-фид">
                          {slot.webcamFrame ? (
                            <img src={slot.webcamFrame} alt="Mini-Cam" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <VideoOff className="w-4 h-4 text-stone-800" />
                          )}
                        </div>

                        {/* Action buttons (Toggling live status) */}
                        {!isHost && (
                          <div className="flex bg-stone-900 p-1 rounded-lg border border-stone-800" id={`controls-life-${slot.id}`}>
                            <button
                              onClick={() => handleToggleLife(slot.id, true)}
                              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                                slot.alive 
                                  ? 'bg-emerald-800 text-stone-100 shadow' 
                                  : 'text-stone-500 hover:text-stone-300'
                              }`}
                            >
                              <Heart className="w-3 h-3 fill-current" />
                              <span>Жив</span>
                            </button>
                            <button
                              onClick={() => handleToggleLife(slot.id, false)}
                              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                                !slot.alive 
                                  ? 'bg-red-800 text-stone-100 shadow' 
                                  : 'text-stone-500 hover:text-stone-300'
                              }`}
                            >
                              <Skull className="w-3 h-3" />
                              <span>Убит</span>
                            </button>
                          </div>
                        )}

                      </div>

                    </div>
                  );
                })}
              </div>

            </div>

          </div>
        )}

      </main>

      {/* ========================================================================= */}
      {/* 3. EXTREMELY IMMERSIVE FULL-SCREEN EVENT OVERLAYS (SUDDEN ALERTS / VICTORYS) */}
      {/* ========================================================================= */}
      
      {/* --- A. KILL TRIGGER ANNOUNCEMENT ON DEATH --- */}
      <AnimatePresence>
        {showDeathOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 bg-black/95 z-50 flex flex-col items-center justify-center p-4 cursor-pointer overflow-hidden danger-vignette"
            id="death-screen-curtain"
            onClick={() => setShowDeathOverlay(null)}
          >
            {/* Rapid visual heartbeat shakes represent tragedy */}
            <motion.div
              initial={{ scale: 0.82, rotate: -3 }}
              animate={{ 
                scale: [1, 1.05, 1, 1.05, 1],
                rotate: [-2, 2, -2, 2, 0]
              }}
              transition={{ duration: 1.2, ease: 'easeInOut' }}
              className="text-center space-y-6"
            >
              {/* Ominous logo stamp */}
              <div className="inline-block bg-red-950 p-6 rounded-full border border-red-500 shadow-2xl " id="bullet-seal">
                <Skull className="w-24 h-24 text-red-500 animate-bounce" />
              </div>

              {/* Major Death banner text */}
              <div className="space-y-2">
                <h2 className="text-red-600 font-serif font-black text-6xl md:text-8xl tracking-widest uppercase text-shadow-lg leading-tight" id="badge-killed">
                  УБИТ ИГРОК!
                </h2>
                <div className="h-1 bg-red-600 w-48 mx-auto" />
              </div>

              {/* Character context label */}
              <p className="text-3xl font-serif text-stone-100 tracking-wide font-bold italic" id="badge-victim-name">
                "{showDeathOverlay}"
              </p>

              <p className="text-xs font-mono text-stone-500 uppercase tracking-widest pt-8 animate-pulse">
                Кликните для закрытия экрана смерти • Лента Смерти переносится на веб-камеру
              </p>

            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- B. VICTORY SCREEN OVERLAYS --- */}
      <AnimatePresence>
        {gameState.victory && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className={`fixed inset-0 z-40 flex flex-col items-center justify-center p-6 ${
              gameState.victory === 'mafia' 
                ? 'bg-stone-950/98 danger-vignette' 
                : 'bg-stone-950/98 success-vignette'
            }`}
            id="victory-curtain"
          >
            
            <motion.div
              initial={{ scale: 0.88, y: 30 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.88, y: 30 }}
              transition={{ type: 'spring', damping: 20 }}
              className="max-w-2xl text-center space-y-6 bg-stone-950/90 p-10 rounded-3xl border border-gold/30 shadow-2xl relative overflow-hidden"
              id="victory-achievement-box"
            >
              {/* Decorative dynamic ribbons background */}
              <div className="absolute top-0 inset-x-0 h-1.5 bg-gold" />

              {/* Thematic badge icons based on faction */}
              <div className="flex justify-center" id="faction-seal">
                {gameState.victory === 'mafia' ? (
                  <div className="bg-red-950/50 p-6 rounded-full border border-red-500/30">
                    <Skull className="w-20 h-20 text-red-500 animate-pulse" />
                  </div>
                ) : (
                  <div className="bg-emerald-950/50 p-6 rounded-full border border-emerald-500/30">
                    <Award className="w-20 h-20 text-emerald-400 animate-bounce" />
                  </div>
                )}
              </div>

              {/* Victory text alerts */}
              <div className="space-y-3">
                <h3 className="text-stone-400 font-mono text-xs uppercase tracking-widest">КОНЕЦ ИГРЫ</h3>
                
                <h2 className={`text-4xl md:text-6xl font-serif font-black tracking-widest uppercase leading-tight ${
                  gameState.victory === 'mafia' ? 'text-red-500' : 'text-emerald-400'
                }`} id="banner-victory-text">
                  {gameState.victory === 'mafia' ? 'Победа Мафии' : 'Победа Мирных'}
                </h2>

                <p className="text-stone-300 max-w-md mx-auto text-sm leading-relaxed">
                  {gameState.victory === 'mafia' ? (
                    'Закон и порядок пали. Преступный синдикат Мафии полностью зачистил город под контролем Мафии Тафида.'
                  ) : (
                    'Триумф правосудия! Честные мирные жители очистили город от преступной группировки.'
                  )}
                </p>
              </div>

              {/* Active display of webcams during victory */}
              <div className="py-2 flex justify-center gap-1.5 max-w-md mx-auto overflow-x-auto min-h-12 border-t border-b border-stone-800" id="victory-alliances">
                {gameState.slots.map(s => (
                  <div key={s.id} className="text-center shrink-0">
                    <div className={`w-8 h-8 rounded overflow-hidden border ${s.alive ? 'border-emerald-500 bg-emerald-950/40' : 'border-stone-800'}`}>
                      {s.webcamFrame ? (
                        <img src={s.webcamFrame} alt={s.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="text-[9px] font-bold text-stone-600 block pt-1.5">#{s.id}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-4" id="victory-actions">
                <button
                  onClick={() => handleSetVictory(null)}
                  className="px-6 py-2.5 rounded-lg font-bold border border-stone-700 bg-stone-900 text-stone-300 hover:bg-stone-850 transition-colors uppercase text-xs tracking-wider cursor-pointer"
                  id="btn-victory-dismiss"
                >
                  Вернуться на стол
                </button>
                <button
                  onClick={() => {
                    handleSetVictory(null);
                    // Reset game
                    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({ type: 'reset_game' }));
                    }
                  }}
                  className="px-6 py-2.5 rounded-lg font-bold bg-brass text-stone-950 hover:opacity-95 transition-all uppercase text-xs tracking-wider cursor-pointer"
                  id="btn-victory-restart"
                >
                  Начать новую игру
                </button>
              </div>

            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

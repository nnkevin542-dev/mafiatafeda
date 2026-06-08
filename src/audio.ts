// Programmatic synthesized audio engine using the browser's Web Audio API

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

// Gunshot + Tragic Resonance (for player deaths)
export function playGunshotSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // --- GUNSHOT POP ---
    // 1. Noise Node
    const bufferSize = ctx.sampleRate * 0.4; // 0.4 seconds
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noiseNode = ctx.createBufferSource();
    noiseNode.buffer = buffer;

    // Noise filter (lowpass to make it thud-like)
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.setValueAtTime(600, now);
    noiseFilter.frequency.exponentialRampToValueAtTime(10, now + 0.3);

    // Noise gain (quick decay)
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(1.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);

    noiseNode.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    // --- LOW EXP_THUD (Revolver Kick) ---
    const kickOsc = ctx.createOscillator();
    const kickGain = ctx.createGain();
    
    kickOsc.type = 'sine';
    kickOsc.frequency.setValueAtTime(150, now);
    kickOsc.frequency.exponentialRampToValueAtTime(30, now + 0.2);

    kickGain.gain.setValueAtTime(1.5, now);
    kickGain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);

    kickOsc.connect(kickGain);
    kickGain.connect(ctx.destination);

    // --- TRAGIC METALLIC CHIME (Suspense Resonator) ---
    // A spooky, ringing high metallic chime representing death
    const chimeFrequencies = [220, 330, 440, 523.25, 659.25, 783.99]; // Spooky stacked chord A minor
    chimeFrequencies.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      const delay = 0.05 + idx * 0.02;

      // Make some oscillators saws to give texture, others sines
      osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(freq, now + delay);

      oscGain.gain.setValueAtTime(0, now);
      oscGain.gain.linearRampToValueAtTime(0.12, now + delay + 0.05);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + delay + 1.8);

      osc.connect(oscGain);
      oscGain.connect(ctx.destination);

      osc.start(now + delay);
      osc.stop(now + delay + 2.0);
    });

    // Start transient bullet pop & body thud
    noiseNode.start(now);
    noiseNode.stop(now + 0.4);

    kickOsc.start(now);
    kickOsc.stop(now + 0.3);

  } catch (error) {
    console.warn('Failed to synthesize gunshot sound:', error);
  }
}

// Mafia Victory (Ominous, heavy minor synth/horns)
export function playMafiaVictorySound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Dark Minor Synthesized Chord: G-minor heavy organ
    const chord = [98.0, 116.54, 146.83, 196.0, 233.08, 293.66]; // G minor base

    chord.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      // Deep sawtooths for brassy menace
      osc.type = index < 3 ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(freq, now);

      // Lowpass sweeps for retro synthesis
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(200, now);
      filter.frequency.exponentialRampToValueAtTime(1000, now + 0.5);
      filter.frequency.exponentialRampToValueAtTime(150, now + 2.5);

      // Amplitude envelop: fade in slightly, then long decay
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 3.0);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 3.5);
    });

    // Spooky ambient bells at the end
    const bellFreqs = [392.00, 587.33, 783.99];
    bellFreqs.forEach((freq, idx) => {
      const bellOsc = ctx.createOscillator();
      const bellGain = ctx.createGain();
      const bellDelay = 0.8 + idx * 0.4;

      bellOsc.type = 'sine';
      bellOsc.frequency.setValueAtTime(freq, now + bellDelay);

      bellGain.gain.setValueAtTime(0, now);
      bellGain.gain.linearRampToValueAtTime(0.08, now + bellDelay + 0.05);
      bellGain.gain.exponentialRampToValueAtTime(0.001, now + bellDelay + 1.5);

      bellOsc.connect(bellGain);
      bellGain.connect(ctx.destination);

      bellOsc.start(now + bellDelay);
      bellOsc.stop(now + bellDelay + 1.8);
    });

  } catch (error) {
    console.warn('Failed to play Mafia Victory sound:', error);
  }
}

// Civilians Victory (Majestic, celebratory triumphant brass)
export function playCiviliansVictorySound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Triumphant Major Triad: C major / F major bright fanfare waves
    const baseChord = [130.81, 164.81, 196.00, 261.63, 329.63, 392.00, 523.25]; // C major

    baseChord.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      // Sawtooth/Triangle mix for bright horns
      osc.type = index % 2 === 0 ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      
      // Fanfare pitch rise sweep (heroic vibra)
      osc.frequency.linearRampToValueAtTime(freq * 1.01, now + 0.1);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800, now);
      filter.frequency.exponentialRampToValueAtTime(2200, now + 0.6);
      filter.frequency.linearRampToValueAtTime(1000, now + 2.5);

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.14, now + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 3.0);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 3.5);
    });

    // High celebratory chime arpeggio
    const harpNotes = [523.25, 659.25, 783.99, 1046.50];
    harpNotes.forEach((freq, idx) => {
      const harpOsc = ctx.createOscillator();
      const harpGain = ctx.createGain();
      const harpDelay = 0.4 + idx * 0.15;

      harpOsc.type = 'sine';
      harpOsc.frequency.setValueAtTime(freq, now + harpDelay);

      harpGain.gain.setValueAtTime(0, now);
      harpGain.gain.linearRampToValueAtTime(0.1, now + harpDelay + 0.02);
      harpGain.gain.exponentialRampToValueAtTime(0.001, now + harpDelay + 1.2);

      harpOsc.connect(harpGain);
      harpGain.connect(ctx.destination);

      harpOsc.start(now + harpDelay);
      harpOsc.stop(now + harpDelay + 1.5);
    });

  } catch (error) {
    console.warn('Failed to play Civilians Victory sound:', error);
  }
}

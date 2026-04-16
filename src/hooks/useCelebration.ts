import { useCallback, useRef } from 'react';
import { toast } from 'sonner';

const MILESTONES = [10, 25, 50, 75, 100, 150, 200];
const CONFETTI_MILESTONES = new Set([50, 75, 100, 150, 200]);

const MILESTONE_MESSAGES: Record<number, { emoji: string; title: string; sub: string }> = {
  10: { emoji: '🔥', title: '¡10 gestiones!', sub: 'Vas calentando motores' },
  25: { emoji: '💪', title: '¡25 gestiones!', sub: 'Estás en racha' },
  50: { emoji: '🚀', title: '¡50 gestiones!', sub: '¡Imparable!' },
  75: { emoji: '⭐', title: '¡75 gestiones!', sub: 'Eres una estrella' },
  100: { emoji: '🏆', title: '¡100 gestiones!', sub: '¡CENTENARIO! Leyenda total' },
  150: { emoji: '👑', title: '¡150 gestiones!', sub: 'Nivel élite alcanzado' },
  200: { emoji: '🎯', title: '¡200 gestiones!', sub: '¡Máquina absoluta!' },
};

const CONFETTI_COLORS = ['#00e5ff', '#00e676', '#ff5252', '#ffab40', '#7c4dff', '#ffd740', '#ff4081', '#18ffff'];

function launchConfetti(intensity: 'normal' | 'epic') {
  const count = intensity === 'epic' ? 150 : 80;
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;overflow:hidden;';
  document.body.appendChild(container);

  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const size = Math.random() * 8 + 4;
    const isCircle = Math.random() > 0.5;
    const startX = Math.random() * 100;
    const drift = (Math.random() - 0.5) * 200;
    const delay = Math.random() * 600;
    const duration = 2000 + Math.random() * 1500;
    const rotation = Math.random() * 720 - 360;

    piece.style.cssText = `
      position:absolute;
      top:-12px;
      left:${startX}%;
      width:${size}px;
      height:${isCircle ? size : size * 0.6}px;
      background:${color};
      border-radius:${isCircle ? '50%' : '2px'};
      opacity:1;
      animation:confetti-piece ${duration}ms ${delay}ms cubic-bezier(0.25,0.46,0.45,0.94) forwards;
      --drift:${drift}px;
      --rotation:${rotation}deg;
    `;
    container.appendChild(piece);
  }

  // Add keyframes if not present
  if (!document.getElementById('confetti-keyframes')) {
    const style = document.createElement('style');
    style.id = 'confetti-keyframes';
    style.textContent = `
      @keyframes confetti-piece {
        0% { transform: translateY(0) translateX(0) rotate(0deg) scale(1); opacity: 1; }
        25% { opacity: 1; }
        100% { transform: translateY(100vh) translateX(var(--drift)) rotate(var(--rotation)) scale(0.3); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  setTimeout(() => container.remove(), 4500);
}

// Shared AudioContext — reused across all playSound calls to avoid leaking
// system resources. Browsers limit the number of simultaneous AudioContexts;
// creating one per sound exhausted the limit on long sessions.
let sharedAudioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new AudioContext();
  }
  // Resume if suspended (Chrome auto-suspends until user gesture)
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

function playSound(type: 'milestone' | 'century') {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    if (type === 'century') {
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + i * 0.15);
        gain.gain.linearRampToValueAtTime(0.3, now + i * 0.15 + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.15);
        osc.stop(now + i * 0.15 + 0.5);
      });
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1174.66, now + 0.1);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch { /* Audio not supported */ }
}

// Restore previously celebrated milestones from sessionStorage so a page
// reload doesn't replay the confetti/sound for every milestone the operator
// already passed during this browser session.
function loadCelebrated(): Set<number> {
  try {
    const raw = sessionStorage.getItem('celebrated_milestones');
    if (raw) return new Set(JSON.parse(raw) as number[]);
  } catch { /* ignore */ }
  return new Set();
}
function saveCelebrated(set: Set<number>) {
  try { sessionStorage.setItem('celebrated_milestones', JSON.stringify([...set])); } catch { /* ignore */ }
}

export function useCelebration() {
  const celebratedRef = useRef<Set<number>>(loadCelebrated());

  const checkMilestone = useCallback((totalGestiones: number) => {
    for (const m of MILESTONES) {
      if (totalGestiones >= m && !celebratedRef.current.has(m)) {
        celebratedRef.current.add(m);
        saveCelebrated(celebratedRef.current);
        const info = MILESTONE_MESSAGES[m];
        if (!info) continue;

        playSound(m >= 100 ? 'century' : 'milestone');

        if (CONFETTI_MILESTONES.has(m)) {
          launchConfetti(m >= 100 ? 'epic' : 'normal');
        }

        toast(info.title, {
          description: info.sub,
          icon: info.emoji,
          duration: m >= 100 ? 6000 : 4000,
          className: 'celebration-toast',
        });

        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`${info.emoji} ${info.title}`, { body: info.sub });
        }
      }
    }
  }, []);

  const requestNotificationPermission = useCallback(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const resetCelebrations = useCallback(() => {
    celebratedRef.current.clear();
    saveCelebrated(celebratedRef.current);
  }, []);

  return { checkMilestone, requestNotificationPermission, resetCelebrations };
}

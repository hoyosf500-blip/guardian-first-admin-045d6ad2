import { useCallback, useRef } from 'react';
import { toast } from 'sonner';

const MILESTONES = [10, 25, 50, 75, 100, 150, 200];

const MILESTONE_MESSAGES: Record<number, { emoji: string; title: string; sub: string }> = {
  10: { emoji: '🔥', title: '¡10 gestiones!', sub: 'Vas calentando motores' },
  25: { emoji: '💪', title: '¡25 gestiones!', sub: 'Estás en racha' },
  50: { emoji: '🚀', title: '¡50 gestiones!', sub: '¡Imparable!' },
  75: { emoji: '⭐', title: '¡75 gestiones!', sub: 'Eres una estrella' },
  100: { emoji: '🏆', title: '¡100 gestiones!', sub: '¡CENTENARIO! Leyenda total' },
  150: { emoji: '👑', title: '¡150 gestiones!', sub: 'Nivel élite alcanzado' },
  200: { emoji: '🎯', title: '¡200 gestiones!', sub: '¡Máquina absoluta!' },
};

// Web Audio API celebration sounds
function playSound(type: 'milestone' | 'century') {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    if (type === 'century') {
      // Epic fanfare for 100+
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach((freq, i) => {
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
      // Quick chime for smaller milestones
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
  } catch {
    // Audio not supported
  }
}

export function useCelebration() {
  const celebratedRef = useRef<Set<number>>(new Set());

  const checkMilestone = useCallback((totalGestiones: number) => {
    for (const m of MILESTONES) {
      if (totalGestiones >= m && !celebratedRef.current.has(m)) {
        celebratedRef.current.add(m);
        const info = MILESTONE_MESSAGES[m];
        if (!info) continue;

        playSound(m >= 100 ? 'century' : 'milestone');

        toast(info.title, {
          description: info.sub,
          icon: info.emoji,
          duration: m >= 100 ? 6000 : 4000,
          className: 'celebration-toast',
        });

        // Browser notification (if permitted)
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
  }, []);

  return { checkMilestone, requestNotificationPermission, resetCelebrations };
}

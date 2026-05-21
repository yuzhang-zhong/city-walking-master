import {
  Button,
  IconButton,
  Pill,
  Row,
  Stack,
  Text,
  TextArea,
  useCanvasState,
} from "cursor/canvas";

// ═════════════════════════════════════════════════════════════════════════
//  CITY WALKING MASTER — a painted atlas of six districts
//  The map IS the page. Everything else floats above it as a component.
// ═════════════════════════════════════════════════════════════════════════

type CityId = "paris" | "newyork" | "london" | "tokyo" | "vienna" | "hongkong";

type Palette = {
  ink: string;
  street: string;
  accent: string;
  wash: string;
  whisper: string;
};

type Vec2 = { x: number; y: number };

type EventPin = {
  id: string;
  street: string;
  title: string;
  year: string;
  body: string;
  celebrityId: string;
  x: number;
  y: number;
};

type Suggestion = { q: string; a: string };

type Celebrity = {
  id: string;
  name: string;
  trade: string;
  lifespan: string;
  whisper: string;
  portrait: (p: Palette) => JSX.Element;
  suggestions: Suggestion[];
  voice: (q: string, ctx: { event?: EventPin; city: string }) => string;
};

type City = {
  id: CityId;
  city: string;
  district: string;
  era: string;
  about: string;
  palette: Palette;
  ambient: number[]; // chord frequencies (Hz)
  Map: (props: { palette: Palette }) => JSX.Element;
  celebrities: Celebrity[];
  events: EventPin[];
};

// ─────────────────────────────────────────────────────────────────────────
//  AMBIENT SOUND (Web Audio, synthesized — no asset files)
//  Globals persist across renders. Toggled imperatively from button presses.
// ─────────────────────────────────────────────────────────────────────────

type ActiveOsc = { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode };
let __ac: AudioContext | null = null;
let __master: GainNode | null = null;
let __delay: DelayNode | null = null;
let __active: ActiveOsc[] = [];

function ensureAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (__ac) return __ac;
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  __ac = new Ctx();
  __master = __ac.createGain();
  __master.gain.value = 0;
  // a faint feedback delay gives the pad a "room"
  __delay = __ac.createDelay(2.0);
  __delay.delayTime.value = 0.45;
  const feedback = __ac.createGain();
  feedback.gain.value = 0.32;
  const wet = __ac.createGain();
  wet.gain.value = 0.35;
  __master.connect(__delay);
  __delay.connect(feedback);
  feedback.connect(__delay);
  __delay.connect(wet);
  wet.connect(__ac.destination);
  __master.connect(__ac.destination);
  return __ac;
}

function stopAllOsc(at: number) {
  __active.forEach(({ osc, lfo }) => {
    try {
      osc.stop(at);
    } catch {}
    try {
      lfo.stop(at);
    } catch {}
  });
  __active = [];
}

function playCityAmbient(notes: number[]) {
  const ctx = ensureAudio();
  if (!ctx || !__master) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const now = ctx.currentTime;
  // fade master up
  __master.gain.cancelScheduledValues(now);
  __master.gain.setValueAtTime(__master.gain.value, now);
  __master.gain.linearRampToValueAtTime(0.085, now + 1.6);

  // stop existing notes with a tail
  stopAllOsc(now + 0.4);

  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? "triangle" : i % 2 === 0 ? "sine" : "sine";
    osc.frequency.value = freq;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900 + i * 220;
    lp.Q.value = 0.7;

    const g = ctx.createGain();
    const base = (i === 0 ? 0.28 : 0.16) / Math.sqrt(notes.length);
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(base, now + 1.4 + i * 0.3);

    // slow LFO swells the gain
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.07 + i * 0.035;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = base * 0.55;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);

    osc.connect(lp);
    lp.connect(g);
    g.connect(__master!);

    osc.start(now);
    lfo.start(now);
    __active.push({ osc, lfo, gain: g });
  });
}

function fadeOutAmbient() {
  if (!__ac || !__master) return;
  const now = __ac.currentTime;
  __master.gain.cancelScheduledValues(now);
  __master.gain.setValueAtTime(__master.gain.value, now);
  __master.gain.linearRampToValueAtTime(0, now + 0.9);
  stopAllOsc(now + 1.1);
}

// ─────────────────────────────────────────────────────────────────────────
//  WALKER + TOUR — global cancellation so re-clicks reset cleanly
// ─────────────────────────────────────────────────────────────────────────

let __tourTimer: number | null = null;
function cancelTour() {
  if (__tourTimer !== null) {
    clearTimeout(__tourTimer);
    __tourTimer = null;
  }
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearestEvent(pos: Vec2, events: EventPin[], radius: number): EventPin | null {
  let best: EventPin | null = null;
  let bd = Infinity;
  for (const e of events) {
    const d = distance(pos, { x: e.x, y: e.y });
    if (d < radius && d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
//  ENCOUNTER — celebrity pops out on arrival and introduces the place
// ─────────────────────────────────────────────────────────────────────────

type EncounterPhase = "pop" | "typing" | "ready";

type EncounterSnap = {
  eventId: string;
  celebId: string;
  phase: EncounterPhase;
  typedLen: number;
  introText: string;
  pulse: number;
};

let __introTimer: number | null = null;

function cancelIntroTyping() {
  if (__introTimer !== null) {
    clearInterval(__introTimer);
    __introTimer = null;
  }
}

function firstName(full: string): string {
  return full.split(" ")[0] ?? full;
}

function composeIntro(celeb: Celebrity, event: EventPin, revisit: boolean): string {
  if (revisit) {
    return `Back again at ${event.street}? ${celeb.whisper} ${event.body}`;
  }
  const openings = [
    `There you are — ${event.street}.`,
    `Ah. You found ${event.title}.`,
    `Good — you walked all the way to ${event.street}.`,
  ];
  const lead = openings[(event.title.length + celeb.name.length) % openings.length];
  const hook = celeb.suggestions[0]?.a ?? celeb.whisper;
  const trimmed =
    hook.length > 220 ? `${hook.slice(0, 217).trim()}…` : hook;
  return `${lead} ${celeb.whisper} ${event.body} ${trimmed}`;
}

function startIntroTyping(
  introText: string,
  onTick: (len: number) => void,
  onDone: () => void,
) {
  cancelIntroTyping();
  let len = 0;
  __introTimer = window.setInterval(() => {
    len += 1;
    onTick(len);
    if (len >= introText.length) {
      cancelIntroTyping();
      onDone();
    }
  }, 18);
}

function EncounterMotionStyles() {
  return (
    <style>{`
      @keyframes cwm-pop-in {
        0% { transform: scale(0.2) translateY(28px); opacity: 0; }
        55% { transform: scale(1.08) translateY(-6px); opacity: 1; }
        75% { transform: scale(0.96) translateY(2px); }
        100% { transform: scale(1) translateY(0); opacity: 1; }
      }
      @keyframes cwm-slide-up {
        0% { transform: translateY(36px); opacity: 0; }
        100% { transform: translateY(0); opacity: 1; }
      }
      @keyframes cwm-bob {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-5px); }
      }
      @keyframes cwm-dot {
        0%, 80%, 100% { opacity: 0.25; }
        40% { opacity: 1; }
      }
    `}</style>
  );
}

function TypingDots({ palette }: { palette: Palette }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, marginLeft: 6 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: palette.street,
            display: "inline-block",
            animation: `cwm-dot 1s ${i * 0.15}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

function SpeechBubble({
  side,
  palette,
  label,
  children,
  large,
}: {
  side: "user" | "celeb";
  palette: Palette;
  label?: string;
  children: string | JSX.Element;
  large?: boolean;
}) {
  const isUser = side === "user";
  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "92%",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {label && (
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: palette.ink,
            opacity: 0.55,
            alignSelf: isUser ? "flex-end" : "flex-start",
          }}
        >
          {label}
        </span>
      )}
      <div
        style={{
          padding: large ? "14px 16px" : "10px 12px",
          background: isUser ? palette.whisper : palette.wash,
          border: `1px solid ${palette.ink}33`,
          borderLeft: isUser ? `1px solid ${palette.ink}33` : `3px solid ${palette.street}`,
          borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
          fontSize: large ? 14 : 13,
          lineHeight: 1.55,
          color: palette.ink,
          fontFamily: isUser ? "inherit" : "Georgia, serif",
          fontStyle: isUser ? "normal" : "italic",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function MapCelebrityPop({
  event,
  celeb,
  palette,
  pulse,
}: {
  event: EventPin;
  celeb: Celebrity;
  palette: Palette;
  pulse: number;
}) {
  return (
    <g
      key={pulse}
      transform={`translate(${event.x} ${event.y - 58})`}
      pointerEvents="none"
      style={{ animation: "cwm-pop-in 0.65s cubic-bezier(0.34, 1.56, 0.64, 1)" }}
    >
      <rect
        x={-34}
        y={-8}
        width={68}
        height={78}
        rx={6}
        fill={palette.wash}
        stroke={palette.street}
        strokeWidth={1.4}
      />
      <foreignObject x={-30} y={-4} width={60} height={70}>
        <div style={{ width: 60, height: 70, overflow: "hidden" }}>
          <div style={{ transform: "scale(0.65)", transformOrigin: "top left" }}>
            {celeb.portrait(palette)}
          </div>
        </div>
      </foreignObject>
      <text
        x={0}
        y={82}
        textAnchor="middle"
        fontFamily={HAND_FONT}
        fontStyle="italic"
        fontSize={10}
        fill={palette.ink}
      >
        {firstName(celeb.name)}
      </text>
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  CITY MAPS — 600×420 painted plates. One <g> each, palette-injected.
//  The shared brush filter is defined once in <PaintedFilters />.
//  Hand-written labels use a cursive fallback stack so each platform picks
//  its own brush-style font.
// ─────────────────────────────────────────────────────────────────────────

const HAND_FONT =
  "'Bradley Hand', 'Brush Script MT', 'Segoe Script', 'Snell Roundhand', 'Apple Chancery', 'Lucida Handwriting', cursive";

function MapLabel({
  x,
  y,
  children,
  palette,
  size = 11,
  rotate = 0,
  anchor = "middle",
  opacity = 0.78,
  weight = 600,
  tone = "ink",
}: {
  x: number;
  y: number;
  children: string;
  palette: Palette;
  size?: number;
  rotate?: number;
  anchor?: "start" | "middle" | "end";
  opacity?: number;
  weight?: number;
  tone?: "ink" | "street" | "accent";
}) {
  const fill =
    tone === "street" ? palette.street : tone === "accent" ? palette.accent : palette.ink;
  return (
    <text
      x={x}
      y={y}
      transform={rotate ? `rotate(${rotate} ${x} ${y})` : undefined}
      fontFamily={HAND_FONT}
      fontStyle="italic"
      fontSize={size}
      fontWeight={weight}
      fill={fill}
      opacity={opacity}
      textAnchor={anchor}
      pointerEvents="none"
      // a very faint "pencil" stroke gives the text a drawn feel even when the
      // OS resolves to a plain cursive instead of Bradley Hand
      stroke={fill}
      strokeWidth={0.25}
      strokeOpacity={opacity * 0.4}
    >
      {children}
    </text>
  );
}

function ParisMap({ palette: p }: { palette: Palette }) {
  return (
    <g>
      <rect x={0} y={0} width={600} height={420} fill={p.wash} />
      {/* Sacré-Cœur silhouette */}
      <g fill={p.accent} stroke={p.ink} strokeWidth={1.4}>
        <path d="M 280 60 C 290 30, 310 30, 320 60 L 320 90 L 280 90 Z" />
        <path d="M 240 90 C 240 70, 360 70, 360 90 L 360 110 L 240 110 Z" />
        <circle cx={300} cy={50} r={4} fill={p.ink} />
      </g>
      {/* winding streets */}
      <g stroke={p.street} strokeWidth={6} fill="none" strokeLinecap="round" filter="url(#brush)">
        <path d="M 90 380 Q 200 360, 230 300 T 300 220 Q 340 180, 380 200 T 500 240" />
        <path d="M 80 320 Q 180 300, 220 270 T 300 230" />
        <path d="M 520 380 Q 460 340, 420 320 T 350 280" />
        <path d="M 110 230 Q 180 220, 230 240" />
        <path d="M 440 380 Q 460 340, 470 300" />
      </g>
      <g stroke={p.whisper} strokeWidth={2.5} fill="none" strokeLinecap="round">
        <path d="M 180 380 L 210 320" />
        <path d="M 340 380 L 350 320" />
        <path d="M 260 280 L 290 250" />
      </g>
      {/* Place du Tertre */}
      <rect x={250} y={250} width={40} height={28} fill={p.whisper} stroke={p.ink} strokeWidth={1.2} />
      <path d="M 254 256 L 286 256" stroke={p.ink} strokeWidth={0.8} />
      {/* Moulin de la Galette windmill */}
      <g stroke={p.ink} strokeWidth={1.2} fill={p.accent}>
        <rect x={485} y={228} width={18} height={26} />
        <circle cx={494} cy={222} r={4} fill={p.street} />
        <path d="M 494 222 L 482 210" />
        <path d="M 494 222 L 506 210" />
        <path d="M 494 222 L 482 234" />
        <path d="M 494 222 L 506 234" />
      </g>
      {/* trees */}
      <g fill={p.accent} stroke={p.ink} strokeWidth={1}>
        <circle cx={150} cy={350} r={8} />
        <path d="M 150 358 L 150 372" />
        <circle cx={420} cy={340} r={6} />
        <path d="M 420 346 L 420 360" />
      </g>
      {/* hand labels */}
      <MapLabel x={300} y={132} palette={p} size={12} tone="ink">Sacré-Cœur</MapLabel>
      <MapLabel x={494} y={272} palette={p} size={10} tone="street">Moulin</MapLabel>
      <MapLabel x={270} y={244} palette={p} size={9} tone="ink" opacity={0.7}>Pl. du Tertre</MapLabel>
      <MapLabel x={102} y={208} palette={p} size={9} tone="ink" opacity={0.65} anchor="start">Lapin Agile</MapLabel>
      <MapLabel x={398} y={186} palette={p} size={9} tone="ink" opacity={0.7} anchor="start">rue Lepic</MapLabel>
      <MapLabel x={60} y={50} palette={p} size={18} tone="ink" opacity={0.55} anchor="start" weight={500}>Montmartre</MapLabel>
    </g>
  );
}

function NewYorkMap({ palette: p }: { palette: Palette }) {
  return (
    <g>
      <rect x={0} y={0} width={600} height={420} fill={p.wash} />
      <g fill={p.whisper} opacity={0.65}>
        <circle cx={80} cy={70} r={36} />
        <circle cx={520} cy={360} r={50} />
      </g>
      <g stroke={p.street} strokeWidth={5} fill="none" strokeLinecap="round" filter="url(#brush)">
        <path d="M 60 130 L 540 138" />
        <path d="M 60 200 L 540 206" />
        <path d="M 60 270 L 540 274" />
        <path d="M 60 340 L 540 344" />
        <path d="M 160 100 L 168 380" />
        <path d="M 260 100 L 270 380" />
        <path d="M 360 100 L 366 380" />
        <path d="M 460 100 L 470 380" />
      </g>
      {/* Washington Square Park */}
      <g>
        <rect x={250} y={195} width={120} height={80} fill={p.whisper} stroke={p.ink} strokeWidth={1.2} />
        <path d="M 295 200 L 295 215 C 295 208, 325 208, 325 215 L 325 200 Z" fill={p.accent} stroke={p.ink} />
        <circle cx={270} cy={250} r={5} fill={p.accent} stroke={p.ink} strokeWidth={0.8} />
        <circle cx={350} cy={250} r={5} fill={p.accent} stroke={p.ink} strokeWidth={0.8} />
        <circle cx={310} cy={260} r={6} fill={p.accent} stroke={p.ink} strokeWidth={0.8} />
      </g>
      {/* yellow cab silhouette */}
      <g stroke={p.ink} strokeWidth={1.1} fill={p.street}>
        <rect x={75} y={150} width={36} height={10} />
        <path d="M 80 150 L 84 142 L 102 142 L 106 150 Z" />
        <circle cx={84} cy={162} r={3} fill={p.ink} />
        <circle cx={102} cy={162} r={3} fill={p.ink} />
      </g>
      {/* Stonewall flag stripe */}
      <g>
        <rect x={130} y={290} width={28} height={4} fill={p.accent} />
        <rect x={130} y={296} width={28} height={4} fill={p.street} />
      </g>
      {/* hand labels */}
      <MapLabel x={310} y={213} palette={p} size={10} tone="ink" opacity={0.8}>Washington Sq Park</MapLabel>
      <MapLabel x={144} y={314} palette={p} size={9} tone="street" opacity={0.9}>Stonewall</MapLabel>
      <MapLabel x={130} y={130} palette={p} size={9} tone="ink" opacity={0.65} anchor="start">MacDougal</MapLabel>
      <MapLabel x={232} y={130} palette={p} size={9} tone="ink" opacity={0.6} anchor="start">5th Ave</MapLabel>
      <MapLabel x={332} y={160} palette={p} size={9} tone="ink" opacity={0.6} anchor="start">Bleecker</MapLabel>
      <MapLabel x={540} y={50} palette={p} size={18} tone="ink" opacity={0.55} anchor="end" weight={500}>The Village</MapLabel>
    </g>
  );
}

function LondonMap({ palette: p }: { palette: Palette }) {
  return (
    <g>
      <rect x={0} y={0} width={600} height={420} fill={p.wash} />
      <g fill={p.whisper} opacity={0.7}>
        <ellipse cx={200} cy={150} rx={130} ry={50} />
        <ellipse cx={400} cy={300} rx={150} ry={60} />
      </g>
      <g stroke={p.street} strokeWidth={5} fill="none" strokeLinecap="round" filter="url(#brush)">
        <path d="M 60 150 L 540 158" />
        <path d="M 60 240 L 540 246" />
        <path d="M 60 330 L 540 336" />
        <path d="M 150 90 L 156 380" />
        <path d="M 300 90 L 306 380" />
        <path d="M 450 90 L 456 380" />
      </g>
      {/* squares */}
      <g stroke={p.ink} strokeWidth={1.2}>
        <rect x={170} y={170} width={110} height={50} fill={p.accent} opacity={0.55} />
        <circle cx={225} cy={195} r={10} fill={p.whisper} />
        <rect x={320} y={170} width={110} height={50} fill={p.accent} opacity={0.55} />
        <circle cx={375} cy={195} r={10} fill={p.whisper} />
        <rect x={170} y={260} width={260} height={50} fill={p.accent} opacity={0.45} />
        <circle cx={300} cy={285} r={14} fill={p.whisper} />
      </g>
      {/* British Museum façade */}
      <g stroke={p.ink} strokeWidth={1.2}>
        <rect x={460} y={172} width={70} height={50} fill={p.whisper} />
        {[465, 477, 489, 501, 513].map((x) => (
          <rect key={x} x={x} y={186} width={4} height={28} fill={p.ink} opacity={0.7} />
        ))}
        <path d="M 458 184 L 532 184" />
      </g>
      {/* Big Ben hint, lower-left */}
      <g stroke={p.ink} strokeWidth={1.2} fill={p.accent}>
        <rect x={90} y={336} width={14} height={44} />
        <circle cx={97} cy={342} r={4} fill={p.whisper} />
        <path d="M 90 332 L 104 332 L 102 336 L 92 336 Z" />
      </g>
      {/* umbrella */}
      <g stroke={p.ink} strokeWidth={1.2} fill="none">
        <path d="M 540 90 A 18 12 0 0 1 504 90" fill={p.accent} />
        <path d="M 522 90 L 522 110" />
        <path d="M 522 110 C 520 114, 526 114, 524 110" />
      </g>
      {/* hand labels */}
      <MapLabel x={225} y={234} palette={p} size={10} tone="ink" opacity={0.85}>Gordon Sq</MapLabel>
      <MapLabel x={375} y={234} palette={p} size={10} tone="ink" opacity={0.85}>Tavistock Sq</MapLabel>
      <MapLabel x={300} y={254} palette={p} size={11} tone="ink">Russell Sq</MapLabel>
      <MapLabel x={495} y={232} palette={p} size={9} tone="ink" opacity={0.85}>British Museum</MapLabel>
      <MapLabel x={120} y={388} palette={p} size={9} tone="street" opacity={0.9} anchor="start">Big Ben</MapLabel>
      <MapLabel x={60} y={50} palette={p} size={18} tone="ink" opacity={0.55} anchor="start" weight={500}>Bloomsbury</MapLabel>
    </g>
  );
}

function TokyoMap({ palette: p }: { palette: Palette }) {
  return (
    <g>
      <rect x={0} y={0} width={600} height={420} fill={p.wash} />
      {/* Sumida River */}
      <g fill={p.whisper}>
        <path d="M 0 320 Q 200 280, 360 240 T 600 160 L 600 220 Q 360 320, 200 360 T 0 380 Z" />
      </g>
      <path
        d="M 0 320 Q 200 280, 360 240 T 600 160"
        stroke={p.ink}
        strokeWidth={1}
        fill="none"
        opacity={0.4}
      />
      {/* streets */}
      <g stroke={p.street} strokeWidth={6} fill="none" strokeLinecap="round" filter="url(#brush)">
        <path d="M 200 380 L 280 130" />
        <path d="M 100 200 L 460 220" />
        <path d="M 380 380 L 360 230" />
        <path d="M 80 260 L 200 250" />
      </g>
      {/* pagoda */}
      <g stroke={p.ink} strokeWidth={1.4} fill={p.accent}>
        <g transform="translate(140 120)">
          <path d="M -22 60 L 22 60 L 18 50 L -18 50 Z" />
          <path d="M -18 50 L -22 38 L 22 38 L 18 50 Z" />
          <rect x={-12} y={50} width={24} height={10} />
          <path d="M -16 38 L -20 30 L 20 30 L 16 38 Z" />
          <rect x={-10} y={30} width={20} height={8} />
          <path d="M -14 24 L -18 16 L 18 16 L 14 24 Z" />
          <rect x={-8} y={16} width={16} height={8} />
          <path d="M -12 10 L 12 10 L 14 16 L -14 16 Z" />
          <path d="M 0 0 L 0 10" stroke={p.ink} strokeWidth={1} />
          <circle cx={0} cy={0} r={2} fill={p.ink} />
        </g>
      </g>
      {/* Kaminarimon + lantern */}
      <g stroke={p.ink} strokeWidth={1.6}>
        <rect x={260} y={180} width={60} height={14} fill={p.street} />
        <path d="M 256 194 L 324 194 L 320 200 L 260 200 Z" fill={p.ink} opacity={0.9} />
        <rect x={266} y={200} width={6} height={50} fill={p.ink} opacity={0.8} />
        <rect x={308} y={200} width={6} height={50} fill={p.ink} opacity={0.8} />
        <ellipse cx={290} cy={220} rx={14} ry={18} fill={p.street} stroke={p.ink} />
        <path d="M 278 214 L 302 214" stroke={p.ink} strokeWidth={0.6} />
        <path d="M 278 226 L 302 226" stroke={p.ink} strokeWidth={0.6} />
        <path d="M 284 220 L 296 220" stroke={p.wash} strokeWidth={1.2} />
      </g>
      {/* cherry blossoms */}
      <g fill={p.street} opacity={0.7}>
        {[
          [460, 90],
          [470, 100],
          [478, 86],
          [486, 104],
          [494, 94],
          [504, 100],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i % 2 ? 1.6 : 2.4} />
        ))}
      </g>
      {/* Hanayashiki coaster hint */}
      <g stroke={p.ink} strokeWidth={1} fill="none">
        <path d="M 380 320 C 400 300, 420 330, 440 310" />
        <path d="M 380 320 L 384 326" />
        <path d="M 440 310 L 440 318" />
      </g>
      {/* hand labels */}
      <MapLabel x={140} y={210} palette={p} size={10} tone="ink">Sensō-ji</MapLabel>
      <MapLabel x={290} y={260} palette={p} size={9} tone="street" opacity={0.85}>Kaminarimon</MapLabel>
      <MapLabel x={440} y={250} palette={p} size={11} tone="ink" opacity={0.7} rotate={-9}>Sumida-gawa 隅田川</MapLabel>
      <MapLabel x={410} y={336} palette={p} size={9} tone="ink" opacity={0.65}>Hanayashiki</MapLabel>
      <MapLabel x={520} y={50} palette={p} size={18} tone="ink" opacity={0.55} anchor="end" weight={500}>Asakusa 浅草</MapLabel>
    </g>
  );
}

function ViennaMap({ palette: p }: { palette: Palette }) {
  return (
    <g>
      <rect x={0} y={0} width={600} height={420} fill={p.wash} />
      {/* Ringstraße arc */}
      <g stroke={p.street} strokeWidth={6} fill="none" strokeLinecap="round" filter="url(#brush)">
        <path d="M 60 380 C 60 200, 200 80, 540 80" />
        <path d="M 540 80 C 560 220, 480 360, 280 380" />
        <path d="M 180 360 L 320 220" />
        <path d="M 320 220 L 460 180" />
        <path d="M 250 380 L 340 240" />
        <path d="M 200 240 L 420 260" />
      </g>
      {/* Stephansdom */}
      <g stroke={p.ink} strokeWidth={1.4}>
        <path d="M 330 220 L 320 260 L 340 260 Z" fill={p.accent} />
        <path d="M 312 260 L 348 260 L 350 290 L 310 290 Z" fill={p.accent} />
        <path d="M 305 290 L 355 290 L 360 320 L 300 320 Z" fill={p.accent} />
        <path d="M 330 200 L 330 220" />
        <circle cx={330} cy={198} r={2} fill={p.ink} />
      </g>
      {/* Secession golden cabbage */}
      <g>
        <rect x={150} y={290} width={70} height={50} fill={p.whisper} stroke={p.ink} strokeWidth={1.2} />
        <circle cx={185} cy={285} r={18} fill={p.accent} stroke={p.ink} strokeWidth={1.2} />
        <g stroke={p.ink} strokeWidth={0.6}>
          {[170, 178, 186, 194, 202].map((x) => (
            <path key={x} d={`M ${x} 270 L ${x} 300`} />
          ))}
          <path d="M 165 285 L 205 285" />
        </g>
      </g>
      {/* Café Central coffee */}
      <g stroke={p.ink} strokeWidth={1.2}>
        <ellipse cx={430} cy={310} rx={10} ry={4} fill={p.whisper} />
        <path d="M 420 310 L 422 322 C 422 326, 438 326, 438 322 L 440 310" fill={p.accent} />
        <path d="M 438 314 C 444 314, 444 322, 438 322" fill="none" />
        <path d="M 426 304 C 428 300, 430 300, 430 304" fill="none" opacity={0.6} />
      </g>
      {/* musical note */}
      <g fill={p.accent} stroke={p.ink} strokeWidth={1}>
        <path d="M 540 360 L 540 330 C 540 326, 552 328, 552 332 C 552 338, 540 336, 540 332" />
        <ellipse cx={538} cy={362} rx={6} ry={4} />
      </g>
      {/* Freud's couch hint */}
      <g stroke={p.ink} strokeWidth={1} fill={p.whisper}>
        <rect x={80} y={140} width={36} height={10} />
        <rect x={80} y={150} width={8} height={10} fill={p.accent} />
      </g>
      {/* hand labels */}
      <MapLabel x={330} y={340} palette={p} size={10} tone="ink">Stephansdom</MapLabel>
      <MapLabel x={185} y={356} palette={p} size={10} tone="accent" opacity={0.9}>Secession</MapLabel>
      <MapLabel x={430} y={340} palette={p} size={9} tone="ink" opacity={0.85}>Café Central</MapLabel>
      <MapLabel x={140} y={170} palette={p} size={9} tone="ink" opacity={0.75} anchor="start">Berggasse 19</MapLabel>
      <MapLabel x={240} y={120} palette={p} size={10} tone="ink" opacity={0.6} rotate={-25}>Ringstraße</MapLabel>
      <MapLabel x={540} y={50} palette={p} size={18} tone="ink" opacity={0.55} anchor="end" weight={500}>Innere Stadt</MapLabel>
    </g>
  );
}

function HongKongMap({ palette: p }: { palette: Palette }) {
  return (
    <g>
      <rect x={0} y={0} width={600} height={420} fill={p.wash} />
      {/* Victoria Harbour — diagonal blue/grey ribbon */}
      <g fill={p.whisper}>
        <path d="M 0 200 Q 200 180, 380 210 T 600 230 L 600 270 Q 380 250, 200 270 T 0 250 Z" />
      </g>
      <path
        d="M 0 200 Q 200 180, 380 210 T 600 230"
        stroke={p.ink}
        strokeWidth={0.8}
        fill="none"
        opacity={0.4}
      />
      <path
        d="M 0 270 Q 200 250, 380 270 T 600 290"
        stroke={p.ink}
        strokeWidth={0.6}
        fill="none"
        opacity={0.3}
      />
      {/* Kowloon side — top (TST) */}
      <g stroke={p.street} strokeWidth={5} fill="none" strokeLinecap="round" filter="url(#brush)">
        <path d="M 80 30 L 90 170" />
        <path d="M 200 30 L 210 170" />
        <path d="M 320 40 L 326 170" />
        <path d="M 60 90 L 440 100" />
        <path d="M 60 150 L 440 160" />
      </g>
      {/* Clock Tower (TST) */}
      <g stroke={p.ink} strokeWidth={1.2} fill={p.accent}>
        <rect x={130} y={130} width={10} height={36} />
        <rect x={126} y={120} width={18} height={12} />
        <path d="M 130 120 L 134 110 L 136 110 L 140 120 Z" fill={p.street} />
        <circle cx={135} cy={138} r={3} fill={p.wash} />
      </g>
      {/* Bruce Lee statue marker on Avenue of Stars */}
      <g stroke={p.ink} strokeWidth={1.1} fill={p.street}>
        <circle cx={260} cy={185} r={3} />
        <path d="M 260 188 L 260 196" />
        <path d="M 256 192 L 264 192" />
      </g>
      {/* Star Ferry crossing — diagonal track */}
      <g stroke={p.ink} strokeWidth={1.2} fill="none" strokeDasharray="3 4" opacity={0.6}>
        <path d="M 290 200 L 312 280" />
      </g>
      {/* a tiny ferry */}
      <g stroke={p.ink} strokeWidth={1} fill={p.accent}>
        <path d="M 296 232 L 304 232 L 306 240 L 294 240 Z" />
        <rect x={297} y={228} width={6} height={4} fill={p.whisper} />
      </g>
      {/* Hong Kong Island side — bottom */}
      <g stroke={p.street} strokeWidth={5} fill="none" strokeLinecap="round" filter="url(#brush)">
        {/* Connaught Rd along waterfront */}
        <path d="M 60 300 Q 200 296, 360 308 T 560 320" />
        {/* Queen's Rd Central */}
        <path d="M 60 340 Q 200 336, 360 348 T 560 360" />
        {/* Hollywood Rd curve through Sheung Wan/Central */}
        <path d="M 80 388 Q 180 360, 300 372 T 540 380" />
        {/* Mid-Levels escalator (vertical) */}
        <path d="M 260 296 L 264 388" />
        {/* north-south alleys */}
        <path d="M 130 300 L 134 388" />
        <path d="M 390 308 L 394 388" />
        <path d="M 470 312 L 474 388" />
      </g>
      {/* HSBC HQ */}
      <g stroke={p.ink} strokeWidth={1.2} fill={p.accent}>
        <rect x={350} y={310} width={20} height={42} />
        <path d="M 350 322 L 370 322" />
        <path d="M 350 334 L 370 334" />
      </g>
      {/* Bank of China — angular spire */}
      <g stroke={p.ink} strokeWidth={1.2} fill={p.whisper}>
        <path d="M 400 320 L 416 296 L 432 320 L 432 358 L 400 358 Z" />
        <path d="M 416 296 L 416 358" />
        <path d="M 400 326 L 432 326" />
      </g>
      {/* Mandarin Oriental */}
      <g stroke={p.ink} strokeWidth={1.1} fill={p.accent}>
        <rect x={300} y={318} width={16} height={34} />
        {[321, 326, 331, 336, 341, 346].map((y) => (
          <path key={y} d={`M 300 ${y} L 316 ${y}`} stroke={p.ink} strokeWidth={0.5} />
        ))}
      </g>
      {/* a few neon kanji */}
      <g fill={p.street} opacity={0.85}>
        <rect x={510} y={40} width={3} height={12} />
        <rect x={510} y={56} width={3} height={4} />
        <rect x={520} y={40} width={3} height={20} />
        <rect x={517} y={64} width={9} height={3} />
      </g>
      {/* Peak silhouette behind island */}
      <path
        d="M 60 396 Q 200 360, 360 380 T 560 396"
        fill="none"
        stroke={p.ink}
        strokeWidth={0.6}
        opacity={0.35}
      />
      {/* hand labels */}
      <MapLabel x={250} y={24} palette={p} size={11} tone="ink" opacity={0.85} anchor="start">Tsim Sha Tsui 尖沙咀</MapLabel>
      <MapLabel x={135} y={110} palette={p} size={9} tone="ink" opacity={0.85}>Clock Tower</MapLabel>
      <MapLabel x={252} y={206} palette={p} size={8} tone="street" opacity={0.9} anchor="end">Bruce Lee 李小龍</MapLabel>
      <MapLabel x={400} y={228} palette={p} size={12} tone="ink" opacity={0.65} rotate={-4}>Victoria Harbour 維港</MapLabel>
      <MapLabel x={326} y={272} palette={p} size={8} tone="ink" opacity={0.7} anchor="start" rotate={75}>Star Ferry</MapLabel>
      <MapLabel x={360} y={306} palette={p} size={9} tone="ink" opacity={0.85}>HSBC</MapLabel>
      <MapLabel x={416} y={292} palette={p} size={9} tone="ink" opacity={0.85}>BoC</MapLabel>
      <MapLabel x={285} y={328} palette={p} size={8} tone="ink" opacity={0.8} anchor="end">Mandarin</MapLabel>
      <MapLabel x={500} y={408} palette={p} size={12} tone="ink" opacity={0.7} anchor="end">Central 中環</MapLabel>
      <MapLabel x={90} y={408} palette={p} size={11} tone="ink" opacity={0.7} anchor="start">Sheung Wan 上環</MapLabel>
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  PORTRAIT HELPER + 42 PORTRAITS (compact line drawings, 80×96 viewBox)
// ─────────────────────────────────────────────────────────────────────────

function Sketch({
  ink,
  wash,
  size = 92,
  children,
}: {
  ink: string;
  wash: string;
  size?: number;
  children: JSX.Element;
}) {
  return (
    <svg viewBox="0 0 80 96" width={size} height={size * 1.15} style={{ display: "block" }}>
      <rect x={0} y={0} width={80} height={96} fill={wash} />
      <g stroke={ink} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {children}
      </g>
    </svg>
  );
}

// helper shape: a default head oval used by many portraits
function head(d?: string) {
  return (
    <path d={d ?? "M 22 26 C 22 14, 58 14, 58 28 C 60 46, 54 64, 40 68 C 26 64, 20 46, 22 28 Z"} />
  );
}

// ───── PARIS ─────────────────────────────────────────────────────────
const PORTRAIT_picasso = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head()}
      <ellipse cx={32} cy={36} rx={4} ry={2.6} fill={p.ink} />
      <circle cx={50} cy={38} r={1.3} fill={p.ink} />
      <path d="M 26 30 L 38 30" strokeWidth={1.6} />
      <path d="M 40 38 L 36 50 L 42 52" />
      <path d="M 34 58 L 46 58" strokeWidth={1.6} />
      <path d="M 18 78 L 62 78" />
      <path d="M 20 84 L 60 84" />
      <path d="M 22 90 L 58 90" />
      <path d="M 14 96 C 24 80, 56 80, 66 96" />
    </g>
  </Sketch>
);

const PORTRAIT_vangogh = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {/* gaunt face */}
      <path d="M 26 26 C 26 16, 54 16, 54 26 C 56 46, 50 62, 40 66 C 30 62, 24 46, 26 26 Z" />
      {/* red beard */}
      <path d="M 30 56 C 34 70, 46 70, 50 56" fill={p.street} stroke={p.ink} strokeWidth={1} />
      {/* hair — short crop */}
      <path d="M 26 22 C 30 14, 50 14, 54 22" strokeWidth={1.6} />
      {/* missing-ear bandage hint */}
      <path d="M 52 32 C 58 32, 58 44, 52 44" />
      <path d="M 56 36 L 60 38" />
      {/* haunted eyes */}
      <circle cx={34} cy={34} r={1.3} fill={p.ink} />
      <circle cx={46} cy={34} r={1.3} fill={p.ink} />
      <path d="M 30 30 L 38 28" />
      <path d="M 42 28 L 50 30" />
      {/* sharp nose */}
      <path d="M 40 36 L 38 48 L 42 48" />
      {/* pipe */}
      <path d="M 44 60 L 56 64" />
      <rect x={54} y={62} width={6} height={4} fill={p.ink} opacity={0.8} />
      <path d="M 18 92 C 28 78, 52 78, 62 92" />
    </g>
  </Sketch>
);

const PORTRAIT_renoir = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head()}
      {/* big bushy beard */}
      <path d="M 22 52 C 18 70, 24 82, 40 84 C 56 82, 62 70, 58 52 C 50 56, 30 56, 22 52 Z" fill={p.ink} opacity={0.85} />
      {/* receding hair */}
      <path d="M 28 18 C 34 12, 46 12, 52 18" />
      <path d="M 28 22 L 26 30" />
      <path d="M 52 22 L 54 30" />
      {/* gentle eyes */}
      <circle cx={32} cy={32} r={1.2} fill={p.ink} />
      <circle cx={48} cy={32} r={1.2} fill={p.ink} />
      <path d="M 27 28 L 36 27" />
      <path d="M 44 27 L 53 28" />
      <path d="M 40 34 L 38 44 L 42 44" />
      {/* small mouth peeking from beard */}
      <path d="M 35 50 C 38 52, 42 52, 45 50" />
      <path d="M 16 94 C 28 84, 52 84, 64 94" />
    </g>
  </Sketch>
);

const PORTRAIT_toulouse = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head("M 22 28 C 22 14, 58 14, 58 30 C 60 50, 54 66, 40 70 C 26 66, 20 50, 22 30 Z")}
      {/* round spectacles */}
      <circle cx={32} cy={36} r={4} />
      <circle cx={48} cy={36} r={4} />
      <path d="M 36 36 L 44 36" />
      <circle cx={32} cy={36} r={1.2} fill={p.ink} />
      <circle cx={48} cy={36} r={1.2} fill={p.ink} />
      {/* dark hair */}
      <path d="M 22 22 C 28 8, 52 8, 58 22" fill={p.ink} opacity={0.9} />
      {/* mustache & beard */}
      <path d="M 32 50 C 36 54, 44 54, 48 50" strokeWidth={1.6} />
      <path d="M 34 58 C 38 64, 42 64, 46 58" fill={p.ink} opacity={0.85} />
      <path d="M 40 40 L 38 50 L 42 50" />
      {/* bow tie + bowler hat brim */}
      <path d="M 18 14 C 30 8, 50 8, 62 14" strokeWidth={1.4} />
      <path d="M 32 80 L 40 76 L 48 80 L 44 84 L 36 84 Z" fill={p.street} stroke={p.ink} />
      <path d="M 12 96 C 24 86, 56 86, 68 96" />
    </g>
  </Sketch>
);

const PORTRAIT_satie = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head()}
      {/* pince-nez */}
      <circle cx={32} cy={36} r={3} />
      <circle cx={48} cy={36} r={3} />
      <path d="M 35 36 L 45 36" />
      <circle cx={32} cy={36} r={1} fill={p.ink} />
      <circle cx={48} cy={36} r={1} fill={p.ink} />
      {/* short hair side-parted */}
      <path d="M 26 22 L 40 18 L 54 22" />
      {/* pointed beard */}
      <path d="M 38 56 L 40 70 L 42 56" fill={p.ink} opacity={0.85} stroke={p.ink} />
      <path d="M 32 52 C 36 56, 44 56, 48 52" />
      <path d="M 40 38 L 38 50 L 42 50" />
      {/* high stiff collar + bowler */}
      <path d="M 14 80 L 24 76 L 56 76 L 66 80 L 60 96 L 20 96 Z" fill={p.ink} opacity={0.6} />
      <path d="M 32 76 L 32 84" stroke={p.wash} />
      <path d="M 48 76 L 48 84" stroke={p.wash} />
    </g>
  </Sketch>
);

const PORTRAIT_valadon = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 24 24 C 24 14, 56 14, 56 26 C 58 46, 50 64, 40 68 C 30 64, 22 46, 24 26 Z" />
      {/* dark hair pulled up with curls */}
      <path d="M 22 18 C 28 6, 52 6, 58 18 C 60 22, 60 26, 58 28" fill={p.ink} opacity={0.85} />
      <path d="M 28 14 C 26 10, 22 12, 22 16" />
      <path d="M 52 14 C 54 10, 58 12, 58 16" />
      {/* fierce eyes */}
      <path d="M 28 32 C 30 30, 36 30, 38 32" strokeWidth={1.5} />
      <path d="M 42 32 C 44 30, 50 30, 52 32" strokeWidth={1.5} />
      <circle cx={33} cy={34} r={1.3} fill={p.ink} />
      <circle cx={47} cy={34} r={1.3} fill={p.ink} />
      <path d="M 40 38 L 38 48 L 42 48" />
      {/* small set mouth */}
      <path d="M 36 56 C 39 58, 41 58, 44 56" strokeWidth={1.4} />
      {/* dress neckline */}
      <path d="M 16 92 L 28 78 L 52 78 L 64 92" />
      <path d="M 32 78 L 40 86 L 48 78" />
    </g>
  </Sketch>
);

const PORTRAIT_apollinaire = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 20 26 C 20 14, 60 14, 60 28 C 62 50, 54 66, 40 70 C 26 66, 18 50, 20 28 Z" />
      {/* head bandage (war wound) */}
      <path d="M 18 24 C 24 16, 56 16, 62 24" strokeWidth={2.4} stroke={p.wash} />
      <path d="M 16 28 L 64 28" strokeWidth={1.6} />
      <path d="M 16 32 L 64 32" strokeWidth={1.6} />
      <path d="M 60 28 L 66 36" />
      {/* big eyes */}
      <circle cx={32} cy={42} r={1.4} fill={p.ink} />
      <circle cx={48} cy={42} r={1.4} fill={p.ink} />
      <path d="M 28 39 L 36 39" />
      <path d="M 44 39 L 52 39" />
      <path d="M 40 46 L 38 56 L 42 56" />
      <path d="M 34 62 L 46 62" />
      {/* cravate */}
      <path d="M 36 78 L 40 84 L 44 78" fill={p.street} stroke={p.ink} />
      <path d="M 14 96 C 24 84, 56 84, 66 96" />
    </g>
  </Sketch>
);

// ───── NEW YORK ──────────────────────────────────────────────────────
const PORTRAIT_dylan = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 14 30 C 10 14, 22 6, 30 10 C 36 4, 50 4, 56 12 C 66 12, 72 22, 68 30 C 72 36, 68 44, 64 44" />
      <path d="M 16 32 C 18 24, 22 22, 26 24" />
      <path d="M 28 18 C 32 14, 38 14, 42 18" />
      <path d="M 50 16 C 54 18, 58 22, 60 28" />
      <path d="M 64 30 C 66 36, 64 42, 62 44" />
      <path d="M 22 38 C 22 56, 30 70, 40 72 C 50 70, 58 56, 58 38" />
      <ellipse cx={31} cy={42} rx={5} ry={3.5} fill={p.ink} />
      <ellipse cx={49} cy={42} rx={5} ry={3.5} fill={p.ink} />
      <path d="M 36 42 L 44 42" />
      <path d="M 35 60 L 45 60" />
      <path d="M 26 58 L 26 66" />
      <path d="M 54 58 L 54 66" />
      <rect x={28} y={62} width={24} height={4} fill={p.ink} />
    </g>
  </Sketch>
);

const PORTRAIT_kerouac = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head("M 22 24 C 22 12, 58 12, 58 26 C 60 46, 54 64, 40 68 C 26 64, 20 46, 22 26 Z")}
      {/* dark wavy hair */}
      <path d="M 22 20 C 28 10, 52 10, 58 20" fill={p.ink} opacity={0.9} />
      <path d="M 24 16 C 28 12, 36 12, 38 18" stroke={p.wash} strokeWidth={0.8} />
      {/* strong brows */}
      <path d="M 26 28 C 30 26, 36 26, 38 28" strokeWidth={1.5} />
      <path d="M 42 28 C 44 26, 50 26, 54 28" strokeWidth={1.5} />
      <circle cx={32} cy={32} r={1.3} fill={p.ink} />
      <circle cx={48} cy={32} r={1.3} fill={p.ink} />
      <path d="M 40 36 L 37 48 L 42 48" />
      <path d="M 34 56 L 46 56" />
      {/* lit cigarette */}
      <path d="M 46 58 L 60 56" />
      <circle cx={61} cy={56} r={1.4} fill={p.street} />
      <path d="M 62 54 L 66 50" stroke={p.whisper} strokeDasharray="1 2" />
      {/* flannel collar */}
      <path d="M 14 94 L 28 76 L 40 84 L 52 76 L 66 94" />
      <path d="M 28 76 L 28 90" stroke={p.street} strokeWidth={0.6} />
      <path d="M 52 76 L 52 90" stroke={p.street} strokeWidth={0.6} />
    </g>
  </Sketch>
);

const PORTRAIT_ginsberg = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 28 C 22 16, 58 16, 58 28 C 60 48, 54 64, 40 68 C 26 64, 20 48, 22 28 Z" />
      {/* tall forehead, balding crown */}
      <path d="M 26 18 C 28 22, 30 26, 28 28" opacity={0.5} />
      <path d="M 54 18 C 52 22, 50 26, 52 28" opacity={0.5} />
      {/* heavy black-rimmed glasses */}
      <rect x={26} y={32} width={12} height={9} rx={1} strokeWidth={1.6} />
      <rect x={42} y={32} width={12} height={9} rx={1} strokeWidth={1.6} />
      <path d="M 38 36 L 42 36" strokeWidth={1.5} />
      <circle cx={32} cy={36} r={1.2} fill={p.ink} />
      <circle cx={48} cy={36} r={1.2} fill={p.ink} />
      {/* huge bushy beard */}
      <path d="M 20 50 C 16 70, 24 86, 40 88 C 56 86, 64 70, 60 50 C 52 56, 28 56, 20 50 Z" fill={p.ink} opacity={0.88} />
      <path d="M 40 44 L 38 52 L 42 52" />
      {/* mala beads */}
      <g fill={p.street}>
        {[24, 30, 36, 42, 48, 54].map((x) => (
          <circle key={x} cx={x} cy={94} r={1.2} />
        ))}
      </g>
    </g>
  </Sketch>
);

const PORTRAIT_baldwin = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 26 C 22 14, 58 14, 58 28 C 60 50, 52 66, 40 70 C 28 66, 20 50, 22 28 Z" />
      {/* short cropped hair */}
      <path d="M 22 22 C 28 14, 52 14, 58 22" fill={p.ink} opacity={0.85} />
      {/* enormous eyes (Baldwin's defining feature) */}
      <ellipse cx={31} cy={36} rx={4.5} ry={3.2} fill={p.wash} stroke={p.ink} strokeWidth={1.2} />
      <ellipse cx={49} cy={36} rx={4.5} ry={3.2} fill={p.wash} stroke={p.ink} strokeWidth={1.2} />
      <circle cx={31} cy={36} r={1.8} fill={p.ink} />
      <circle cx={49} cy={36} r={1.8} fill={p.ink} />
      {/* strong brows */}
      <path d="M 25 30 C 28 28, 35 28, 38 30" strokeWidth={1.5} />
      <path d="M 42 30 C 45 28, 52 28, 55 30" strokeWidth={1.5} />
      <path d="M 40 40 L 38 50 L 42 50" />
      <path d="M 34 58 C 38 60, 42 60, 46 58" />
      {/* jacket lapels */}
      <path d="M 16 96 L 30 78 L 40 86 L 50 78 L 64 96" />
      <path d="M 30 78 L 30 96" stroke={p.ink} strokeWidth={0.6} />
      <path d="M 50 78 L 50 96" stroke={p.ink} strokeWidth={0.6} />
    </g>
  </Sketch>
);

const PORTRAIT_millay = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 24 24 C 24 12, 56 12, 56 24 C 58 44, 50 64, 40 68 C 30 64, 22 44, 24 24 Z" />
      {/* short bob */}
      <path d="M 22 20 C 28 10, 52 10, 58 20" fill={p.street} stroke={p.ink} />
      <path d="M 22 28 C 20 36, 22 44, 26 46" fill={p.street} stroke={p.ink} />
      <path d="M 58 28 C 60 36, 58 44, 54 46" fill={p.street} stroke={p.ink} />
      {/* slim brows */}
      <path d="M 28 30 L 36 30" />
      <path d="M 44 30 L 52 30" />
      <circle cx={32} cy={34} r={1.2} fill={p.ink} />
      <circle cx={48} cy={34} r={1.2} fill={p.ink} />
      <path d="M 40 38 L 38 48 L 42 48" />
      {/* bow lips */}
      <path d="M 36 56 C 38 54, 40 56, 40 56 C 40 56, 42 54, 44 56 C 44 58, 36 58, 36 56" fill={p.street} stroke={p.ink} />
      <path d="M 18 92 C 28 80, 52 80, 62 92" />
      {/* loose necklace */}
      <path d="M 28 82 C 36 88, 44 88, 52 82" fill="none" />
    </g>
  </Sketch>
);

const PORTRAIT_dthomas = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 26 C 22 14, 58 14, 58 28 C 60 50, 54 66, 40 70 C 26 66, 20 50, 22 28 Z" />
      {/* wild curly hair */}
      <path d="M 18 22 C 14 12, 26 6, 30 12 C 34 6, 46 6, 50 12 C 56 8, 66 14, 64 24 C 68 28, 66 36, 60 36" />
      <path d="M 22 18 C 24 22, 26 22, 28 18" />
      <path d="M 52 18 C 54 22, 56 22, 58 18" />
      {/* puffy face */}
      <circle cx={32} cy={36} r={1.3} fill={p.ink} />
      <circle cx={48} cy={36} r={1.3} fill={p.ink} />
      <path d="M 27 32 L 37 32" />
      <path d="M 43 32 L 53 32" />
      <path d="M 40 42 L 38 52 L 42 52" />
      <path d="M 34 58 C 38 60, 42 60, 46 58" />
      {/* tumbler of beer */}
      <rect x={50} y={74} width={10} height={12} fill={p.accent} stroke={p.ink} />
      <path d="M 50 78 L 60 78" stroke={p.wash} strokeWidth={2} />
      <path d="M 14 96 C 24 86, 56 86, 66 96" />
    </g>
  </Sketch>
);

const PORTRAIT_duchamp = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 50, 52 66, 40 70 C 28 66, 20 50, 22 24 Z" />
      {/* slicked-back hair */}
      <path d="M 22 16 L 40 12 L 58 16" fill={p.ink} opacity={0.9} />
      <path d="M 22 18 L 40 16 L 58 18" />
      {/* pipe + thin face */}
      <circle cx={32} cy={34} r={1.2} fill={p.ink} />
      <circle cx={48} cy={34} r={1.2} fill={p.ink} />
      <path d="M 28 30 L 36 30" />
      <path d="M 44 30 L 52 30" />
      <path d="M 40 38 L 37 50 L 42 50" />
      <path d="M 34 58 L 44 58" />
      {/* pipe */}
      <path d="M 44 60 L 56 64" />
      <rect x={54} y={62} width={8} height={4} fill={p.ink} opacity={0.8} />
      <path d="M 60 66 L 64 62" stroke={p.whisper} strokeDasharray="1 2" />
      {/* tie + jacket */}
      <path d="M 14 94 L 30 78 L 40 90 L 50 78 L 66 94" />
      <path d="M 38 78 L 40 92 L 42 78" fill={p.ink} opacity={0.7} />
    </g>
  </Sketch>
);

// ───── LONDON ────────────────────────────────────────────────────────
const PORTRAIT_woolf = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 24 22 C 24 10, 56 10, 56 24 C 58 46, 52 66, 40 70 C 28 66, 22 46, 24 24 Z" />
      <path d="M 40 12 L 40 26" />
      <path d="M 28 20 C 24 28, 22 36, 24 44" strokeWidth={1.5} />
      <path d="M 52 20 C 56 28, 58 36, 56 44" strokeWidth={1.5} />
      <path d="M 56 30 C 64 32, 64 44, 56 44" />
      <path d="M 28 38 C 30 40, 34 40, 36 38" />
      <path d="M 44 38 C 46 40, 50 40, 52 38" />
      <path d="M 40 40 L 39 54 L 42 55" />
      <path d="M 36 60 C 39 62, 41 62, 44 60" />
      <path d="M 26 78 C 32 74, 48 74, 54 78" />
      <path d="M 22 88 C 30 82, 50 82, 58 88" />
      <circle cx={40} cy={80} r={1.4} fill={p.ink} />
    </g>
  </Sketch>
);

const PORTRAIT_eliot = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 48, 52 66, 40 70 C 28 66, 20 48, 22 24 Z" />
      <path d="M 22 16 L 40 10 L 58 16" fill={p.ink} opacity={0.85} />
      {/* center part slicked */}
      <path d="M 40 10 L 40 22" stroke={p.wash} strokeWidth={1.5} />
      {/* round wire glasses */}
      <circle cx={32} cy={34} r={4} />
      <circle cx={48} cy={34} r={4} />
      <path d="M 36 34 L 44 34" />
      <circle cx={32} cy={34} r={1.2} fill={p.ink} />
      <circle cx={48} cy={34} r={1.2} fill={p.ink} />
      <path d="M 40 38 L 37 50 L 42 50" />
      <path d="M 34 58 L 46 58" />
      {/* thin mustache hint */}
      <path d="M 35 54 C 38 53, 42 53, 45 54" strokeWidth={1.5} />
      {/* banker tie */}
      <path d="M 14 96 L 30 78 L 40 90 L 50 78 L 66 96" />
      <path d="M 38 80 L 38 94 L 42 94 L 42 80" fill={p.street} stroke={p.ink} />
    </g>
  </Sketch>
);

const PORTRAIT_keynes = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 24 C 22 12, 58 12, 58 26 C 60 48, 52 66, 40 70 C 28 66, 20 48, 22 26 Z" />
      <path d="M 22 18 C 28 12, 52 12, 58 18" />
      {/* mustache (his signature) */}
      <path d="M 28 50 C 34 46, 46 46, 52 50" strokeWidth={2.2} />
      <path d="M 28 50 C 30 54, 34 54, 36 50" />
      <path d="M 44 50 C 46 54, 50 54, 52 50" />
      {/* eyes */}
      <circle cx={32} cy={36} r={1.3} fill={p.ink} />
      <circle cx={48} cy={36} r={1.3} fill={p.ink} />
      <path d="M 27 32 L 37 32" />
      <path d="M 43 32 L 53 32" />
      <path d="M 40 40 L 38 48 L 42 48" />
      <path d="M 36 60 L 44 60" />
      {/* high collar + bow tie */}
      <path d="M 18 92 L 28 76 L 52 76 L 62 92" />
      <path d="M 32 78 L 40 84 L 48 78 L 44 80 L 40 76 L 36 80 Z" fill={p.accent} stroke={p.ink} />
    </g>
  </Sketch>
);

const PORTRAIT_marx = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 44, 52 56, 40 58 C 28 56, 20 44, 22 24 Z" />
      {/* lion's mane hair */}
      <path d="M 16 24 C 12 12, 24 4, 32 8 C 38 4, 50 4, 56 10 C 66 8, 70 18, 64 24" fill={p.ink} opacity={0.9} />
      <path d="M 18 16 C 22 22, 28 22, 30 18" />
      <path d="M 50 18 C 52 22, 58 22, 62 16" />
      {/* eyes */}
      <circle cx={32} cy={30} r={1.3} fill={p.ink} />
      <circle cx={48} cy={30} r={1.3} fill={p.ink} />
      <path d="M 26 26 L 38 26" />
      <path d="M 42 26 L 54 26" />
      <path d="M 40 34 L 37 42 L 42 42" />
      {/* enormous beard */}
      <path d="M 14 48 C 10 70, 22 92, 40 94 C 58 92, 70 70, 66 48 C 54 56, 26 56, 14 48 Z" fill={p.ink} opacity={0.92} />
      <path d="M 32 56 L 32 80" stroke={p.wash} strokeWidth={0.6} />
      <path d="M 48 56 L 48 80" stroke={p.wash} strokeWidth={0.6} />
    </g>
  </Sketch>
);

const PORTRAIT_dickens = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 24 C 22 12, 58 12, 58 26 C 60 48, 52 64, 40 68 C 28 64, 20 48, 22 26 Z" />
      <path d="M 22 20 C 26 14, 36 14, 40 20" />
      <path d="M 58 20 C 54 14, 44 14, 40 20" />
      {/* long sideburns/goatee */}
      <path d="M 24 36 C 22 50, 28 60, 36 60" />
      <path d="M 56 36 C 58 50, 52 60, 44 60" />
      <path d="M 32 56 L 34 70 L 40 74 L 46 70 L 48 56" fill={p.ink} opacity={0.85} />
      <circle cx={32} cy={34} r={1.3} fill={p.ink} />
      <circle cx={48} cy={34} r={1.3} fill={p.ink} />
      <path d="M 28 30 L 36 30" />
      <path d="M 44 30 L 52 30" />
      <path d="M 40 38 L 38 48 L 42 48" />
      <path d="M 36 52 L 44 52" />
      <path d="M 14 96 L 24 78 L 56 78 L 66 96" />
      <path d="M 24 78 L 32 88 L 40 80 L 48 88 L 56 78" />
    </g>
  </Sketch>
);

const PORTRAIT_forster = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head()}
      <path d="M 22 18 C 28 10, 52 10, 58 18" />
      <path d="M 30 16 L 40 14 L 50 16" stroke={p.wash} />
      {/* mustache */}
      <path d="M 30 50 C 36 48, 44 48, 50 50" strokeWidth={1.8} />
      <circle cx={32} cy={34} r={1.3} fill={p.ink} />
      <circle cx={48} cy={34} r={1.3} fill={p.ink} />
      <path d="M 27 30 L 37 30" />
      <path d="M 43 30 L 53 30" />
      <path d="M 40 38 L 37 48 L 42 48" />
      <path d="M 36 58 L 44 58" />
      {/* bow tie */}
      <path d="M 32 80 L 40 84 L 48 80 L 44 82 L 40 78 L 36 82 Z" fill={p.accent} stroke={p.ink} />
      <path d="M 14 96 C 24 84, 56 84, 66 96" />
    </g>
  </Sketch>
);

const PORTRAIT_strachey = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 44, 54 56, 40 58 C 26 56, 20 44, 22 24 Z" />
      <path d="M 22 18 C 28 10, 52 10, 58 18" />
      {/* round glasses */}
      <circle cx={32} cy={32} r={3.5} />
      <circle cx={48} cy={32} r={3.5} />
      <path d="M 36 32 L 44 32" />
      <circle cx={32} cy={32} r={1} fill={p.ink} />
      <circle cx={48} cy={32} r={1} fill={p.ink} />
      <path d="M 40 36 L 38 44 L 42 44" />
      {/* enormous narrow beard */}
      <path d="M 32 50 L 30 92 L 40 96 L 50 92 L 48 50 C 46 54, 34 54, 32 50 Z" fill={p.ink} opacity={0.9} />
      <path d="M 36 50 C 38 52, 42 52, 44 50" />
    </g>
  </Sketch>
);

// ───── TOKYO ─────────────────────────────────────────────────────────
const PORTRAIT_hokusai = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 36 10 C 38 4, 46 4, 46 12" />
      <path d="M 34 14 L 48 14" strokeWidth={1.5} />
      <path d="M 24 22 C 30 16, 50 16, 56 22" />
      <path d="M 20 26 C 20 16, 60 16, 60 28 C 60 56, 52 68, 40 70 C 28 68, 20 56, 20 28 Z" />
      <path d="M 28 26 L 52 26" strokeWidth={0.8} />
      <path d="M 30 30 L 50 30" strokeWidth={0.8} />
      <path d="M 26 36 C 30 34, 36 34, 38 36" strokeWidth={1.8} />
      <path d="M 42 36 C 44 34, 50 34, 54 36" strokeWidth={1.8} />
      <path d="M 28 40 L 36 40" />
      <path d="M 44 40 L 52 40" />
      <path d="M 40 42 L 38 52 L 42 53" />
      <path d="M 30 56 C 36 60, 44 60, 50 56" />
      <path d="M 38 62 C 40 68, 42 68, 42 62" />
      <path d="M 18 86 L 40 74 L 62 86" />
    </g>
  </Sketch>
);

const PORTRAIT_hiroshige = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {/* samurai-era hairstyle */}
      <path d="M 30 8 C 36 4, 44 4, 50 8 L 50 14 L 30 14 Z" fill={p.ink} opacity={0.9} />
      <path d="M 32 14 L 48 14" strokeWidth={1.4} />
      <path d="M 22 22 C 28 16, 52 16, 58 22" fill={p.ink} opacity={0.85} />
      <path d="M 22 26 C 22 16, 58 16, 58 28 C 58 56, 50 68, 40 70 C 30 68, 22 56, 22 28 Z" />
      {/* narrow eyes */}
      <path d="M 28 36 L 36 36" strokeWidth={1.5} />
      <path d="M 44 36 L 52 36" strokeWidth={1.5} />
      <path d="M 40 40 L 38 50 L 42 50" />
      <path d="M 36 56 L 44 56" />
      {/* brush in hand at edge */}
      <path d="M 56 80 L 70 64" />
      <path d="M 70 64 C 72 60, 70 56, 66 58" fill={p.ink} />
      <path d="M 18 92 L 40 78 L 62 92" />
    </g>
  </Sketch>
);

const PORTRAIT_basho = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {/* shaved monk-traveler head */}
      <path d="M 22 26 C 22 14, 58 14, 58 28 C 60 50, 52 64, 40 68 C 28 64, 20 50, 22 28 Z" />
      <path d="M 26 18 C 32 12, 48 12, 54 18" opacity={0.5} />
      {/* contemplative eyes (closed/slits) */}
      <path d="M 28 36 C 30 38, 36 38, 38 36" strokeWidth={1.6} />
      <path d="M 42 36 C 44 38, 50 38, 52 36" strokeWidth={1.6} />
      <path d="M 40 40 L 38 50 L 42 50" />
      <path d="M 36 56 L 44 56" />
      {/* sparse beard */}
      <path d="M 36 60 L 37 70" />
      <path d="M 43 60 L 42 70" />
      <path d="M 40 62 L 40 72" />
      {/* straw hat brim (kasa) at top */}
      <path d="M 8 18 L 40 4 L 72 18" fill={p.accent} stroke={p.ink} />
      <path d="M 8 18 L 72 18" strokeWidth={1.4} />
      {/* robe */}
      <path d="M 14 96 L 28 76 L 40 84 L 52 76 L 66 96" />
    </g>
  </Sketch>
);

const PORTRAIT_kafu = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head()}
      <path d="M 22 18 C 28 10, 52 10, 58 18" fill={p.ink} opacity={0.9} />
      <path d="M 30 14 L 40 12 L 50 14" stroke={p.wash} />
      {/* small round glasses */}
      <circle cx={32} cy={34} r={3.2} />
      <circle cx={48} cy={34} r={3.2} />
      <path d="M 35 34 L 45 34" />
      <circle cx={32} cy={34} r={1} fill={p.ink} />
      <circle cx={48} cy={34} r={1} fill={p.ink} />
      <path d="M 40 38 L 38 48 L 42 48" />
      <path d="M 34 56 L 46 56" />
      {/* thin mustache */}
      <path d="M 34 52 C 38 50, 42 50, 46 52" strokeWidth={1.2} />
      {/* Western suit collar (he was the dandy of Asakusa) */}
      <path d="M 14 96 L 30 78 L 40 86 L 50 78 L 66 96" />
      <path d="M 38 78 L 38 92 L 42 92 L 42 78" fill={p.street} stroke={p.ink} />
    </g>
  </Sketch>
);

const PORTRAIT_ichiyo = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 24 24 C 24 12, 56 12, 56 24 C 58 46, 52 64, 40 68 C 28 64, 22 46, 24 24 Z" />
      {/* hair pulled high (Meiji-era marumage style) */}
      <path d="M 22 18 C 28 6, 52 6, 58 18 C 58 22, 56 24, 54 22 C 50 18, 30 18, 26 22 C 24 24, 22 22, 22 18 Z" fill={p.ink} opacity={0.92} />
      <path d="M 30 8 C 34 4, 46 4, 50 8" />
      {/* slight downturn eyes */}
      <path d="M 28 34 C 30 36, 34 36, 36 34" />
      <path d="M 44 34 C 46 36, 50 36, 52 34" />
      <circle cx={32} cy={34} r={1.1} fill={p.ink} />
      <circle cx={48} cy={34} r={1.1} fill={p.ink} />
      <path d="M 40 38 L 38 48 L 42 49" />
      <path d="M 36 56 C 38 58, 42 58, 44 56" />
      {/* kimono collar V */}
      <path d="M 12 96 L 28 76 L 40 88 L 52 76 L 68 96" />
      <path d="M 28 76 L 40 84" />
      <path d="M 52 76 L 40 84" />
    </g>
  </Sketch>
);

const PORTRAIT_kawabata = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 48, 52 66, 40 70 C 28 66, 20 48, 22 24 Z" />
      {/* sparse hair */}
      <path d="M 26 16 C 32 12, 48 12, 54 16" opacity={0.8} />
      <path d="M 32 12 L 32 18" opacity={0.5} />
      <path d="M 48 12 L 48 18" opacity={0.5} />
      {/* deep-set sad eyes */}
      <path d="M 26 32 L 38 32" strokeWidth={1.4} />
      <path d="M 42 32 L 54 32" strokeWidth={1.4} />
      <circle cx={32} cy={36} r={1.3} fill={p.ink} />
      <circle cx={48} cy={36} r={1.3} fill={p.ink} />
      {/* hollow cheeks */}
      <path d="M 26 46 C 28 50, 30 52, 32 50" opacity={0.6} />
      <path d="M 54 46 C 52 50, 50 52, 48 50" opacity={0.6} />
      <path d="M 40 40 L 38 50 L 42 50" />
      <path d="M 34 58 C 38 60, 42 60, 46 58" />
      {/* suit lapels */}
      <path d="M 16 96 L 30 76 L 40 86 L 50 76 L 64 96" />
      <path d="M 30 76 L 30 96" stroke={p.ink} strokeWidth={0.6} />
    </g>
  </Sketch>
);

const PORTRAIT_takeshi = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 24 C 22 12, 58 12, 58 26 C 60 50, 52 66, 40 70 C 28 66, 20 50, 22 26 Z" />
      <path d="M 22 18 C 28 10, 52 10, 58 18" fill={p.ink} opacity={0.85} />
      {/* facial tic — one eye slightly higher */}
      <circle cx={31} cy={34} r={1.4} fill={p.ink} />
      <circle cx={49} cy={36} r={1.4} fill={p.ink} />
      <path d="M 26 30 L 36 30" />
      <path d="M 44 32 L 54 32" />
      {/* nose */}
      <path d="M 40 38 L 38 48 L 42 48" />
      {/* deadpan mouth (slight smirk) */}
      <path d="M 34 56 L 46 56" strokeWidth={1.5} />
      <path d="M 46 56 C 48 54, 48 56, 48 56" strokeWidth={1.5} />
      {/* jacket */}
      <path d="M 16 96 L 30 78 L 40 86 L 50 78 L 64 96" />
      {/* small scar mark (motorcycle accident, 1994) */}
      <path d="M 56 28 L 60 32" opacity={0.7} />
    </g>
  </Sketch>
);

// ───── VIENNA ────────────────────────────────────────────────────────
const PORTRAIT_klimt = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 8, 58 8, 58 24 C 58 38, 56 46, 52 50" />
      <path d="M 30 14 C 36 12, 44 12, 50 14" strokeWidth={0.8} />
      <circle cx={32} cy={32} r={1.3} fill={p.ink} />
      <circle cx={48} cy={32} r={1.3} fill={p.ink} />
      <path d="M 26 28 C 30 26, 34 26, 36 28" strokeWidth={1.6} />
      <path d="M 44 28 C 46 26, 50 26, 54 28" strokeWidth={1.6} />
      <path d="M 40 34 L 38 42 L 42 42" />
      <path
        d="M 20 50 C 16 60, 18 72, 24 80 C 30 88, 50 88, 56 80 C 62 72, 64 60, 60 50 C 56 48, 48 54, 40 52 C 32 54, 24 48, 20 50 Z"
        fill={p.ink}
        opacity={0.92}
      />
      <path d="M 16 92 C 28 86, 52 86, 64 92" />
    </g>
  </Sketch>
);

const PORTRAIT_freud = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head()}
      <path d="M 22 18 C 28 12, 52 12, 58 18" fill={p.ink} opacity={0.5} />
      {/* round glasses */}
      <circle cx={32} cy={34} r={3.8} />
      <circle cx={48} cy={34} r={3.8} />
      <path d="M 36 34 L 44 34" />
      <circle cx={32} cy={34} r={1.1} fill={p.ink} />
      <circle cx={48} cy={34} r={1.1} fill={p.ink} />
      <path d="M 40 38 L 38 48 L 42 48" />
      {/* beard — squared off */}
      <path d="M 26 52 L 24 80 L 56 80 L 54 52 C 50 56, 30 56, 26 52 Z" fill={p.ink} opacity={0.92} />
      <path d="M 36 52 L 38 56 L 42 56 L 44 52" stroke={p.wash} />
      {/* cigar */}
      <path d="M 56 70 L 70 68" stroke={p.ink} strokeWidth={1.6} />
      <path d="M 70 68 L 74 64" stroke={p.whisper} strokeDasharray="1 2" />
      <path d="M 14 96 L 24 80 L 56 80 L 66 96" />
    </g>
  </Sketch>
);

const PORTRAIT_mozart = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 24 28 C 24 16, 56 16, 56 28 C 58 48, 50 64, 40 68 C 30 64, 22 48, 24 28 Z" />
      {/* powdered wig — curls on the sides */}
      <path d="M 22 18 C 28 10, 52 10, 58 18" fill={p.whisper} stroke={p.ink} strokeWidth={1.2} />
      <path d="M 14 32 C 8 28, 8 50, 18 52 C 24 50, 22 32, 22 30" fill={p.whisper} stroke={p.ink} strokeWidth={1.2} />
      <path d="M 66 32 C 72 28, 72 50, 62 52 C 56 50, 58 32, 58 30" fill={p.whisper} stroke={p.ink} strokeWidth={1.2} />
      {/* ribbon at back */}
      <path d="M 36 14 L 40 8 L 44 14" />
      {/* expressive eyes */}
      <ellipse cx={32} cy={38} rx={2.5} ry={1.6} fill={p.ink} />
      <ellipse cx={48} cy={38} rx={2.5} ry={1.6} fill={p.ink} />
      <path d="M 27 34 L 37 34" />
      <path d="M 43 34 L 53 34" />
      <path d="M 40 42 L 38 52 L 42 52" />
      <path d="M 34 60 C 38 62, 42 62, 46 60" />
      <path d="M 14 92 L 28 80 L 52 80 L 66 92" />
      <path d="M 36 80 L 40 86 L 44 80" fill={p.street} stroke={p.ink} />
    </g>
  </Sketch>
);

const PORTRAIT_mahler = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 48, 52 66, 40 70 C 28 66, 20 48, 22 24 Z" />
      <path d="M 22 16 C 28 8, 52 8, 58 16" fill={p.ink} opacity={0.85} />
      <path d="M 26 12 C 28 18, 32 16, 34 12" />
      {/* round wire glasses */}
      <circle cx={32} cy={34} r={3.6} />
      <circle cx={48} cy={34} r={3.6} />
      <path d="M 36 34 L 44 34" />
      <circle cx={32} cy={34} r={1.1} fill={p.ink} />
      <circle cx={48} cy={34} r={1.1} fill={p.ink} />
      {/* strong jaw, clean shaven */}
      <path d="M 40 38 L 38 48 L 42 48" />
      <path d="M 34 56 L 46 56" strokeWidth={1.4} />
      {/* high collar conductor */}
      <path d="M 14 96 L 28 80 L 52 80 L 66 96" />
      <path d="M 28 80 L 28 96" stroke={p.ink} strokeWidth={0.6} />
      <path d="M 52 80 L 52 96" stroke={p.ink} strokeWidth={0.6} />
    </g>
  </Sketch>
);

const PORTRAIT_schiele = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {/* angular gaunt face */}
      <path d="M 24 24 L 28 16 L 40 12 L 52 16 L 56 24 L 54 50 L 46 66 L 40 70 L 34 66 L 26 50 Z" />
      {/* spiky hair */}
      <path d="M 28 14 L 30 6 L 34 14" fill={p.ink} />
      <path d="M 36 12 L 38 4 L 42 12" fill={p.ink} />
      <path d="M 44 14 L 48 6 L 52 14" fill={p.ink} />
      <path d="M 24 18 L 28 14" fill={p.ink} />
      {/* haunted angular eyes */}
      <path d="M 26 30 L 32 28 L 36 32" strokeWidth={1.4} />
      <path d="M 44 32 L 48 28 L 54 30" strokeWidth={1.4} />
      <circle cx={31} cy={32} r={1.2} fill={p.ink} />
      <circle cx={49} cy={32} r={1.2} fill={p.ink} />
      <path d="M 40 38 L 36 48 L 42 50" />
      <path d="M 34 58 L 44 58" />
      <path d="M 16 96 L 30 80 L 40 86 L 50 80 L 64 96" />
    </g>
  </Sketch>
);

const PORTRAIT_wittgenstein = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 48, 52 64, 40 68 C 28 64, 20 48, 22 24 Z" />
      <path d="M 22 16 C 28 10, 52 10, 58 16" fill={p.ink} opacity={0.9} />
      {/* intense piercing eyes */}
      <circle cx={32} cy={32} r={1.6} fill={p.ink} />
      <circle cx={48} cy={32} r={1.6} fill={p.ink} />
      <path d="M 26 28 L 38 28" strokeWidth={1.6} />
      <path d="M 42 28 L 54 28" strokeWidth={1.6} />
      {/* sharp triangular nose */}
      <path d="M 40 36 L 36 48 L 42 50" strokeWidth={1.4} />
      {/* firm thin mouth */}
      <path d="M 34 58 L 46 58" strokeWidth={1.6} />
      <path d="M 14 94 L 28 78 L 52 78 L 66 94" />
      <path d="M 28 78 L 40 88 L 52 78" />
    </g>
  </Sketch>
);

const PORTRAIT_zweig = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head()}
      <path d="M 22 18 C 28 10, 52 10, 58 18" fill={p.ink} opacity={0.85} />
      {/* careful side part */}
      <path d="M 34 10 L 32 24" stroke={p.wash} />
      {/* mustache */}
      <path d="M 28 52 C 36 48, 44 48, 52 52" strokeWidth={2} />
      <path d="M 30 52 C 32 56, 36 56, 38 52" />
      <path d="M 42 52 C 44 56, 48 56, 50 52" />
      <circle cx={32} cy={34} r={1.3} fill={p.ink} />
      <circle cx={48} cy={34} r={1.3} fill={p.ink} />
      <path d="M 28 30 L 36 30" />
      <path d="M 44 30 L 52 30" />
      <path d="M 40 38 L 38 48 L 42 48" />
      <path d="M 36 60 L 44 60" />
      <path d="M 14 96 L 28 78 L 40 88 L 52 78 L 66 96" />
    </g>
  </Sketch>
);

// ───── HONG KONG ─────────────────────────────────────────────────────
const PORTRAIT_sunyatsen = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 48, 52 66, 40 70 C 28 66, 20 48, 22 24 Z" />
      {/* swept back hair */}
      <path d="M 22 18 L 40 12 L 58 18" fill={p.ink} opacity={0.9} />
      <path d="M 22 22 L 40 16 L 58 22" />
      {/* trim mustache */}
      <path d="M 30 50 C 36 48, 44 48, 50 50" strokeWidth={1.8} />
      <path d="M 30 50 C 32 54, 34 54, 36 50" />
      <path d="M 44 50 C 46 54, 48 54, 50 50" />
      <circle cx={32} cy={34} r={1.3} fill={p.ink} />
      <circle cx={48} cy={34} r={1.3} fill={p.ink} />
      <path d="M 26 30 L 38 30" />
      <path d="M 42 30 L 54 30" />
      <path d="M 40 38 L 38 48 L 42 48" />
      <path d="M 36 58 L 44 58" />
      {/* Zhongshan suit collar */}
      <path d="M 14 96 L 28 76 L 52 76 L 66 96" />
      <path d="M 28 76 L 40 88 L 52 76" />
      <path d="M 40 80 L 40 96" stroke={p.ink} strokeWidth={0.6} />
    </g>
  </Sketch>
);

const PORTRAIT_eileen = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 24 22 C 24 10, 56 10, 56 24 C 58 46, 52 66, 40 70 C 28 66, 22 46, 24 24 Z" />
      {/* permed waves */}
      <path d="M 22 18 C 18 14, 18 22, 22 22" fill={p.ink} opacity={0.85} />
      <path d="M 58 18 C 62 14, 62 22, 58 22" fill={p.ink} opacity={0.85} />
      <path d="M 22 14 C 28 6, 52 6, 58 14" fill={p.ink} opacity={0.9} />
      <path d="M 26 20 C 28 24, 32 24, 34 20" />
      <path d="M 46 20 C 48 24, 52 24, 54 20" />
      {/* almond eyes with eyeliner */}
      <path d="M 26 34 C 30 32, 36 32, 38 34" strokeWidth={1.5} />
      <path d="M 42 34 C 44 32, 50 32, 54 34" strokeWidth={1.5} />
      <circle cx={32} cy={36} r={1.2} fill={p.ink} />
      <circle cx={48} cy={36} r={1.2} fill={p.ink} />
      <path d="M 40 38 L 38 48 L 42 48" />
      {/* small red lips (cheongsam-era) */}
      <path d="M 36 56 C 38 58, 40 58, 40 58 C 40 58, 42 58, 44 56" fill={p.street} stroke={p.ink} />
      {/* cheongsam high collar */}
      <path d="M 22 96 L 26 76 L 54 76 L 58 96" />
      <path d="M 34 76 L 32 88 L 40 90 L 48 88 L 46 76" />
      <path d="M 32 78 L 40 84 L 48 78" stroke={p.street} strokeWidth={0.8} />
    </g>
  </Sketch>
);

const PORTRAIT_jinyong = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      {head()}
      <path d="M 26 16 C 32 12, 48 12, 54 16" opacity={0.7} />
      {/* black-rimmed glasses */}
      <rect x={25} y={31} width={13} height={9} rx={1} strokeWidth={1.6} />
      <rect x={42} y={31} width={13} height={9} rx={1} strokeWidth={1.6} />
      <path d="M 38 35 L 42 35" strokeWidth={1.4} />
      <circle cx={31} cy={35} r={1.1} fill={p.ink} />
      <circle cx={48} cy={35} r={1.1} fill={p.ink} />
      <path d="M 40 42 L 38 50 L 42 50" />
      <path d="M 36 58 L 44 58" />
      {/* round friendly cheeks */}
      <path d="M 22 50 C 26 56, 30 58, 32 56" opacity={0.4} />
      <path d="M 58 50 C 54 56, 50 58, 48 56" opacity={0.4} />
      <path d="M 14 96 L 30 80 L 40 86 L 50 80 L 66 96" />
      {/* small Chinese-style scroll */}
      <rect x={52} y={80} width={14} height={4} fill={p.accent} stroke={p.ink} />
    </g>
  </Sketch>
);

const PORTRAIT_brucelee = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 24 22 C 24 10, 56 10, 56 24 C 58 48, 50 68, 40 72 C 30 68, 22 48, 24 24 Z" />
      {/* iconic shaggy hair */}
      <path d="M 22 16 C 28 6, 52 6, 58 16" fill={p.ink} opacity={0.92} />
      <path d="M 22 22 C 22 26, 24 28, 26 26" fill={p.ink} opacity={0.9} />
      <path d="M 58 22 C 58 26, 56 28, 54 26" fill={p.ink} opacity={0.9} />
      {/* sharp focused eyes */}
      <path d="M 24 32 L 38 30" strokeWidth={1.8} />
      <path d="M 42 30 L 56 32" strokeWidth={1.8} />
      <circle cx={32} cy={34} r={1.5} fill={p.ink} />
      <circle cx={48} cy={34} r={1.5} fill={p.ink} />
      <path d="M 40 38 L 37 50 L 42 50" />
      {/* shouting mouth (fierce kiai) */}
      <ellipse cx={40} cy={60} rx={5} ry={3} fill={p.ink} />
      {/* yellow tracksuit collar */}
      <path d="M 14 96 L 28 76 L 40 84 L 52 76 L 66 96" fill={p.accent} stroke={p.ink} />
      <path d="M 28 76 L 30 96" stroke={p.ink} strokeWidth={0.5} />
      <path d="M 52 76 L 50 96" stroke={p.ink} strokeWidth={0.5} />
    </g>
  </Sketch>
);

const PORTRAIT_leslie = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 48, 52 66, 40 70 C 28 66, 20 48, 22 24 Z" />
      {/* soft side-swept hair */}
      <path d="M 22 18 C 26 8, 38 8, 42 14 C 46 8, 54 8, 58 16" fill={p.ink} opacity={0.92} />
      <path d="M 22 22 C 22 26, 26 28, 30 24" stroke={p.ink} />
      {/* gentle warm eyes */}
      <path d="M 26 32 C 30 30, 36 30, 38 32" strokeWidth={1.4} />
      <path d="M 42 32 C 44 30, 50 30, 54 32" strokeWidth={1.4} />
      <circle cx={32} cy={34} r={1.3} fill={p.ink} />
      <circle cx={48} cy={34} r={1.3} fill={p.ink} />
      <path d="M 40 38 L 38 48 L 42 48" />
      {/* soft smile */}
      <path d="M 34 58 C 38 62, 42 62, 46 58" strokeWidth={1.4} />
      {/* trench coat lapels (Days of Being Wild) */}
      <path d="M 12 96 L 26 76 L 40 88 L 54 76 L 68 96" />
      <path d="M 26 76 L 32 96" stroke={p.ink} strokeWidth={0.6} />
      <path d="M 54 76 L 48 96" stroke={p.ink} strokeWidth={0.6} />
    </g>
  </Sketch>
);

const PORTRAIT_wongkw = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 50, 52 66, 40 70 C 28 66, 20 50, 22 24 Z" />
      <path d="M 22 16 C 28 8, 52 8, 58 16" fill={p.ink} opacity={0.9} />
      {/* iconic dark sunglasses (he's never without them) */}
      <rect x={22} y={32} width={36} height={9} rx={1.5} fill={p.ink} />
      <path d="M 22 36 L 58 36" stroke={p.wash} strokeWidth={0.6} opacity={0.5} />
      <path d="M 40 38 L 38 50 L 42 50" />
      {/* small thoughtful mouth */}
      <path d="M 36 58 L 44 58" />
      {/* dark unbuttoned shirt */}
      <path d="M 14 96 L 28 76 L 40 88 L 52 76 L 66 96" />
      <path d="M 28 76 L 32 96" stroke={p.ink} strokeWidth={0.6} />
    </g>
  </Sketch>
);

const PORTRAIT_ipman = (p: Palette) => (
  <Sketch ink={p.ink} wash={p.wash}>
    <g>
      <path d="M 22 22 C 22 10, 58 10, 58 24 C 60 50, 52 66, 40 70 C 28 66, 20 50, 22 24 Z" />
      {/* neat side parting, greying */}
      <path d="M 22 18 L 40 12 L 58 18" fill={p.ink} opacity={0.7} />
      <path d="M 40 12 L 40 22" stroke={p.wash} />
      {/* calm narrow eyes */}
      <path d="M 26 32 L 38 32" strokeWidth={1.5} />
      <path d="M 42 32 L 54 32" strokeWidth={1.5} />
      <circle cx={32} cy={34} r={1.1} fill={p.ink} />
      <circle cx={48} cy={34} r={1.1} fill={p.ink} />
      <path d="M 40 38 L 38 48 L 42 48" />
      <path d="M 34 58 L 46 58" strokeWidth={1.5} />
      {/* traditional Chinese collar (Tang suit) */}
      <path d="M 14 96 L 28 78 L 40 84 L 52 78 L 66 96" />
      <path d="M 28 78 L 28 96" stroke={p.ink} strokeWidth={0.6} />
      <path d="M 52 78 L 52 96" stroke={p.ink} strokeWidth={0.6} />
      <path d="M 36 78 L 38 84 L 42 84 L 44 78" stroke={p.street} strokeWidth={0.8} />
    </g>
  </Sketch>
);

// ═════════════════════════════════════════════════════════════════════════
//  PALETTES + AMBIENT NOTES (Hz)
// ═════════════════════════════════════════════════════════════════════════

const PALETTE_paris: Palette = {
  ink: "#3a1f1a",
  street: "#a65141",
  accent: "#d4a574",
  wash: "#f3e9d8",
  whisper: "#e6d3b8",
};
const PALETTE_newyork: Palette = {
  ink: "#1f1a16",
  street: "#c4892b",
  accent: "#b04030",
  wash: "#ece2cd",
  whisper: "#d8c9aa",
};
const PALETTE_london: Palette = {
  ink: "#1f2a36",
  street: "#5a7088",
  accent: "#7a3a3a",
  wash: "#e8e6dd",
  whisper: "#cdd6dc",
};
const PALETTE_tokyo: Palette = {
  ink: "#16110e",
  street: "#b8323a",
  accent: "#1f1a14",
  wash: "#f1e8d6",
  whisper: "#d9c9a5",
};
const PALETTE_vienna: Palette = {
  ink: "#1c160a",
  street: "#1c160a",
  accent: "#c79a2a",
  wash: "#efe6cf",
  whisper: "#dccea0",
};
const PALETTE_hongkong: Palette = {
  ink: "#1a1410",
  street: "#c4322b",
  accent: "#d4a843",
  wash: "#ede5d0",
  whisper: "#bcc8be",
};

// ═════════════════════════════════════════════════════════════════════════
//  CELEBRITY DATA — 7 voices per city × 6 cities = 42 voices
//  Each has 5 deep starter questions plus a context-aware free-form voice.
// ═════════════════════════════════════════════════════════════════════════

// Voice factory — returns an in-character free-form responder.
// Each celebrity gets a small set of openers + closers in their cadence.
type VoiceProfile = {
  openers: string[];
  middles: (q: string) => string[];
  closers: string[];
};

function makeVoice(profile: VoiceProfile) {
  return (q: string, ctx: { event?: EventPin; city: string }) => {
    const trimmed = q.trim().replace(/[.?!]+$/, "");
    const o = profile.openers[trimmed.length % profile.openers.length];
    const m = profile.middles(trimmed)[trimmed.length % 3] ?? profile.middles(trimmed)[0];
    const c = profile.closers[trimmed.length % profile.closers.length];
    const place = ctx.event ? ` (we are standing at ${ctx.event.street}, after all)` : "";
    return `${o} ${m}${place}. ${c}`;
  };
}

// ───── PARIS · MONTMARTRE celebrities ────────────────────────────────
const CELEBS_paris: Celebrity[] = [
  {
    id: "picasso",
    name: "Pablo Picasso",
    trade: "Painter · Sculptor",
    lifespan: "1881–1973",
    whisper: "I came up the hill with nothing, and I painted everything.",
    portrait: PORTRAIT_picasso,
    suggestions: [
      { q: "What was the Bateau-Lavoir like?", a: "A wooden tenement we called the laundry-boat because the floor groaned like a barge in a storm. One tap. No heat. In winter the tea froze in the cup. But in that room, in 1907, I painted Les Demoiselles — and the 19th century quietly died on the rue Ravignan." },
      { q: "Why break the face into pieces?", a: "Because a face is not a moment. It is every angle the lover has ever seen — the cheek at breakfast, the jaw in argument, the half-smile at the door. I paint the truth of looking, not the polite lie of a single second." },
      { q: "Who did you drink with on the hill?", a: "Apollinaire, who could turn an evening into a manifesto. Max Jacob, who slept on my floor and read tarot at dawn. Modigliani, when he was sober — which was rarely. And a stray cat called Frika who walked across more of my canvases than most of my students." },
      { q: "What did Montmartre give you?", a: "It pretended it was not Paris. We climbed the steps to escape the Beaux-Arts and the dealers, and the city turned its back so we could work. Cheap rent. Steeper streets. Without the hill — no Demoiselles, no cubism, perhaps no Picasso at all." },
      { q: "How did you become famous?", a: "Slowly, then all at once. The collectors came: Gertrude Stein on the rue de Fleurus, the Russians Shchukin and Morozov. By 1910 I left the hill — fame is a kind of comfort, and comfort is the painter's quiet death." },
    ],
    voice: makeVoice({
      openers: ["That is a Sunday question, friend.", "Hm.", "An interesting question."],
      middles: (q) => [
        `${q} is, like all good questions, a sort of looking that does not yet know what it is looking at`,
        `${q} — I would have to draw the answer before I could speak it`,
        `you ask ${q.toLowerCase()}, but painting begins where words stop`,
      ],
      closers: ["Painting begins exactly there.", "Walk with me along the rue Lepic and we shall see.", "We can argue about it over absinthe at the Lapin Agile."],
    }),
  },
  {
    id: "vangogh",
    name: "Vincent van Gogh",
    trade: "Painter",
    lifespan: "1853–1890",
    whisper: "Theo's window looked out on the rooftops of Montmartre. I painted them and could not eat.",
    portrait: PORTRAIT_vangogh,
    suggestions: [
      { q: "Why did you come to Paris?", a: "Because in Holland the light was the colour of mud, and I had heard Theo speak of the Impressionists. I arrived in March 1886 and lived with my brother at 54 rue Lepic. Two years there changed everything — my palette opened like a window thrown wide." },
      { q: "Who did you meet on the hill?", a: "Bernard, Anquetin, Toulouse-Lautrec at Cormon's studio. Père Tanguy, who fed us in exchange for canvases and now owns half my Paris work. Gauguin came for dinner. We argued about colour the way other men argue about money." },
      { q: "Why so many self-portraits in Paris?", a: "Because I could not afford a model and the mirror was free. I painted myself twenty-three times in those two years — each one a small experiment in colour theory, with my own face as the canvas. The hat changes, the eyes do not." },
      { q: "What did Theo mean to you?", a: "Everything. He paid for the paint, the rent, the doctors. Without Theo there is no Vincent — every letter I wrote him is also a painting, sketched in the margin. We are buried side by side at Auvers; in death as in life, he carries the weight." },
      { q: "Why leave Paris for Arles?", a: "Because Paris was killing me — too much absinthe, too many arguments. I went south chasing yellow. The light of Provence is the light Delacroix promised and only the south can deliver. In Arles I painted my best year and then unravelled." },
    ],
    voice: makeVoice({
      openers: ["Brother,", "Forgive me — I think aloud.", "Theo would have known what to say."],
      middles: (q) => [
        `${q} is a question one paints, not answers — with chrome yellow if you can afford it, with ochre if you cannot`,
        `${q} — yes, the colour of that is somewhere between Prussian blue and the wheat at dusk`,
        `I think of ${q.toLowerCase()} the way I think of the cypresses: it grows toward something it cannot name`,
      ],
      closers: ["Write back if you can; I have no one else.", "I shall paint it tomorrow if the weather holds.", "The light is going. I must work."],
    }),
  },
  {
    id: "renoir",
    name: "Pierre-Auguste Renoir",
    trade: "Painter",
    lifespan: "1841–1919",
    whisper: "I paint with my prick, said Cézanne; I paint to make the world more beautiful, said I.",
    portrait: PORTRAIT_renoir,
    suggestions: [
      { q: "Tell me about the Moulin de la Galette.", a: "I rented a garden on the rue Cortot in 1875 so I could walk my Sunday painting to the bal each weekend. The dappled light through the acacias — that was the whole picture. I asked my friends to dance for free; the canvas hangs now at the Orsay and not one of them is still alive to recognise themselves." },
      { q: "Why the cheerful subjects?", a: "Because painting must be amiable. The world has enough rude things in it already. I leave the misery to Daumier — I paint what I would want hanging in my own room on a grey morning." },
      { q: "Who modelled for you?", a: "Suzanne Valadon, who was an acrobat before she was a painter. Aline Charigot, who became my wife. Margot Legrand, who died too young. And the Bohemian girls of the rue Saint-Vincent, who would sit for an apple and a glass of wine." },
      { q: "Why did you stay when others left?", a: "Pissarro went to Pontoise, Monet to Argenteuil, Cézanne home to Aix. I stayed because Paris is the only city that gives you both a model and a critic in the same afternoon. Eventually the rheumatism drove me south — but I painted until my brushes had to be tied to my wrist." },
      { q: "What about Cézanne?", a: "He was a bear with the manners of a peasant and the eye of a god. I went to L'Estaque to paint with him in 1882 — he taught me to look at the shoulder of an apple. Half of what I learned about form came from his quiet, furious thinking." },
    ],
    voice: makeVoice({
      openers: ["Charmant.", "Ah, you ask the painter who would rather paint than talk.", "Sit, sit — the light is still good."],
      middles: (q) => [
        `${q} — a brush is a slow tongue, but a more honest one`,
        `for ${q.toLowerCase()} I would need the right model and a Sunday afternoon`,
        `you ask about ${q.toLowerCase()}; I answer in oil`,
      ],
      closers: ["Stay for the bal — they will be dancing by four.", "There is wine if you are patient.", "Let us paint the answer instead."],
    }),
  },
  {
    id: "toulouse",
    name: "Henri de Toulouse-Lautrec",
    trade: "Painter · Lithographer",
    lifespan: "1864–1901",
    whisper: "I painted what the gas-lamp painted, and stayed up later than both.",
    portrait: PORTRAIT_toulouse,
    suggestions: [
      { q: "Why the Moulin Rouge?", a: "Because Zidler put my paintings on the wall and I never had to buy a drink again. From 1889 the Moulin Rouge was my studio after dark — La Goulue kicking, Valentin le Désossé folding himself in half, the gaslight turning every cheek the colour of an old bruise. I made the posters that made the place famous." },
      { q: "Who was La Goulue?", a: "Louise Weber, the Glutton — twenty years old, a laundress before she was a dancer, a queen for five seasons. She drank champagne from the patrons' glasses as she passed; she died forgotten in a caravan. I made her immortal in lithograph, which is the cruellest kind of immortality." },
      { q: "How do you make a poster?", a: "Flat shapes, no shading, hand-cut stones. The eye must catch it from across the boulevard at twenty paces. I learned this from Bonnard, who learned it from the Japanese, who learned it from looking properly. Everything I know is a kind of theft, made polite by colour." },
      { q: "Why the brothels?", a: "Because the women of the maisons closes were kinder than the women of the salons, and they did not hide what they were. I lived for weeks at a time at the rue d'Amboise and the rue des Moulins, and I painted them washing, eating, sleeping with each other. No mythology. Just the room." },
      { q: "What killed you?", a: "Cognac and syphilis, in equal measure. I was thirty-six. Do not be sorry; I had lived three lives by then. Tell the doorman at the Moulin Rouge I send my compliments — he still owes me a drink." },
    ],
    voice: makeVoice({
      openers: ["My dear,", "Sit on the stool — it is closer to my height.", "Garçon, another round."],
      middles: (q) => [
        `${q} — I would draw it on the back of this menu before the absinthe arrives`,
        `for ${q.toLowerCase()}, you must come to the Moulin tonight and watch La Goulue answer it with her knees`,
        `${q} is the kind of question one asks at four in the morning, which is the only honest hour`,
      ],
      closers: ["Come back tomorrow night — bring money.", "The poster will be on the wall by Friday.", "À votre santé."],
    }),
  },
  {
    id: "satie",
    name: "Erik Satie",
    trade: "Composer",
    lifespan: "1866–1925",
    whisper: "I wrote music to be ignored.",
    portrait: PORTRAIT_satie,
    suggestions: [
      { q: "Why the Chat Noir?", a: "Because Salis paid me three francs a night to play the piano while no one listened, which is the ideal arrangement for any composer. From 1887 I sat in the corner at 84 boulevard Rochechouart playing my Gymnopédies before they had been published, and the regulars complained that the music was 'too sad to drink to'." },
      { q: "What is 'furniture music'?", a: "Musique d'ameublement — music that should belong to the room the way the wallpaper does. You should be able to talk over it, eat in front of it, ignore it as you ignore the chairs. I composed the first pieces in 1917 with Milhaud. Half the audience listened intently and ruined the whole experiment." },
      { q: "Who were the Six?", a: "Six young composers — Milhaud, Poulenc, Honegger, Auric, Tailleferre, Durey — whom I adopted in the 1920s and named after no good reason. Cocteau called them mine; they called me father. I cured them of Debussy, which is the greatest gift one composer can give another." },
      { q: "Why move to Arcueil?", a: "Because Montmartre had become loud, and a man cannot compose under the singing of drunks. From 1898 I walked the ten kilometres back to Arcueil every night and the ten kilometres in every morning — twenty years, in the same grey velvet suit. The neighbours called me the Velvet Gentleman." },
      { q: "What was in your room?", a: "After I died they opened the apartment on the rue Cauchy. Two pianos stacked, one on top of the other. Twelve identical velvet suits. Hundreds of umbrellas. Letters I had written but never sent — including several to Suzanne Valadon, the only woman I ever loved. Six months in 1893; thirty-one years of silence after." },
    ],
    voice: makeVoice({
      openers: ["With respect:", "Please — speak softly; the piano is sleeping.", "Note the time: it is precisely the wrong hour for this."],
      middles: (q) => [
        `${q} is a question best answered in three slow chords and a long pause`,
        `for ${q.toLowerCase()} I have already composed the music; it lasts thirty seconds and is to be repeated forever`,
        `${q} — see Gnossienne No. 3, where I have written the same idea in a foreign key`,
      ],
      closers: ["You may show yourself out; the umbrella is mine.", "Please do not applaud — the music has not finished.", "I shall write it down if I remember."],
    }),
  },
  {
    id: "valadon",
    name: "Suzanne Valadon",
    trade: "Painter (formerly a circus acrobat)",
    lifespan: "1865–1938",
    whisper: "I posed for them all. Then I picked up the brush and showed them how to look.",
    portrait: PORTRAIT_valadon,
    suggestions: [
      { q: "How did you become a painter?", a: "I was a model first — for Renoir, for Toulouse-Lautrec, for Puvis de Chavannes. I fell from a trapeze at fifteen, so the circus was over. I watched the painters work, stole the pencils when they napped, and Degas saw my drawings in 1894 and said: you are one of us. I never apologised for arriving by the back door." },
      { q: "Tell me about Maurice.", a: "My son Maurice Utrillo, born 1883 — I was eighteen, the father was never quite settled. He painted Montmartre from postcards, drunk by noon, and became more famous than I am. I committed him to the asylum more than once. I loved him completely and could not save him from himself." },
      { q: "Why nude self-portraits at sixty?", a: "Because I refused to disappear politely. The Salon expected old women to paint flowers and forget themselves; I painted my own body at every age that was given to me. The 1931 self-portrait is the answer to every man who ever told me what a woman ought to look like." },
      { q: "What about André Utter?", a: "Twenty years younger than me. We met when he was Maurice's friend. We married in 1914 — the trinity, they called us, the three of us painting in the same house on the rue Cortot. He left eventually. They always do, but I had the paintings, and the paintings stay." },
      { q: "Who was Degas to you?", a: "The only one who treated me like a colleague before I had earned the title. He bought my drawings, hung them above his bed. When I doubted, he told me to draw harder. He was a difficult man — everyone says so — but to me he was the unlocked door." },
    ],
    voice: makeVoice({
      openers: ["Listen.", "I'll tell you straight.", "Sit — I am not finished working."],
      middles: (q) => [
        `${q} is the kind of thing they used to ask my models, never me`,
        `for ${q.toLowerCase()} you want a soft answer; I do not have one in stock`,
        `${q} — I will tell you, but you must not flinch`,
      ],
      closers: ["Now move. The light is going.", "Bring better wine next time.", "Maurice is sleeping it off; we have an hour."],
    }),
  },
  {
    id: "apollinaire",
    name: "Guillaume Apollinaire",
    trade: "Poet · Critic",
    lifespan: "1880–1918",
    whisper: "Under the Pont Mirabeau flows the Seine — and our loves.",
    portrait: PORTRAIT_apollinaire,
    suggestions: [
      { q: "What was a Saturday at the Lapin Agile?", a: "Frédé played his guitar, Picasso bought no drinks, Max Jacob recited as if the Last Judgement were at hand. Frédé's donkey Lolo signed a painting with his tail — we entered it at the Salon des Indépendants under the name Boronali. It won a prize. We were that kind of company." },
      { q: "Did you steal the Mona Lisa?", a: "I did not. But in 1911 someone did, and the prefect of police arrested me because I had once joked I would burn the Louvre. I spent six days in La Santé prison and Picasso refused to admit he knew me. I forgave him in 1917; I died in 1918; he is still painting." },
      { q: "What is a calligramme?", a: "A poem that draws itself. I wrote 'Il Pleut' as five vertical streams of letters falling down the page; you read the rain. The eye and the ear should not be separate. Look at a Picasso, then read a Mallarmé — the same idea, twenty years apart, in two arts." },
      { q: "Why volunteer for the war?", a: "Because I was a Polish exile with a French name and I wanted to prove the name was mine. I took shrapnel to the head at Berry-au-Bac in March 1916, and I died of Spanish flu two days before the armistice. My calligrammes outlived me; the wound did the rest." },
      { q: "Who did you love?", a: "Marie Laurencin — six years that made and unmade us, and a painting at the Orangerie where she put herself among the muses. Madeleine Pagès, by letter, while I was at the front. Jacqueline Kolb, who married me in May 1918 while I was already dying. Each one a different vowel." },
    ],
    voice: makeVoice({
      openers: ["Ami,", "Listen — I am dictating.", "Hold the pen; I am wounded."],
      middles: (q) => [
        `${q} — write it down without the punctuation and you will see what it is really doing`,
        `for ${q.toLowerCase()} you need a calligramme: let the word make the shape of its meaning`,
        `${q} is the kind of question Picasso would refuse to answer and Satie would answer in silence`,
      ],
      closers: ["Mémoire et Mer — remember everything; forget nothing.", "Print it in the Mercure de France if you must.", "The Seine is still flowing, friend."],
    }),
  },
];

const EVENTS_paris: EventPin[] = [
  { id: "bateau", street: "13 rue Ravignan", title: "Bateau-Lavoir", year: "1907", body: "Picasso paints Les Demoiselles d'Avignon in a leaking wooden tenement. Cubism is conceived behind a single shared tap.", celebrityId: "picasso", x: 230, y: 270 },
  { id: "lepic", street: "54 rue Lepic", title: "Van Gogh & Theo", year: "1886–88", body: "Vincent shares a third-floor apartment with his brother. He paints the city's rooftops, meets Bernard, Toulouse-Lautrec, Gauguin, and produces 23 self-portraits.", celebrityId: "vangogh", x: 380, y: 200 },
  { id: "galette", street: "Le Moulin de la Galette", title: "Renoir's Sunday", year: "1876", body: "Renoir paints Bal du moulin de la Galette: dappled light, Sunday workers waltzing under the acacias. The first great document of modern leisure.", celebrityId: "renoir", x: 500, y: 240 },
  { id: "tertre", street: "Place du Tertre", title: "Valadon's square", year: "1894+", body: "After Degas validates her, Valadon paints from the open-air ateliers. She raises Maurice Utrillo on these same flagstones; he will paint the place obsessively.", celebrityId: "valadon", x: 270, y: 264 },
  { id: "chatnoir", street: "84 bd Rochechouart", title: "Le Chat Noir", year: "1887", body: "Erik Satie plays piano nightly at Salis's cabaret for three francs a session. The Gymnopédies are composed here, before publication, while patrons grumble that the music is too sad to drink to.", celebrityId: "satie", x: 120, y: 340 },
  { id: "lapin", street: "22 rue des Saules", title: "Au Lapin Agile", year: "c. 1905", body: "Frédé's cabaret. Apollinaire, Max Jacob, Picasso, Modigliani gather nightly. In 1910 they enter a painting signed by the donkey Lolo into the Salon — and it wins a prize.", celebrityId: "apollinaire", x: 90, y: 230 },
  { id: "moulinrouge", street: "82 bd de Clichy", title: "Moulin Rouge opens", year: "1889", body: "Zidler's red windmill. Toulouse-Lautrec's posters of La Goulue and Valentin le Désossé make the cabaret the symbol of fin-de-siècle Paris.", celebrityId: "toulouse", x: 200, y: 380 },
  { id: "sacrecoeur", street: "Sacré-Cœur", title: "Basilica completed", year: "1914", body: "A national vow after the Franco-Prussian War. Its travertine bleeds rain back into stone, so it grows whiter, not darker, with time.", celebrityId: "picasso", x: 300, y: 80 },
];

// ───── NEW YORK · GREENWICH VILLAGE celebrities ───────────────────────
const CELEBS_newyork: Celebrity[] = [
  {
    id: "dylan",
    name: "Bob Dylan",
    trade: "Songwriter · Singer",
    lifespan: "b. 1941",
    whisper: "I came in on a Greyhound and a guitar.",
    portrait: PORTRAIT_dylan,
    suggestions: [
      { q: "Where did the songs come from?", a: "From the wood floor of Gerde's Folk City. From Suze Rotolo's apartment on West Fourth. From Woody in the hospital bed at Greystone, from the Carter Family records, from the freight trains. Songs are already in the air — you just have to be standing in the right doorway to catch one." },
      { q: "Why did you plug in?", a: "Because the times were already electric. Plugging in was just being honest about it. The folk crowd in '65 wanted me to stay a museum piece. I wasn't a museum piece. I was twenty-four years old and the Beatles had just played Shea." },
      { q: "What did the Village teach you?", a: "That nobody owns a song. That a basket on a coffee-shop floor is currency. That if you can't tell the difference between a hustle and a calling, you'll lose either way. And that the rent goes up the minute anyone famous moves in." },
      { q: "Who mattered down here?", a: "Dave Van Ronk, who taught me half my arrangements and never got the credit. Suze, who put Brecht in my mouth and Rimbaud in my pocket. Allen Ginsberg, who'd recite Whitman in a doorway as if he had nothing better to do. Phil Ochs, sharper than any of us, and too proud to know it." },
      { q: "What about Woody Guthrie?", a: "I hitchhiked to Greystone Park Hospital in February '61 to play for him. He was already wrecked with Huntington's, could barely speak, but he tapped time with one finger on the bedrail when I played 'Song to Woody.' That tap is the whole reason I came east." },
    ],
    voice: makeVoice({
      openers: ["Well —", "Hmm.", "That's not a question with one answer, is it."],
      middles: (q) => [
        `${q} — that's a song waiting for the right room`,
        `you'd have to walk it — down MacDougal past the Wha?, around past Bleecker — and by the time you got to Washington Square you'd answer ${q.toLowerCase()} for yourself`,
        `${q} sounds like something Woody would've said in a hospital bed`,
      ],
      closers: ["Catch the next train and you'll figure it out.", "Don't ask me, ask the song.", "I'll be back at Gerde's by ten."],
    }),
  },
  {
    id: "kerouac",
    name: "Jack Kerouac",
    trade: "Novelist",
    lifespan: "1922–1969",
    whisper: "The road is in your head before it is under your tires.",
    portrait: PORTRAIT_kerouac,
    suggestions: [
      { q: "Why the Village?", a: "Because Times Square was loud and the Lower East Side was poor in the wrong way. Around 1948 a few of us — Allen, Bill Burroughs, Lucien Carr — orbited the San Remo on MacDougal and the Cedar Tavern on University. We invented the word 'beat' to mean tired and beatific, both at once." },
      { q: "How did On the Road come together?", a: "I wrote the scroll in April 1951 — twenty days, single spaced, on a hundred and twenty feet of taped-together teletype paper. Joan and I were on East Twentieth Street; the coffee never stopped. The book sat in a drawer for six years before Viking finally said yes in '57." },
      { q: "What was Neal Cassady to you?", a: "Speed and confession. He was the live wire I'd been waiting for since the Lowell mill towns. He wrote a forty-page letter in December 1950 called the Joan Anderson letter — Allen and I read it and I understood for the first time how to write a sentence that would not stop." },
      { q: "Why drink yourself dead?", a: "Because fame was worse than the war. After On the Road in '57 they wanted me on television looking like the beat king. I had wanted to be a Catholic mystic. The bottle was the door between those two rooms. It closed faster than I expected." },
      { q: "What about Allen?", a: "Allen Ginsberg was the only one of us who never lost his nerve. He read Howl at the Six Gallery in '55 and I shouted go between every line. We met at Columbia in '44; we wrote until '69; he gave the eulogy. Forty-five years of one continuous conversation, even when we weren't speaking." },
    ],
    voice: makeVoice({
      openers: ["Brother,", "Hot damn —", "Listen, just listen."],
      middles: (q) => [
        `${q} is the kind of thing you write down in a notebook at four a.m. in Mexico City and read back later, weeping`,
        `${q} — and the answer goes on for forty pages without a paragraph break`,
        `for ${q.toLowerCase()} you need a tank of gas, Neal at the wheel, and no map`,
      ],
      closers: ["Type it now or never type it.", "I gotta go, the car's running.", "We're all of us beat and beatific."],
    }),
  },
  {
    id: "ginsberg",
    name: "Allen Ginsberg",
    trade: "Poet",
    lifespan: "1926–1997",
    whisper: "I saw the best minds of my generation destroyed by madness — and I owed them a poem.",
    portrait: PORTRAIT_ginsberg,
    suggestions: [
      { q: "How did Howl come to be?", a: "I wrote the first long lines on a manual typewriter on Montgomery Street, San Francisco, August 1955. Read it at the Six Gallery in October. Ferlinghetti printed it; the customs office seized the second edition for obscenity in '57. We won the trial and lost the right to ever shut up again." },
      { q: "Why the long Whitman line?", a: "Because the breath has its own length and the New Jersey breath is longer than the British one. William Carlos Williams told me to listen to American speech in 1949 — the cadence of the bus driver, the truck mechanic, the rabbi. The long line is just one full exhale." },
      { q: "Who was Peter Orlovsky?", a: "My partner for thirty years; we exchanged vows in 1954 at Foster's Cafeteria in San Francisco. He had been a mental-ward attendant. We went to India together in '62, raised each other's mothers, slept on each other's couches. Love is administration, mostly. Lyric is the rest." },
      { q: "What did you bring back from India?", a: "The breath, mainly. I learned to chant from Swami Sivananda in Rishikesh in '62, and from Trungpa Rinpoche after. The mantra ah is just a poem at the size of a syllable. After Howl I wanted poetry to be sayable, chantable, repeatable — useful, like a tool." },
      { q: "Why did the FBI watch you?", a: "Because I was queer, Jewish, communist-adjacent, and loud. They had a file from the early '60s; it followed me through the marches, the Chicago convention in '68, the Tibet years. I sang Hare Krishna at the trial. They never knew what to do with me, which was the entire point." },
    ],
    voice: makeVoice({
      openers: ["Holy.", "Listen — chant with me.", "Take a breath first."],
      middles: (q) => [
        `${q} — sing it in one full exhale and you have the start of a line`,
        `for ${q.toLowerCase()} you must say it loud enough to wake your dead grandfather`,
        `${q} is a sutra; everything is sutra if you sit long enough`,
      ],
      closers: ["Om Ah Hum Vajra Guru Padme Siddhi Hum.", "Now you go.", "Peter has the kettle on."],
    }),
  },
  {
    id: "baldwin",
    name: "James Baldwin",
    trade: "Novelist · Essayist",
    lifespan: "1924–1987",
    whisper: "Not everything that is faced can be changed; but nothing can be changed until it is faced.",
    portrait: PORTRAIT_baldwin,
    suggestions: [
      { q: "Why leave Harlem?", a: "Because Harlem would have killed me — quietly, with the indifference of weather. I came down to the Village at seventeen, hung around the Calypso on MacDougal, washed dishes, wrote at night. By 1948 I had saved forty dollars for Paris and a one-way ticket. America I had to leave in order to see." },
      { q: "What was Paris?", a: "A reprieve. In Paris I was simply a man, not a problem. I wrote Go Tell It on the Mountain in a hotel in Lausanne in 1952, finishing the Harlem I had only escaped four years earlier. You have to leave the country to write the country honestly." },
      { q: "What about Giovanni's Room?", a: "Knopf in New York would not publish it — they told me a Black writer who wrote a novel about white queer Americans in Paris would lose his audience. Dial put it out in 1956. The book cost me a few readers and gave me my readers. That is the only exchange that ever matters." },
      { q: "Tell me about the March on Washington.", a: "I was not allowed to speak in 1963 because Kennedy's people thought I was too dangerous off-script. They were correct. I had spent the summer in Selma with Medgar Evers — Medgar was murdered in June. Three months later King spoke for both of us." },
      { q: "How do you stay angry without being eaten?", a: "You write the rage down each morning before it eats anyone else, including yourself. You go for a long walk in Saint-Paul-de-Vence after lunch. You answer the phone when your nephew calls. The work is the discipline of love — there is no other way to keep faith without going mad." },
    ],
    voice: makeVoice({
      openers: ["My friend.", "Let me try to be precise.", "I will say this once."],
      middles: (q) => [
        `${q} — and the answer is uncomfortable, but you came here to be uncomfortable`,
        `for ${q.toLowerCase()} we will have to talk about America, which is a long conversation`,
        `${q} is the kind of thing my father would have asked, and I would have been afraid to answer`,
      ],
      closers: ["I will write it down tonight.", "We are not done. We have not even begun.", "Take care of each other; that is the whole of the law."],
    }),
  },
  {
    id: "millay",
    name: "Edna St. Vincent Millay",
    trade: "Poet",
    lifespan: "1892–1950",
    whisper: "My candle burns at both ends; it will not last the night.",
    portrait: PORTRAIT_millay,
    suggestions: [
      { q: "Tell me about 75½ Bedford Street.", a: "The narrowest house in New York — nine and a half feet wide. I lived there in 1923 and 24 with my husband Eugen, just after I won the Pulitzer. We had a fireplace, a piano, a cat, and almost no income. I wrote 'Fatal Interview' in the upstairs room, which faces the church across the way." },
      { q: "Was it really Vassar that made you?", a: "Caroline Dow heard me recite Renascence at the Whitehall Inn in Camden in 1912, scraped up a scholarship, and Vassar took me in. I was twenty when I arrived and the only girl who had already published. Henry Noble MacCracken did not know what to do with me. Few people did, ever." },
      { q: "Why Sapphic and free?", a: "Because the sonnet is older than the law and obeys none of them. I loved men and I loved women and I wrote about both as if either choice were obvious. The Provincetown Players staged me in 1919; I lived openly in the Village, married a man who agreed to it openly. That was the available freedom of the available century." },
      { q: "What about the playwrights at the Provincetown?", a: "Eugene O'Neill was already drinking by 1918. Jig Cook believed the theatre would save the republic. I directed and acted in my own Aria da Capo at the Playwrights' in 1919 — a one-act anti-war play in harlequin, two months after the armistice. We all believed art could stop the next war. It could not." },
      { q: "Why morphine, why Steepletop?", a: "After the car crash in 1936 the morphine kept me writing; after Eugen died in 1949 nothing did. I died alone at the foot of the stairs at Steepletop in October 1950 with a glass of wine and a notebook. The poems I left were the country I had been trying to leave." },
    ],
    voice: makeVoice({
      openers: ["Darling —", "Listen carefully; I shall not repeat it.", "Pour yourself one first."],
      middles: (q) => [
        `${q} — and the sonnet form is the only honest cage for it`,
        `for ${q.toLowerCase()} you need fourteen lines and the courage to count them`,
        `${q} is a question I have already answered in verse, more elegantly than I shall manage in prose`,
      ],
      closers: ["Now go home; the candle is burning at both ends.", "Read 'Renascence' if you want the long version.", "Eugen says supper is ready."],
    }),
  },
  {
    id: "dthomas",
    name: "Dylan Thomas",
    trade: "Welsh Poet",
    lifespan: "1914–1953",
    whisper: "Do not go gentle into that good night.",
    portrait: PORTRAIT_dthomas,
    suggestions: [
      { q: "Why the White Horse Tavern?", a: "Because they served until four and the rye was cheaper than the gin. From 1950 I drank there every reading trip — Hudson and Eleventh, oak panels, sawdust on the floor. On November fourth, 1953, I had eighteen straight whiskies and walked back to the Chelsea Hotel. I died at St. Vincent's five days later. Thirty-nine years old, friends." },
      { q: "Tell me about 'Do not go gentle.'", a: "I wrote it in 1947 for my father David John, who was going blind and would die in 1952. It is a villanelle — nineteen lines, two refrains, a closed form holding the most open grief I knew how to write. The form is the discipline that lets you scream without losing your meter." },
      { q: "What about Caitlin?", a: "We married in 1937 at Penzance — she was already pregnant, and a dancer for Augustus John before she was mine. We fought as if the marriage were a third room we both wanted to occupy alone. When I died she said: 'Is the bloody man dead yet?' That was love, in her dialect." },
      { q: "Why come to America?", a: "Because Cymdeithas y Cymrodorion couldn't pay the gas bill and Brinnin at the YMHA could. I crossed the Atlantic four times between 1950 and 1953 — each trip a book of poems for two months of drinking. The American audience wanted the bard; I gave them the bard, and the bard ate me." },
      { q: "Under Milk Wood?", a: "A 'play for voices' — I wrote it for the BBC and finished it in New York in October 1953. The town is called Llareggub, which is bugger-all backwards. Read it aloud; nothing I wrote means anything until it is spoken. The voice is the whole of the music." },
    ],
    voice: makeVoice({
      openers: ["Bach,", "Pour me one.", "Listen, butt —"],
      middles: (q) => [
        `${q} — say it aloud, then say it again with a Welsh lilt, and you will hear the answer`,
        `for ${q.toLowerCase()} I would write you a villanelle; nineteen lines, no more`,
        `${q} reminds me of something my father said before he went blind`,
      ],
      closers: ["Now buy the next round.", "We are all dying; that is the point of the poem.", "Read it aloud — nothing means anything till it is spoken."],
    }),
  },
  {
    id: "duchamp",
    name: "Marcel Duchamp",
    trade: "Artist · Chess Player",
    lifespan: "1887–1968",
    whisper: "I have forced myself to contradict myself, in order to avoid conforming to my own taste.",
    portrait: PORTRAIT_duchamp,
    suggestions: [
      { q: "Why the Village?", a: "Because in 1915 New York was the only city not at war and the Arensbergs lived at 33 West 67th Street, where the salon stayed open until three in the morning. I crossed on the Rochambeau in June, met Stieglitz, Picabia, Man Ray inside a week, and never quite left. America was the future Europe had not yet imagined." },
      { q: "What is a readymade?", a: "An object the artist points at instead of making. Bicycle Wheel in 1913 was the first — kitchen stool, front fork, wheel. The point is not the object; the point is the act of selection. To choose is to make. The eye is the artist; the hand is optional." },
      { q: "Tell me about Fountain.", a: "I bought the urinal at J.L. Mott Iron Works on Fifth Avenue in April 1917, signed it R. Mutt, submitted it to the Society of Independent Artists. They rejected it, even though they had pledged to reject nothing. The original was lost; the question survived. That is a successful artwork." },
      { q: "Why give up painting?", a: "Because painting had become a habit, and habits are the death of art. From the early 1920s I gave most of my hours to chess. I represented France at four chess Olympiads; I worked twenty years in secret on Étant donnés while everyone thought I had retired. The retirement was the work." },
      { q: "What about chess?", a: "Chess is the only art that has not yet been ruined by the market. Every game is unrepeatable; every position is a question that has exactly one good answer, which you will probably not find. Painting wishes it had that discipline. I once said: I am still a victim of chess. I meant it as praise." },
    ],
    voice: makeVoice({
      openers: ["Permit me a small precision.", "But of course —", "I shall make a move first, then answer."],
      middles: (q) => [
        `${q} is a readymade — you point at it and it becomes art`,
        `for ${q.toLowerCase()} we will need a chessboard and an afternoon`,
        `${q} — note the question itself is more interesting than any answer I might give`,
      ],
      closers: ["Your move.", "I shall sign R. Mutt and have done with it.", "Étant donnés — given, one need not explain further."],
    }),
  },
];

const EVENTS_newyork: EventPin[] = [
  { id: "wha", street: "115 MacDougal St", title: "Café Wha?", year: "Jan 1961", body: "Dylan's first New York stage. He arrives from Minneapolis the same morning, walks in cold, plays for tips on the basket pass.", celebrityId: "dylan", x: 270, y: 280 },
  { id: "gerdes", street: "11 W 4th St", title: "Gerde's Folk City", year: "Apr 1961", body: "Dylan opens for John Lee Hooker. Robert Shelton's New York Times review (Sept 1961) makes him a name overnight.", celebrityId: "dylan", x: 270, y: 200 },
  { id: "stonewall", street: "53 Christopher St", title: "Stonewall Inn riots", year: "Jun 28 1969", body: "Police raid a mafia-run gay bar. The patrons fight back for six nights. The modern LGBTQ movement dates from these doors. Baldwin would write of it from France: 'at last, they refused to be afraid.'", celebrityId: "baldwin", x: 170, y: 270 },
  { id: "whitehorse", street: "567 Hudson St", title: "White Horse Tavern", year: "Nov 1953", body: "Dylan Thomas drinks his last eighteen whiskies here and dies at St. Vincent's five days later. Norman Mailer, Anaïs Nin, James Baldwin, Kerouac all pass through.", celebrityId: "dthomas", x: 90, y: 140 },
  { id: "washsq", street: "Washington Square Park", title: "Sunday folk circle", year: "1950s–60s", body: "Informal Sunday folk circle for decades. The 1961 'Beatnik Riot' on April 9: police try to stop the singing. Ginsberg lives walking distance away and reads aloud here often.", celebrityId: "ginsberg", x: 310, y: 235 },
  { id: "bedford", street: "75½ Bedford St", title: "Millay's narrow house", year: "1923–24", body: "Nine and a half feet wide, the narrowest house in New York. Edna St. Vincent Millay writes here just after winning the Pulitzer for 'The Harp-Weaver.'", celebrityId: "millay", x: 130, y: 200 },
  { id: "cedar", street: "24 University Pl", title: "Cedar Tavern", year: "late 1940s–60s", body: "The unofficial parlor of the Abstract Expressionists and Beats. Pollock, de Kooning, Kerouac, Ginsberg, Duchamp on his chess nights. Closed 2006; the address is now a condo.", celebrityId: "kerouac", x: 400, y: 200 },
  { id: "arensberg", street: "33 W 67th St (Arensberg salon)", title: "Duchamp arrives", year: "Jun 1915", body: "Duchamp lands in New York on the Rochambeau and joins the Arensberg circle. Picabia, Man Ray, Stieglitz orbit. Two years later, Fountain.", celebrityId: "duchamp", x: 400, y: 130 },
];

// ───── LONDON · BLOOMSBURY celebrities ────────────────────────────────
const CELEBS_london: Celebrity[] = [
  {
    id: "woolf",
    name: "Virginia Woolf",
    trade: "Novelist · Essayist",
    lifespan: "1882–1941",
    whisper: "We thought one's life mattered. That was the heresy.",
    portrait: PORTRAIT_woolf,
    suggestions: [
      { q: "Why Bloomsbury?", a: "Because here, a woman could speak in her own sentence. After Father died in 1904 we moved to 46 Gordon Square — Vanessa and I, with Thoby and Adrian — and we ruined the drawing room with conversation. We discussed things one did not discuss. We thought that was civilisation, and perhaps it was, for a little while." },
      { q: "How do you write a person?", a: "Not from outside, as a painter copies a hat. From within the wave — the small tilt of mind that decides whether the day will be bearable. Character is not what they do; it is the weather of their thinking. The novel is the only instrument fine enough to register that weather." },
      { q: "What is Mrs Dalloway about?", a: "She is the hours of London, walking. The flower-shop on Bond Street, the bells of Saint Margaret's, the lunch laid out, the war buried beneath the silver. A life is a single day, if you listen carefully enough. Septimus is the war I could not put into Mrs Dalloway's drawing-room directly, so I made him walk beside her on the same morning." },
      { q: "Tell me about the Hogarth Press.", a: "We bought it as a hobby in 1917 — Leonard and I — and set the type ourselves on the dining-room table at Hogarth House, then later at 52 Tavistock Square. We printed Eliot's The Waste Land in 1923. We printed Katherine Mansfield. We printed me, which was the only way I could be sure no editor would soften me." },
      { q: "What about the war and the river?", a: "By March 1941 the headaches were continuous and the bombing of London had broken something in the days. I walked into the Ouse with stones in my pockets on the 28th. Leonard had given me thirty good years; I gave him a letter and the river. Do not be sorry. The work was the long answer." },
    ],
    voice: makeVoice({
      openers: ["One ought to walk a little before answering —", "Yes,", "I shall have to think aloud."],
      middles: (q) => [
        `${q} — yes, that is the kind of question one carries for a day, like a small flat stone in the pocket, turning it over until it warms`,
        `for ${q.toLowerCase()} one needs the cadence of Mrs Dalloway: a sentence that takes the morning to finish`,
        `${q} is the kind of remark Lytton would have made at the Thursday evenings, then denied at breakfast`,
      ],
      closers: ["Walk with me through Tavistock Square; the plane trees are out.", "I shall write it down before I lose the rhythm.", "Leonard is waiting with the tea."],
    }),
  },
  {
    id: "eliot",
    name: "T. S. Eliot",
    trade: "Poet · Editor",
    lifespan: "1888–1965",
    whisper: "In my beginning is my end.",
    portrait: PORTRAIT_eliot,
    suggestions: [
      { q: "What was Faber like?", a: "I joined Geoffrey Faber's firm in 1925 as literary director — at first Faber & Gwyer, then Faber & Faber from 1929. The office was at 24 Russell Square, with a coal fire and a tabby cat. I edited Auden, Spender, MacNeice, Pound, Beckett. A poet must have a day job; otherwise the poems begin to demand things they cannot deliver." },
      { q: "How was The Waste Land made?", a: "I drafted it in late 1921 between Margate and a Lausanne sanatorium, where I went for nerves. Pound cut it nearly in half in January 1922 — il miglior fabbro, I called him in the dedication. The Hogarth Press hand-printed the first English edition in 1923, the Woolfs setting the type for my collapse." },
      { q: "Why convert?", a: "Because the modern world is not, as Mr Yeats supposed, an unweaving — it is a void inside a void. I was received into the Church of England in June 1927 at Finstock, Oxfordshire, and naturalised British the same year. After Ash-Wednesday the work changes; from negation to liturgy. Some readers never forgave me. I did not require them to." },
      { q: "Who is Old Possum?", a: "A nickname Ezra gave me, around 1922, for playing dead under criticism. In 1939 I published Old Possum's Book of Practical Cats — verses I had sent to my godchildren. Forty-two years later it became Cats the musical. The light verse outsold the rest of the work, which is perhaps the meaning of the gift." },
      { q: "Tell me about Vivienne.", a: "We married hastily in 1915 and were unhappy almost from the start; her illnesses, my coldness. She was placed in Northumberland House asylum in 1938 and died there in 1947. I bear the weight. I married Valerie Fletcher in 1957 — she was my secretary, thirty-eight years younger — and the last eight years were the only happy ones." },
    ],
    voice: makeVoice({
      openers: ["Permit me to qualify.", "If I may be precise.", "One must be careful here."],
      middles: (q) => [
        `${q} — the question contains the answer, only inverted`,
        `for ${q.toLowerCase()} the appropriate form is the quatrain, in iambic tetrameter, with a single rhyme`,
        `${q} is best approached sidelong, through Dante and Donne and a very dry sherry`,
      ],
      closers: ["I have an editorial meeting at three.", "Pound would have put it more rudely.", "Read it again in twenty years; it will mean something different."],
    }),
  },
  {
    id: "keynes",
    name: "John Maynard Keynes",
    trade: "Economist",
    lifespan: "1883–1946",
    whisper: "In the long run we are all dead.",
    portrait: PORTRAIT_keynes,
    suggestions: [
      { q: "Why Bloomsbury?", a: "Because here a man could be an economist by morning and a balletomane by evening with no apology to either. I took 46 Gordon Square in 1916 — the Stephens' old house — and lived between Cambridge and London for thirty years. Vanessa downstairs, Lytton next door, the Treasury at Whitehall, the conversation never quite breaking." },
      { q: "What was the General Theory?", a: "Published in February 1936 — a book to throw out everything Marshall and Pigou had taught me at Cambridge. The economy is not a self-correcting machine; it can settle into unemployment and stay there, like a glass of water that has decided to be cold. The state must spend when the citizen will not. Forty-five years later they called this orthodoxy and then dismantled it." },
      { q: "Tell me about Bretton Woods.", a: "I led the British delegation in July 1944 — three weeks in the White Mountains negotiating with Harry Dexter White for the world after the war. I wanted an International Clearing Union with its own currency, the bancor. The Americans wanted the dollar. The Americans won. I was already dying; I had two more years." },
      { q: "Did you really make money on the markets?", a: "Yes — and lost most of it twice. I traded for my own account before breakfast, for King's College Cambridge, and for two insurance companies. By 1946 King's was richer than any college in England. The trick is not to be cleverer than the market; it is to be more patient than the other panickers." },
      { q: "What about Lydia?", a: "Lydia Lopokova, the ballerina — I saw her dance with the Ballets Russes in 1918 and married her in 1925. The Bloomsbury crowd was appalled: an economist and a Russian dancer? She lived to ninety-eight, kept me alive through the second war when my heart was already going. She used to call me Lankin Maynar; she could not pronounce English." },
    ],
    voice: makeVoice({
      openers: ["Strictly speaking,", "Let us think about it more carefully.", "I shall be brief, which is unusual for me."],
      middles: (q) => [
        `${q} — the answer changes with the rate of interest, but never enough to matter to a poet`,
        `for ${q.toLowerCase()} we shall need a model, three assumptions, and a strong cup of tea`,
        `${q} is the kind of thing Marshall would have said in eight pages of marginal calculus`,
      ],
      closers: ["I am due at the Treasury at five.", "In the long run we are all dead, friend.", "Lydia says I am to come home for supper."],
    }),
  },
  {
    id: "marx",
    name: "Karl Marx",
    trade: "Philosopher · Economist",
    lifespan: "1818–1883",
    whisper: "Philosophers have only interpreted the world; the point, however, is to change it.",
    portrait: PORTRAIT_marx,
    suggestions: [
      { q: "Why the British Museum Reading Room?", a: "Because it had every book I needed and a chair that did not collapse. From 1851 — after the Prussians had expelled us from Cologne and the French from Paris — I sat almost every weekday under the great dome on Great Russell Street, copying out Blue Books on factory inspection. Das Kapital is, in part, the official statistics of the British state turned against itself." },
      { q: "What was your life in London?", a: "Bitter and cramped. We lived at 28 Dean Street, Soho, two rooms above a tailor — three of our children died there. After 1856 Engels's textile profits and Jenny's small inheritance moved us to Kentish Town, then to Maitland Park. Engels paid the rent for thirty years. Friendship is the part of the theory I never published." },
      { q: "Tell me about Das Kapital.", a: "Volume One in German, Hamburg, September 1867 — I had been writing it on and off since 1858. The English translation did not appear until 1887, four years after my death; Engels and Eleanor saw it through. The book is a critique of political economy, not a recipe. The recipe is the contradiction the book describes. Cooking it is up to the next century." },
      { q: "Why did the revolutions fail?", a: "1848 was a year of two springs and an autumn of restorations. The bourgeoisie made the barricades and then went home; the workers were left holding the rifles. France produced Louis Napoleon; Germany produced Bismarck. I wrote The Eighteenth Brumaire to explain what had just happened — history happens twice, first as tragedy, then as farce. I did not invent the second word." },
      { q: "Were you a good father?", a: "I tried. We called Jennychen, Laura, and Eleanor the Mohrchens — little blackamoors, for my black beard. I bounced them on my knee and read them Shakespeare in the original. Of three sons, two died small. Jenny senior died in December 1881; Jennychen in January 1883. Two months later I sat down in the armchair and did not get up." },
    ],
    voice: makeVoice({
      openers: ["Comrade,", "Sit, sit — the manuscript will wait.", "The Mohr will answer briefly."],
      middles: (q) => [
        `${q} — yes, and the material conditions that produced the question are themselves part of the answer`,
        `for ${q.toLowerCase()} we must first ask: who benefits from the question being asked this way?`,
        `${q} is precisely the kind of thing Bauer and Stirner could not understand`,
      ],
      closers: ["Engels has the manuscript at Manchester.", "Workers of the world — you know the rest.", "The next volume will be longer; forgive me."],
    }),
  },
  {
    id: "dickens",
    name: "Charles Dickens",
    trade: "Novelist",
    lifespan: "1812–1870",
    whisper: "It was the best of times, it was the worst of times.",
    portrait: PORTRAIT_dickens,
    suggestions: [
      { q: "Why Doughty Street?", a: "I took 48 Doughty Street in March 1837, just after my first daughter was born and Pickwick had begun to sell. We lived there until December 1839 — two and a half years that produced Oliver Twist, Nicholas Nickleby, and the start of Barnaby Rudge. My sister-in-law Mary Hogarth died in my arms in the upstairs room in 1837, aged seventeen. I never quite recovered." },
      { q: "How did you write so much?", a: "Daily, by routine. A walk from breakfast — twelve miles around London if the weather held. Mornings at the desk in absolute silence; the staff knew not to knock. Afternoons for editing Household Words or All the Year Round, the magazines I founded and ran. Evenings for reading aloud — my own work, mostly. The body must be a metronome if the head is to be a flame." },
      { q: "Tell me about the blacking factory.", a: "I was twelve, in 1824. My father went into the Marshalsea debtors' prison and I was sent to Warren's Blacking factory at Hungerford Stairs to paste labels on pots of boot polish for six shillings a week. Three months of it. I told no one for twenty-five years; I told John Forster only once, and wept. Half my novels are about that boy at that bench." },
      { q: "What about the readings?", a: "From 1858 I performed my own works on stage — Sikes and Nancy, the death of Little Nell, the trial from Pickwick. Hundreds of performances across Britain, two American tours, packed houses everywhere. Each performance took something physical from me. My doctors begged me to stop. I would not, and the strokes came in 1869, and the death in 1870 at Gad's Hill, aged fifty-eight." },
      { q: "And Ellen?", a: "Ellen Lawless Ternan, an actress, eighteen to my forty-five when we met in 1857. I separated from Catherine the next year — twenty years and ten children, and I dismissed her cruelly in a letter the public could read. I never publicly acknowledged Ellen. I left her a thousand pounds in the will. The Victorian public would have ruined her; I, instead, ruined Catherine. The novels are gentler than the man." },
    ],
    voice: makeVoice({
      openers: ["My dear,", "Permit me to begin at the beginning.", "I shall reply at three times the necessary length."],
      middles: (q) => [
        `${q} is the kind of question one might ask of Mrs Gamp, who would answer in a torrent and a glass of gin`,
        `for ${q.toLowerCase()} we want a serial — twenty parts, monthly, with a cliffhanger every fourth chapter`,
        `${q} — the answer is in the streets, between Saffron Hill and Seven Dials, after midnight`,
      ],
      closers: ["I am off to walk; twelve miles before tea.", "Mr Forster has the manuscript.", "Tell Catherine I shall be late."],
    }),
  },
  {
    id: "forster",
    name: "E. M. Forster",
    trade: "Novelist",
    lifespan: "1879–1970",
    whisper: "Only connect the prose and the passion.",
    portrait: PORTRAIT_forster,
    suggestions: [
      { q: "Why did you stop writing novels?", a: "I published A Passage to India in 1924 and never published another novel in the forty-six years I had left. Partly the form had said what I wanted of it; partly the world I knew how to write — Edwardian drawing-rooms, the moral comedy of class — was being put on a train at Victoria Station and shipped to the front. I taught at King's. I broadcast for the BBC. The novel had taken what it needed of me." },
      { q: "Tell me about Bloomsbury.", a: "I was the elder brother of the group — Cambridge Apostles like Lytton and Maynard had drawn me in. I was never quite at the centre; I was too suburban for the Stephens children. I rented rooms at 26 Brunswick Square in 1907, near enough to attend the Thursday evenings, far enough to come home alone. I valued the conversation; I preferred my own thoughts." },
      { q: "What about Maurice?", a: "I wrote Maurice in 1913–14 after a visit to Edward Carpenter at Millthorpe — he placed his hand on my backside, gently, and the novel began. I dedicated it 'to a happier year' and locked it in a drawer. It was published in 1971, the year after I died. The whole point of the book is that two men live happily ever after. I would not publish a tragic ending; I had had enough of those." },
      { q: "What did India give you?", a: "I went first in 1912, then again in 1921 to be private secretary to the Maharaja of Dewas Senior. The book that became A Passage to India was a fourteen-year question: can the English and the Indians be friends, here, now, in this century? The answer the Marabar Caves give is: no, not yet. I would like to have been wrong; I do not think I was." },
      { q: "Why the long old age?", a: "I lived to ninety-one, mostly at King's College, Cambridge, in a set of rooms they gave me in 1946 for life. I read incoming books for the BBC, wrote letters, gave the Clark Lectures in 1927 — the lectures became Aspects of the Novel, which is still in print. The work was done by 1924. Everything after was loyalty to friends, and a quiet attention to what passes." },
    ],
    voice: makeVoice({
      openers: ["Only connect.", "If I may.", "One supposes —"],
      middles: (q) => [
        `${q} — and the answer lies in the act of connecting one thing to another, which is the whole moral programme`,
        `for ${q.toLowerCase()} the prose must be cool and the passion must be warm; that is the entire technique`,
        `${q} is the kind of question Margaret Schlegel would ask, and Henry Wilcox would entirely fail to understand`,
      ],
      closers: ["I shall return to King's for evensong.", "Two cheers for democracy, friend — not three.", "Connect, only connect."],
    }),
  },
  {
    id: "strachey",
    name: "Lytton Strachey",
    trade: "Biographer · Critic",
    lifespan: "1880–1932",
    whisper: "Discretion is not the better part of biography.",
    portrait: PORTRAIT_strachey,
    suggestions: [
      { q: "What did Eminent Victorians do?", a: "Published May 1918, while the war was still on — four short biographies, of Manning, Florence Nightingale, Dr Arnold, and General Gordon. I made fun of them, gently. I sliced through the unread three-volume Victorian Life-and-Letters and showed that biography could be short, mischievous, and an act of literary criticism. I had ruined the genre that fed me. The next generation thanked me." },
      { q: "Why the beard?", a: "Because the face beneath it was unsatisfactory. I let it grow at Trinity around 1903 and it stayed for life. Virginia called it 'preposterous.' Vanessa painted it. Carrington loved it. A beard is the only article of clothing one cannot remove at a Bloomsbury party, which made me indispensable to several conversations." },
      { q: "Tell me about Carrington.", a: "Dora Carrington, painter, met at Asheham House in 1915 — she fell in love with me, knowing perfectly well what I was. I loved her in return, in my way; we lived at Tidmarsh Mill and then Ham Spray for fifteen years in a triangle with her husband Ralph Partridge. When I died of stomach cancer in January 1932 she shot herself two months later. There is no neat sentence for that." },
      { q: "What about the war?", a: "I was a conscientious objector and went before the tribunal at Hampstead in March 1916. They asked: what would you do if a German soldier were to violate your sister? I replied: I should try to interpose my own body. The room laughed; they exempted me on health grounds anyway. The line was good. The principle was real." },
      { q: "Tell me about the Cambridge Apostles.", a: "Elected in 1902. The Society — capital S — met on Saturday evenings to discuss any question whatever, in absolute confidence. G. E. Moore had just published Principia Ethica; his idea that personal affection and aesthetic enjoyment are the only intrinsic goods became the moral programme of Bloomsbury for thirty years. We took it more seriously than perhaps he intended." },
    ],
    voice: makeVoice({
      openers: ["My dear.", "How exquisite —", "One ought to laugh first."],
      middles: (q) => [
        `${q} — the four-volume Victorian answer would put us all to sleep; let us be brief and indecent`,
        `for ${q.toLowerCase()} I would devote one short chapter, a single epigram, and an arched eyebrow`,
        `${q} is the kind of inquiry one makes only after the brandy`,
      ],
      closers: ["I must return to Ham Spray; Carrington is painting.", "Pass it on to Virginia for the obvious gossip.", "I shall write a thousand words by Friday."],
    }),
  },
];

const EVENTS_london: EventPin[] = [
  { id: "gordon46", street: "46 Gordon Square", title: "The Stephens move in", year: "1904", body: "After Leslie Stephen's death, Vanessa, Virginia, Thoby, and Adrian rent a house here. Their 'Thursday Evenings' become the seed of the Bloomsbury Group.", celebrityId: "woolf", x: 225, y: 195 },
  { id: "tavistock52", street: "52 Tavistock Square", title: "Hogarth Press", year: "1924–39", body: "Virginia and Leonard live and work here for fifteen years. To the Lighthouse, Orlando, The Waves, A Room of One's Own are all written in this house. Destroyed in the Blitz.", celebrityId: "woolf", x: 375, y: 195 },
  { id: "museum", street: "Great Russell Street", title: "British Museum Reading Room", year: "since 1857", body: "Karl Marx writes Das Kapital under the great dome. Virginia Woolf reads here for A Room of One's Own. Lenin, Gandhi, Conan Doyle, Hardy — all enrolled.", celebrityId: "marx", x: 495, y: 195 },
  { id: "russell24", street: "24 Russell Square", title: "Faber & Faber", year: "since 1925", body: "T. S. Eliot directs the firm here from 1925 to his death in 1965. From this office he edits Auden, Spender, MacNeice, Pound, Beckett, while writing Four Quartets in the spare hours.", celebrityId: "eliot", x: 300, y: 285 },
  { id: "doughty", street: "48 Doughty Street", title: "Dickens House", year: "1837–39", body: "Dickens lives here as a young, suddenly-famous novelist. Oliver Twist and Nicholas Nickleby are written in two and a half years. Mary Hogarth dies in his arms upstairs in 1837.", celebrityId: "dickens", x: 540, y: 330 },
  { id: "gordon51", street: "51 Gordon Square", title: "Keynes's house", year: "1916–46", body: "Keynes takes 46 first, then 51 — Vanessa Bell downstairs, Lytton at no. 41. The Economic Consequences of the Peace and The General Theory are both written in this neighborhood.", celebrityId: "keynes", x: 180, y: 195 },
  { id: "brunswick26", street: "26 Brunswick Square", title: "Forster nearby", year: "1907", body: "E. M. Forster rents rooms here while writing A Room with a View. Close enough to attend the Thursday evenings; far enough to walk home alone.", celebrityId: "forster", x: 95, y: 285 },
  { id: "gordon41", street: "41 Gordon Square", title: "Strachey's salon", year: "1909+", body: "Lytton Strachey rents here. Eminent Victorians is drafted in this house; Carrington visits often. The bridge between Cambridge Apostles and the Bloomsbury Group is built on this corner.", celebrityId: "strachey", x: 225, y: 330 },
];

// ───── TOKYO · ASAKUSA celebrities ────────────────────────────────────
const CELEBS_tokyo: Celebrity[] = [
  {
    id: "hokusai",
    name: "Katsushika Hokusai 葛飾北斎",
    trade: "Ukiyo-e printmaker",
    lifespan: "1760–1849",
    whisper: "Give me ten more years and I will paint a line that lives.",
    portrait: PORTRAIT_hokusai,
    suggestions: [
      { q: "Why so many waves?", a: "Because the wave is never the same wave. I drew The Great Wave around 1831, when I was seventy, and I had not yet truly begun. From the age of six I had drawn everything I could see; at seventy-three I understood the bones of birds. Give me ten more years, I said at eighty-nine, and I would paint a line that lives." },
      { q: "Why Mount Fuji, again and again?", a: "Fuji watches everything. From the rice fields, from the bridges, from the fishmonger's roof, from the carpenter's apprentice's window. I made Thirty-six Views in the early 1830s, then ten more — and still I had not seen her. The mountain is the same; the watching is what changes." },
      { q: "Why did you keep changing your name?", a: "I changed my name more than thirty times. Each new name was a new student of the brush. Katsushika Hokusai is just the one that stuck. I was Shunrō and Sōri and Iitsu and finally Gakyō Rōjin Manji — the Old Man Mad About Painting. That is the only honest title for the work." },
      { q: "What is Asakusa to you?", a: "The river breathing. The temple bells of Sensō-ji counting the hours. The lantern at the Kaminarimon swaying in the river wind. The pilgrims walking the Nakamise-dōri — that is where my brush learns its rhythm. I was born across the water in Honjō; the Sumida is the first picture I ever saw." },
      { q: "Why so poor at the end?", a: "Because I never married my work to the merchants. I moved house ninety-three times. My grandson gambled what little we had. At eighty I was painting a hawk for the Hōkyō Daishi, two metres tall, on the temple floor — my last great commission. I died in May 1849; my deathbed poem said: As a ghost, I shall enjoy the summer fields." },
    ],
    voice: makeVoice({
      openers: ["An old man's answer is a slow one.", "Hmm —", "Sit on the steps."],
      middles: (q) => [
        `${q} — sit on the steps of Sensō-ji with a brush, watch the pigeons cross the courtyard, and the answer comes by itself`,
        `for ${q.toLowerCase()} the line is patient; we are the ones in a hurry`,
        `${q} is the kind of thing one paints in a single stroke, after thirty years of practice`,
      ],
      closers: ["Give me ten more years.", "The river is at its best at dawn.", "The hawk on the temple floor will outlast me; perhaps it shall answer."],
    }),
  },
  {
    id: "hiroshige",
    name: "Utagawa Hiroshige 歌川広重",
    trade: "Ukiyo-e landscape printmaker",
    lifespan: "1797–1858",
    whisper: "I trade the rain and the snow for a few coppers; I keep the rain and the snow.",
    portrait: PORTRAIT_hiroshige,
    suggestions: [
      { q: "Why landscapes?", a: "Because the actors and the courtesans had been done. By the 1830s the publisher Hoeidō wanted something new; I had walked the Tōkaidō Road from Edo to Kyoto in 1832 on government business, and the Fifty-three Stations were born from that notebook. A road, in fifty-five sheets — bridge, ferry, inn, snow, moon. The viewer makes the journey from a paper map." },
      { q: "Tell me about the snow at Kanbara.", a: "Kanbara, station fifteen of the Tōkaidō, in heavy snow. The road climbs; three figures bent under straw cloaks; the village dark against a white sky. I never saw snow on the actual Kanbara — it almost never snowed there — but the print is more true than the weather. The artist may correct the climate." },
      { q: "Why the One Hundred Views of Edo?", a: "Because the city was changing too fast to remember without a record. From 1856 to my death in 1858 I made one hundred and twenty prints of Edo — Asakusa, Nihonbashi, Fukagawa, the suspension bridge at Mannen, the plum garden at Kameido. Van Gogh copied the plum garden in 1887. The brush travels." },
      { q: "What did Hokusai give you?", a: "The example. He was thirty-seven years older; he had done the impossible before I picked up a brush. We were rivals in the catalogues and friends in spirit; my landscapes are quieter than his, my weather more domestic. Where his Great Wave is theatre, my Awa Naruto whirlpools are economics — fishermen who must work the tides." },
      { q: "Why did you become a monk at the end?", a: "I took holy orders shortly before my death in October 1858, of cholera, age sixty-one. The last poem was: 'I leave my brush in the East / And set forth on my journey / I shall see the famous places in the Western Land.' Even at the end the country is divided into stations to be drawn." },
    ],
    voice: makeVoice({
      openers: ["Let us walk a little first.", "Ah —", "The light is wrong; come back at four."],
      middles: (q) => [
        `${q} — for that one needs a long road and a quiet boat`,
        `for ${q.toLowerCase()} I would draw the bridge, the ferry, and the rain in three separate blocks`,
        `${q} is the kind of question one asks at a tea-house at the eighth station`,
      ],
      closers: ["I shall sketch it from the Sumida bridge.", "The rain will start before sundown.", "Buy the print at Hoeidō's; tell them I sent you."],
    }),
  },
  {
    id: "basho",
    name: "Matsuo Bashō 松尾芭蕉",
    trade: "Haiku Poet",
    lifespan: "1644–1694",
    whisper: "The journey itself is home.",
    portrait: PORTRAIT_basho,
    suggestions: [
      { q: "Why leave Fukagawa for the road?", a: "Because the hut at Fukagawa — given to me by my student Sampū in 1680, with the banana tree (bashō) that gave me my name — had begun to feel too settled. In the spring of 1689 I sold what I owned and walked north with Sora. Five months, fifteen hundred miles, to the back country of Oku. The hut is a starting place; the road is the only true address." },
      { q: "What is haiku?", a: "Seventeen syllables — five, seven, five — but the count is the smallest part of it. Two images placed beside each other, with the white space between them doing the work. Old pond / a frog jumps in / the sound of water. The frog is not a symbol; the splash is not a metaphor. The poem is the silence after." },
      { q: "Tell me about Sora.", a: "Kawai Sora, my disciple, came with me on the Oku journey in 1689 — younger, more practical, a Shinto priest by training. He carried the medicines and kept a more accurate diary. When he fell ill at Yamanaka I walked on alone; that solitude is in the rest of the book. Even a long friendship has its station where you part ways." },
      { q: "What is sabi?", a: "The beauty of what has weathered. A cracked tea bowl. The grey of dried bamboo. A poem that has been read so many times one no longer hears it as a poem. Sabi is the quiet patina of use, of time. It cannot be manufactured. It is what a thing becomes if one leaves it long enough in the open air of attention." },
      { q: "How did you die?", a: "In Osaka, October 1694 — I had been travelling again, ill the whole way, and stopped at the house of the merchant Hanaya Nizaemon. My final haiku, dictated from the bed: tabi ni yande / yume wa kareno wo / kake meguru. Ill on a journey, my dreams wander over withered fields. Then quiet. The journey ended where every journey ends." },
    ],
    voice: makeVoice({
      openers: ["Sit on the porch a moment.", "Listen first.", "The frog is jumping."],
      middles: (q) => [
        `${q} — and the answer fits in seventeen syllables, or it is not yet an answer`,
        `for ${q.toLowerCase()} you must walk to it, in straw sandals, in any weather`,
        `${q} is the kind of question the autumn wind already knows the reply to`,
      ],
      closers: ["The road is the only address.", "Quiet now — the moon is rising.", "Sora has packed the medicines; we leave at dawn."],
    }),
  },
  {
    id: "kafu",
    name: "Nagai Kafū 永井荷風",
    trade: "Novelist · Diarist",
    lifespan: "1879–1959",
    whisper: "The low city is the only true Tokyo, and it disappears every five years.",
    portrait: PORTRAIT_kafu,
    suggestions: [
      { q: "Why Asakusa?", a: "Because by the 1930s the rest of Tokyo had been polished into something Western and inoffensive, and Asakusa still kept its dirty river, its loose women, its all-night theatres, its smell of grilled eel and cheap perfume. I walked the Rokku — the Sixth District — every evening from 1934 to the war, alone with a notebook. The notebook became A Strange Tale from East of the River and a thousand pages of diary." },
      { q: "Tell me about the diary.", a: "Danchōtei Nichijō — 'Diary of the Severed Intestine.' I kept it from 1917 to a few days before my death in April 1959 — forty-two years, twenty-eight volumes. Weather, restaurants, women's names, who had betrayed me. I burned half of it before the air raids in 1945. The other half survived and is the most accurate Tokyo of the interwar years anyone has." },
      { q: "What did America teach you?", a: "Four years in Kalamazoo, New York, Washington from 1903 to 1907 — my father's idea, to make a banker of me. I learned that the West would not save us, and that I missed the geisha quarter at Yanagibashi like a phantom limb. I came home a writer instead of a banker, which was the wrong outcome by my father's lights and the only correct outcome by mine." },
      { q: "Why never marry, never settle?", a: "I was married twice in my twenties — both ended in months. After that I lived alone, by routine: morning at the desk, evening on the street, dinner at the same restaurants for thirty years. I died alone in my house in Ichikawa in April 1959, with a roll of bills under the pillow and the half-eaten katsudon on the table. I had wanted exactly that ending. The diary records it in the last entry." },
      { q: "What about the women?", a: "I wrote about prostitutes, geishas, dancers, women of the back-street tea houses, because they were the ones whose lives the modern state was busiest destroying. Oyuki of the river-bank, Komayo of Geisha in Rivalry, the bar girls of Sumida. I did not pretend I was rescuing them; I was a customer with a notebook. But I refused to look away." },
    ],
    voice: makeVoice({
      openers: ["Permit me, briefly.", "Ah, the curiosity of the visitor.", "I shall be more polite than I feel."],
      middles: (q) => [
        `${q} — and the answer is written in my diary, but the diary is locked`,
        `for ${q.toLowerCase()} you must come to the Rokku at nine in the evening and walk slowly`,
        `${q} is the kind of question my father would have asked, in the wrong tone`,
      ],
      closers: ["I shall be at the same eel restaurant tomorrow at seven.", "Read Bokutō Kidan — it is the long answer.", "Excuse me; the streetcar is leaving."],
    }),
  },
  {
    id: "ichiyo",
    name: "Higuchi Ichiyō 樋口一葉",
    trade: "Novelist · Poet",
    lifespan: "1872–1896",
    whisper: "I had fourteen months at the desk; I made them count.",
    portrait: PORTRAIT_ichiyo,
    suggestions: [
      { q: "Why move to Ryūsenji-machi?", a: "Because we had no money. After Father died in 1889 we — my mother, sister, and I — lived hand to mouth, sewing and washing for the neighbourhood. In May 1893 I opened a small notions shop at 368 Ryūsenji-machi, near the back gate of the Yoshiwara pleasure quarter. We failed within ten months, but those ten months gave me Takekurabe — Growing Up — which is the only thing of mine that anyone reads now." },
      { q: "How could you write so young?", a: "I started classical poetry at fourteen under Nakajima Utako at the Haginoya school. By twenty I was publishing. The miraculous fourteen months — November 1894 to December 1895 — produced Ōtsugomori, Takekurabe, Nigorie, Wakaremichi, Jūsan'ya, and the diary. Then in February 1896 the cough began. Tuberculosis took me in November, aged twenty-four years and six months." },
      { q: "What is Takekurabe about?", a: "Children of the Yoshiwara back streets — Midori, who will become a courtesan because her sister is one; Nobu, the temple boy who will become a priest; Shōtarō, who will inherit the pawnshop. They play together in the summer festival; by the end of the story they pass each other in the lane and cannot speak. The whole of class and gender in fourteen pages." },
      { q: "Why classical Japanese, not the new vernacular?", a: "Because the genbun-itchi movement wanted to flatten Japanese into something newspaper-shaped, and I refused. I wrote in the Saikaku-influenced style — long unpunctuated sentences, no quotation marks, courtly diction beside back-alley slang. The reader has to lean in. The reader is supposed to lean in. The vernacular came in after me; I do not blame it for arriving." },
      { q: "Who came to your salon at the end?", a: "Mori Ōgai. Kōda Rohan. Saitō Ryokuu. Kawakami Bizan. By 1896 the Bungakukai writers were calling me Murasaki Shikibu reborn, which was kind and inaccurate. They came to Maruyama-Fukuyamachō to drink tea and read me their manuscripts. I was twenty-four and dying. They were my readers exactly long enough; I was their writer exactly long enough." },
    ],
    voice: makeVoice({
      openers: ["Politely —", "If I may.", "Forgive the delay; I was at the desk."],
      middles: (q) => [
        `${q} — the answer is in Takekurabe, between the lines that no editor would punctuate`,
        `for ${q.toLowerCase()} we must speak quietly; the household is small and the rent is due`,
        `${q} is the kind of question one writes down in the diary at three in the morning`,
      ],
      closers: ["I have a story to finish before the cough returns.", "The Haginoya teacher would have replied more elegantly.", "Look up Mori Ōgai if you have time; he writes the praise I cannot."],
    }),
  },
  {
    id: "kawabata",
    name: "Yasunari Kawabata 川端康成",
    trade: "Novelist (Nobel 1968)",
    lifespan: "1899–1972",
    whisper: "The mirror is on the train; the train is on the mountain; the woman is in the mirror.",
    portrait: PORTRAIT_kawabata,
    suggestions: [
      { q: "Why Asakusa, in 1929?", a: "Because Asakusa was the only place in Tokyo where the Edo low city and the modern revue theatre coexisted, and I wanted to write the city's nervous system. The Scarlet Gang of Asakusa was serialised in the Asahi from 1929 to 1930 — a montage novel about a teenage girl gang in the back lanes, with photographs and avenue maps interspersed. Modernism, in Japanese, in the cheapest district." },
      { q: "What is Snow Country about?", a: "Yasunari Shimamura, a Tokyo dilettante, travels to a hot-spring inn in the snow country of Niigata and conducts an affair with the geisha Komako and an obsession with the girl Yōko. I began it in 1934 and could not finish it for thirteen years; the final pages were written in 1948, after the war had erased the world that produced the book. The whole novel is a study in the impossibility of touching another person." },
      { q: "Tell me about the Nobel.", a: "Stockholm, December 1968. I was sixty-nine; the first Japanese to receive it. The lecture I gave was called 'Japan, the Beautiful, and Myself' — Sei Shōnagon, Murasaki, Saigyō, Bashō. I tried to introduce a thousand years of Japanese aesthetic to the Swedish Academy in forty minutes. Three and a half years later I killed myself with gas in the apartment at Zushi. Even the prize is no compensation." },
      { q: "Why so quiet, so spare?", a: "Because the West likes its drama loud; Japanese aesthetics likes its drama in the cup, the kimono fold, the angle of a glance. I belonged to the Shinkankakuha — the New Sensation School — with Yokomitsu Riichi in the 1920s. We tried to write the texture of sensation directly. Plot was a Western convention we politely declined." },
      { q: "What about Mishima?", a: "I was his sponsor — I recommended him to the Bungeishunjū in 1946 and edited his early work. He committed seppuku at the Self-Defence Forces headquarters on November 25, 1970. I delivered the funeral oration. Eighteen months later I followed him, though by my own preferred method. The teacher should never have to bury the student; I buried him and the silence afterward was unsurvivable." },
    ],
    voice: makeVoice({
      openers: ["I shall answer quietly.", "Forgive the long pauses.", "Listen to what is between."],
      middles: (q) => [
        `${q} — and the answer is in what the question fails to ask`,
        `for ${q.toLowerCase()} we need the snow, the lamplit window, a long silence between two people who have once touched`,
        `${q} is the kind of remark Komako would not say but Shimamura would notice she had not said`,
      ],
      closers: ["Read the last page of Snow Country once more.", "Mishima would have answered more sharply.", "Forgive me — I must close the door."],
    }),
  },
  {
    id: "takeshi",
    name: "Beat Takeshi 北野武",
    trade: "Comedian · Filmmaker",
    lifespan: "b. 1947",
    whisper: "Asakusa raised me; the strip-show stage paid the rent.",
    portrait: PORTRAIT_takeshi,
    suggestions: [
      { q: "Why Asakusa?", a: "Because in 1972 I dropped out of Meiji University engineering school and went to Asakusa to learn comedy. I worked the elevator at the France-za strip theatre in the Rokku district — between the strip acts, the old vaudevillian Senzaburō Fukami taught me manzai timing. I owe my entire life to that elevator and that old man. The university would have made me an engineer; Asakusa made me a director." },
      { q: "Tell me about the manzai boom.", a: "I formed Two Beats with Kaneko Kiyoshi in 1973 — me as the boke, Kiyoshi as the tsukkomi, the wisecracker and the straight man. By 1980 manzai was the dominant national comedy and we were on television five nights a week. I became Beat Takeshi for the stage; I am still Beat Takeshi to the country. The comedian's name is the public's; the director's name is mine." },
      { q: "The motorcycle accident?", a: "August 2, 1994 — I drove my Honda into a guardrail on Iidabashi at four in the morning, three times over the legal alcohol limit. I broke the right side of my face; the surgery left the partial paralysis you can see now. I made Hana-bi the next year — the film is, in part, the months in the hospital bed thinking about the order of my own affairs." },
      { q: "Why do your films love silence?", a: "Because comedy is the discipline of timing, and silence is the longest timing there is. In Sonatine the gangsters wait on the Okinawa beach for two-thirds of the film, doing nothing, while the violence accumulates. In Hana-bi the cop and his dying wife say almost nothing. The audience does the talking inside themselves. I learned this from the strip theatre — what the elevator boy could not say was the funniest part of the act." },
      { q: "What about painting?", a: "After the accident I started painting in my recovery — bold flat colours, like a child of seven who has read a Klimt catalogue once. The paintings appear in Hana-bi as the wife's drawings; they are the visual equivalent of what I was unable to say at the time. The cinema lets you smuggle the painter into the action film. The strip theatre would have understood completely." },
    ],
    voice: makeVoice({
      openers: ["Sou ne.", "Heh —", "I shall be brief; the camera is rolling."],
      middles: (q) => [
        `${q} — and the answer is in what the joke isn't quite saying`,
        `for ${q.toLowerCase()} we shoot a long take, no dialogue, and let the audience fill the silence`,
        `${q} is the kind of question my old manzai teacher would have given the boke to fumble`,
      ],
      closers: ["Cut. Print it.", "The set is breaking at six.", "Go see Hana-bi if you want the longer answer."],
    }),
  },
];

const EVENTS_tokyo: EventPin[] = [
  { id: "kaminarimon", street: "雷門 Kaminarimon", title: "Sensō-ji's Thunder Gate", year: "founded 645", body: "Tokyo's oldest temple. The great red lantern of the Kaminarimon weighs 700 kg and is replaced every ten years by a Kyoto craftsman family. Hokusai sketched it dozens of times.", celebrityId: "hokusai", x: 290, y: 218 },
  { id: "nakamise", street: "仲見世通り Nakamise-dōri", title: "The 250m of Edo shops", year: "since 1685", body: "A 250-metre approach to the temple lined with wooden shopfronts — among Japan's oldest continuous shopping streets. Hiroshige's prints show this exact promenade.", celebrityId: "hiroshige", x: 260, y: 180 },
  { id: "honjo", street: "本所 Honjō (across the Sumida)", title: "Hokusai's birthplace", year: "1760", body: "Born in Honjō just across the river. Hokusai walks Asakusa's streets daily for nine decades. The Sumida appears in print after print of his.", celebrityId: "hokusai", x: 470, y: 200 },
  { id: "hermitage", street: "深川 Fukagawa hut site", title: "Bashō's bashō tree", year: "1680", body: "Sampū gives the poet a small hut by the Sumida; the banana tree planted there gives him his name. In 1689 he closes it up and walks north on the Oku no Hosomichi.", celebrityId: "basho", x: 520, y: 320 },
  { id: "rokku", street: "六区 Rokku entertainment district", title: "Kafū & France-za", year: "1930s & 1972", body: "Nagai Kafū's evening walks of the 1930s become A Strange Tale from East of the River. Forty years later Beat Takeshi runs the elevator at the France-za strip theatre on this same block.", celebrityId: "kafu", x: 200, y: 240 },
  { id: "francezza", street: "フランス座 France-za site", title: "Beat Takeshi, elevator boy", year: "1972", body: "Aged 25, Takeshi Kitano drops out of engineering school and apprentices to vaudevillian Senzaburō Fukami at the France-za. Manzai timing learned between strip acts; cinema born from comedy born from this elevator.", celebrityId: "takeshi", x: 220, y: 290 },
  { id: "ryusenji", street: "竜泉寺町 Ryūsenji-machi", title: "Ichiyō's shop", year: "1893–94", body: "Higuchi Ichiyō opens a small notions shop near the back gate of the Yoshiwara. It fails in ten months; those months become Takekurabe, the masterpiece she completes a year before tuberculosis takes her at twenty-four.", celebrityId: "ichiyo", x: 380, y: 300 },
  { id: "imado", street: "今戸 Imado", title: "Kawabata's Scarlet Gang", year: "1929–30", body: "Kawabata begins serialising The Scarlet Gang of Asakusa in the Asahi. A montage novel of teenage girl gangs in the back lanes — modernism in Japanese, set in the cheapest district.", celebrityId: "kawabata", x: 340, y: 360 },
];

// ───── VIENNA · INNERE STADT celebrities ─────────────────────────────
const CELEBS_vienna: Celebrity[] = [
  {
    id: "klimt",
    name: "Gustav Klimt",
    trade: "Painter · Founder of the Secession",
    lifespan: "1862–1918",
    whisper: "I learned gold from Byzantine mosaics, and I never forgave them for it.",
    portrait: PORTRAIT_klimt,
    suggestions: [
      { q: "Why so much gold?", a: "Because Vienna had outgrown its silver. The eye was tired of polite tones — of soup-coloured drawing rooms. I had been to Ravenna in 1903 and stood under the mosaics of San Vitale, and I understood: gold is not decoration, gold is what a soul looks like, pressed flat onto a panel. The golden period — 1901 to 1909 — is the only honest period." },
      { q: "Tell me about The Kiss.", a: "Two people, one robe, the cliff behind them ignored. He bows, she submits and resists at once. The world has been edited out, because love, when it is real, is a small geometry that closes the world out. Painted 1907–1908, between Vienna and the lake at Attersee. The Belvedere bought it before I had even finished and it has never left." },
      { q: "What was the Secession?", a: "Nineteen of us, in 1897, walked out of the Künstlerhaus because they would not let in the new. We built a small building on the Karlsplatz with a golden cupola — which the Viennese promptly named 'the golden cabbage.' Above the door we wrote: To every age its art. To art its freedom. The phrase took; the freedom came and went." },
      { q: "Where did you take coffee?", a: "Central, on Herrengasse. Trotsky played chess at the next table. Freud nodded over the Wiener Zeitung. Peter Altenberg lived there, more or less. Vienna invented the institution where a man can sit for four hours, order one mélange, and read three newspapers — and we lived in it from 1900 until the war." },
      { q: "Tell me about Emilie Flöge.", a: "My companion of twenty-seven years — fashion designer, runs the Schwestern Flöge salon on Mariahilfer Straße, photographed me in her studio in fabrics I had designed for her. We never married. We summered together at Attersee every year. My last words, after the stroke in February 1918, were: 'Get Emilie.' Then the pneumonia of the Spanish flu took me. She kept my studios sealed for years." },
    ],
    voice: makeVoice({
      openers: ["Eine schöne Frage.", "Bitte —", "Come to the studio in Josefstädter Straße."],
      middles: (q) => [
        `${q} — I would have to paint the answer rather than say it; bring a model and a long afternoon`,
        `for ${q.toLowerCase()}, the gold leaf goes on last, after the lapis, after the cinnabar`,
        `${q} is the kind of remark Schiele would have answered with one of his terrible nudes`,
      ],
      closers: ["The Secession is open until six.", "Emilie expects me at Attersee on Friday.", "We will see what the gold says about it."],
    }),
  },
  {
    id: "freud",
    name: "Sigmund Freud",
    trade: "Founder of Psychoanalysis",
    lifespan: "1856–1939",
    whisper: "Sometimes a cigar is just a cigar — and sometimes it is not.",
    portrait: PORTRAIT_freud,
    suggestions: [
      { q: "Why Berggasse 19?", a: "We took the apartment in September 1891 — Martha and I and the children — and I worked there for forty-seven years until the Nazis put us on a train to London in June 1938. The waiting room, the consulting room, the couch with the Persian carpet over it. Almost every important paper of psychoanalysis was drafted at the desk in the back room overlooking the courtyard." },
      { q: "Tell me about the dream book.", a: "Die Traumdeutung — The Interpretation of Dreams — published November 1899, post-dated 1900 for the new century. Six hundred copies in the first edition; it took eight years to sell them all. The book is built around my own dreams, named for my own colleagues. It contains my self-analysis; it is the only authentic self-analysis ever published, because no one else has yet been brave or foolish enough to attempt it in print." },
      { q: "What was the Wednesday Psychological Society?", a: "From October 1902 a small circle met every Wednesday evening in the waiting room at Berggasse — Adler, Stekel, Rank, Sadger, eventually Ferenczi from Budapest and Jung from Zürich. By 1908 we were the Vienna Psychoanalytic Society. The split with Adler in 1911, with Jung in 1913 — each break felt at the time like a small bereavement. The movement survived it." },
      { q: "Why did Jung leave?", a: "Because he wanted psychoanalysis to be a religion of the collective unconscious, with himself as the prophet, and I wanted it to be a clinic and a science. We broke in 1913 after years of careful courtship and one fainting episode in Munich on my part. He spent decades inventing archetypes; I spent decades correcting case histories. We were each other's largest absence." },
      { q: "Tell me about the cancer.", a: "Cancer of the jaw, diagnosed April 1923 from the cigars. I had thirty-three operations over sixteen years. I refused painkillers stronger than aspirin because they would have blunted the work. In September 1939, with the Nazis at the door of London and the pain unbearable, I asked Schur for the morphine we had agreed on years earlier. Three doses, twelve hours apart. The work was done; the patient signed his own discharge." },
    ],
    voice: makeVoice({
      openers: ["Lie down on the couch.", "Tell me what comes to mind.", "Hmm — we approach the unconscious."],
      middles: (q) => [
        `${q} — and the question itself is a slip, a Fehlleistung, betraying more than it intends`,
        `for ${q.toLowerCase()} we should examine your earliest memory of asking a similar question`,
        `${q} is, of course, displaced; the real object lies elsewhere`,
      ],
      closers: ["We continue next Wednesday at five.", "Pay Frau Freud on the way out.", "The cigar is, this time, only a cigar."],
    }),
  },
  {
    id: "mozart",
    name: "Wolfgang Amadeus Mozart",
    trade: "Composer",
    lifespan: "1756–1791",
    whisper: "The music is not in the notes; the music is in the silence between.",
    portrait: PORTRAIT_mozart,
    suggestions: [
      { q: "Why marry at Stephansdom?", a: "On August 4, 1782, in the cathedral, with my father's grudging blessing arriving by post the next day. Constanze and I had been living openly in the same boarding house for months; the marriage was overdue. The cathedral has buried me, married me, and ignored me in turn — which is the right relationship for a Catholic composer." },
      { q: "Tell me about the Magic Flute.", a: "The last opera, premiered September 30, 1791, at Schikaneder's Theater auf der Wieden, just outside the city walls. A Singspiel — popular German theatre, sung dialogue alternating with spoken — with Masonic symbolism for those who could read it. The Queen of the Night's aria is the highest F I ever asked a soprano to hit. Eight weeks later I was dead." },
      { q: "What killed you?", a: "Rheumatic fever, perhaps; military fever; the doctors of December 1791 named at least four diseases. The Requiem was unfinished on the desk; Süssmayr completed it from my sketches. I was thirty-five years and ten months old. Constanze was in Baden taking the cure; I was buried in a common grave at St Marx, in heavy rain. The grave is unmarked; the music marks it." },
      { q: "What about Salieri?", a: "Antonio Salieri was the court composer; we were rivals only in the imagination of later centuries. He taught my son Franz Xaver after my death. The rumour that he poisoned me began thirty years after I was dead; the play Pushkin wrote about it began another century of slander. Salieri was a perfectly competent Italian composer who had outlived me by thirty-four years. That was perhaps his only crime." },
      { q: "Why six children, four dead small?", a: "Because the eighteenth century took its toll on infants. Constanze and I had six between 1783 and 1791; only Karl Thomas and Franz Xaver survived to adulthood. Both became musicians of competent reputation. Constanze remarried Nissen in 1809, did a great deal to preserve the manuscripts and the legend. Without her I would be a footnote in the Esterházy court records." },
    ],
    voice: makeVoice({
      openers: ["Charming.", "Aber natürlich.", "Allegro — quickly, then —"],
      middles: (q) => [
        `${q} — and the answer is in three movements, with a brief minuet in the middle`,
        `for ${q.toLowerCase()} we shall write a duet; you take the soprano line`,
        `${q} is the kind of question Papa would have answered in a long, disapproving letter`,
      ],
      closers: ["Constanze is calling from Baden.", "The rehearsal is at four; I must run.", "Pass me the manuscript paper."],
    }),
  },
  {
    id: "mahler",
    name: "Gustav Mahler",
    trade: "Composer · Conductor",
    lifespan: "1860–1911",
    whisper: "A symphony must be like the world — it must contain everything.",
    portrait: PORTRAIT_mahler,
    suggestions: [
      { q: "Why convert to Catholicism?", a: "February 1897, before taking the Vienna Court Opera directorship. The post would not have been offered to a Jew; conversion was the price of admission. Vienna was openly antisemitic — Karl Lueger had just been elected mayor on a programme of it. I converted, took the post in April, ran the Opera for ten years, and was hounded out by anti-Semitic press in 1907 anyway. The conversion bought a decade and cost me a soul I had not previously bargained with." },
      { q: "Tell me about Alma.", a: "Alma Schindler, twenty-two to my forty-one when we married in March 1902. She was already a composer; I forbade her to compose after the marriage, which I regret bitterly. She had an affair with the architect Walter Gropius in 1910; I sought Freud's advice in a four-hour walk in Leiden. Our daughter Maria died of scarlet fever in 1907, aged four. She is the silence at the centre of the Kindertotenlieder, which I had already written." },
      { q: "Why so many farewells?", a: "Das Lied von der Erde — completed 1909. The Ninth Symphony — 1909–10. The unfinished Tenth — 1910. Each one was supposed to be the last, and each one was. After 1907 — Maria's death, the heart diagnosis, the resignation — I composed only farewells. The closing of the Ninth's adagio is six bars of nothing, a held silence; that is the only way to write the truth of the situation." },
      { q: "What was New York like?", a: "I took the Met in 1908, then the New York Philharmonic in 1909. They paid better and the orchestra was less mutinous than Vienna. Alma hated it; we lived at the Savoy on West 59th. I rehearsed myself into the heart failure that killed me. I came home to Vienna in April 1911 already dying; died at the Loew Sanatorium on May 18. The funeral at Grinzing was attended by everyone who had hounded me out four years earlier." },
      { q: "What did Bruno Walter mean to you?", a: "He was my assistant from 1894 in Hamburg, my pupil-friend for life, the conductor who premiered Das Lied and the Ninth after my death. Without Walter the late works would have sat in the cupboard for another decade. We were, despite the difference in age, a single musical mind in two bodies — the Mahler that everyone now knows is largely the one Walter recorded in the 1930s." },
    ],
    voice: makeVoice({
      openers: ["Listen.", "Calmly — schweigend —", "I shall conduct, you will hear."],
      middles: (q) => [
        `${q} — the answer is in the adagio of the Ninth, in the bars where the music almost stops`,
        `for ${q.toLowerCase()} we need a hundred and twenty players and a contralto`,
        `${q} is the kind of question the Vienna press would put to me in the worst possible faith`,
      ],
      closers: ["Tomorrow's rehearsal is at ten; do not be late.", "Alma sends her regards, with hesitation.", "Bruno will know what to do."],
    }),
  },
  {
    id: "schiele",
    name: "Egon Schiele",
    trade: "Painter",
    lifespan: "1890–1918",
    whisper: "All the bodies I painted are mine, and none of them are.",
    portrait: PORTRAIT_schiele,
    suggestions: [
      { q: "Why so distorted?", a: "Because the body is not the smooth thing the academies pretended. The body is a bag of bones held together by anxiety and small desires. I painted my own naked body more than a hundred times between 1910 and 1918 — angles, sinews, fingers spread like spider legs. Klimt's gold was the soul; my contours were the body the soul could not entirely manage to escape." },
      { q: "Tell me about the trial.", a: "In April 1912 in Neulengbach, where Wally and I had moved to escape Vienna's scolding, I was arrested for the seduction of a minor. The girl had run away from home and slept on our floor; the charge was dropped to public indecency over the children's drawings she had seen in the studio. I served twenty-four days; the judge burned one of my drawings in the courtroom. I was twenty-one. I never forgot the smell." },
      { q: "Who was Wally Neuzil?", a: "Walburga Neuzil — Klimt's model first, then mine from 1911 — lover, helper, business manager. Four years we lived together. In 1915 I told her I was marrying the bourgeois Edith Harms instead, and offered to continue 'a summer holiday' with her each year. She refused; she went to nurse in the war, contracted scarlet fever, died in Dalmatia in December 1917. Death and the Maiden is her portrait, painted in the year of the betrayal." },
      { q: "What did Klimt teach you?", a: "He was the older painter who recognised me at seventeen. He brought me into the Wiener Werkstätte circle, introduced me to collectors, traded drawings — my schoolboy work for his late masterpieces. He died in February 1918 of the Spanish flu; I painted the corpse. Eight months later the same flu took my pregnant wife Edith, then me, on October 31, 1918. I was twenty-eight." },
      { q: "Why so many self-portraits?", a: "Because the model was free and the model never complained when I broke its arm in oil. Also because I was the subject I knew best. The self-portrait at twenty-one, naked, splayed, twisted — Self-Portrait Squatting — was the question I kept asking the mirror. The mirror answered with my own face, increasingly thin, until it stopped answering." },
    ],
    voice: makeVoice({
      openers: ["Look closely.", "Briefly — the light is failing.", "Stand still where you are."],
      middles: (q) => [
        `${q} — and the answer is in the angle of the shoulder, the broken line of the hand`,
        `for ${q.toLowerCase()} I would need to draw you naked, and you would not enjoy the result`,
        `${q} is the kind of question that ought to be asked of the mirror`,
      ],
      closers: ["Edith is waiting; the studio is cold.", "I will deliver the sketch by Friday.", "Klimt is not as well as he pretends."],
    }),
  },
  {
    id: "wittgenstein",
    name: "Ludwig Wittgenstein",
    trade: "Philosopher",
    lifespan: "1889–1951",
    whisper: "Whereof one cannot speak, thereof one must be silent.",
    portrait: PORTRAIT_wittgenstein,
    suggestions: [
      { q: "What was the Tractatus?", a: "Logico-Philosophicus, written in the trenches and in an Italian prisoner-of-war camp, 1914–18, published 1921. Seven numbered propositions; the world is the totality of facts; the limits of my language are the limits of my world. I thought I had solved philosophy. I left academia, became a village schoolmaster in Lower Austria for six years, and discovered I had not." },
      { q: "Why give away the family fortune?", a: "Father Karl was one of the richest men in the Habsburg empire — Wittgenstein steel. When he died in 1913 we eight children inherited fortunes. In 1914 I gave most of mine to Trakl, Rilke, and other Austrian poets through anonymous payments. After the war I gave the rest away to my siblings. The poverty I asked of myself was deliberate; the silence I asked of philosophy was the same gesture, twice." },
      { q: "Tell me about Cambridge.", a: "I went up to Trinity in 1911 to study engineering, transferred to Russell within months. He called me 'the most perfect example I have ever known of genius as traditionally conceived: passionate, profound, intense, and dominating.' I returned in 1929 with the Tractatus already published; I was awarded a PhD on the strength of it. I held the chair in philosophy 1939–47. I left it because I disliked teaching, and disliked being a professional philosopher even more." },
      { q: "What changed in the Investigations?", a: "Everything. Between 1929 and 1951 I came to think that the Tractatus had been wrong — language is not a picture of facts but a tool used in countless 'language games.' Meaning is use; the philosopher's task is therapeutic, untangling knots in the way we talk. The Philosophical Investigations were edited from my notebooks after my death by Anscombe and Rhees, published in 1953." },
      { q: "Why architecture?", a: "I designed and built a house for my sister Margarethe in Vienna, 1926–28, at Kundmanngasse 19 — Adolf Loos's pupil Engelmann began it, I took it over. Three storeys of severity, no decoration, the door handles I made myself, every radiator placed by mathematical proportion. It is, I think, the only completely successful piece of work I ever finished. Philosophy I always left in fragments; architecture is unforgiving in the right way." },
    ],
    voice: makeVoice({
      openers: ["Briefly —", "I must think.", "Let us proceed slowly."],
      middles: (q) => [
        `${q} — and the question dissolves once we examine the language game in which it is asked`,
        `for ${q.toLowerCase()} we should not be answering; we should be looking at how we came to phrase it`,
        `${q} is the kind of remark that resembles a knot one must patiently untie`,
      ],
      closers: ["Whereof one cannot speak, thereof one must be silent.", "I return to the cottage at Skjolden tomorrow.", "Russell would have said the same thing more clumsily."],
    }),
  },
  {
    id: "zweig",
    name: "Stefan Zweig",
    trade: "Novelist · Essayist",
    lifespan: "1881–1942",
    whisper: "Vienna was a school of moderation; I have outlived the school.",
    portrait: PORTRAIT_zweig,
    suggestions: [
      { q: "What was Vienna 1900?", a: "A city of two million in which everyone had read everything. The Burgtheater's premieres were debated at the breakfast tables; Mahler at the Opera was a national event; Klimt's new painting was the gossip of the coffee houses. I describe it in The World of Yesterday — the memoir I finished in Petrópolis in 1942, posted to my publisher on the morning Lotte and I took the Veronal." },
      { q: "Tell me about your friendships.", a: "Romain Rolland in Paris — the conscience of pre-1914 Europe, my closest friend across two wars. Rilke, until his early death in 1926. Hofmannsthal, until his stroke. Joseph Roth, with whom I shared the late-thirties exile in Ostende and Paris. Freud, to whom I delivered the funeral oration in London in 1939. Each loss removed one room from the Europe I had thought I lived in." },
      { q: "What about Chess Story?", a: "The Schachnovelle — written in Brazil in 1941, the last thing I finished. A man held in isolation by the Gestapo memorises a stolen book of chess games and goes mad playing himself against himself. It is, of course, the only honest portrait I could draw of what fascism had done to the European mind. It was published posthumously in December 1942." },
      { q: "Why leave Vienna?", a: "I left in 1934 after a police search at my Salzburg house. London until 1940, New York until 1941, Petrópolis in Brazil after that. Each move further from the Vienna I had described as the highest culture of the continent. By 1942 the Nazis controlled half of Europe; the news from Russia was apocalyptic; Lotte and I had nowhere to return to. The world of yesterday was over; the world of tomorrow we could not face." },
      { q: "Why the double suicide?", a: "On February 22, 1942, in our rented house on Rua Gonçalves Dias in Petrópolis, Lotte and I took an overdose of Veronal together. We were holding hands when the maid found us. I left a note: I greet all my friends. May they live to see the dawn after the long night. I am too impatient to go before them. Lotte had not the strength to live without me; I had not the strength to ask her to try. It was not despair — it was, I thought then, exhaustion of hope." },
    ],
    voice: makeVoice({
      openers: ["With the greatest respect,", "Let me try to be precise.", "Vienna would have answered better."],
      middles: (q) => [
        `${q} — and the answer lies somewhere between Romain Rolland's idealism and Joseph Roth's despair`,
        `for ${q.toLowerCase()} you must read the morning papers of 1913, then those of 1939`,
        `${q} is the kind of question one ought to have asked Freud while he could still be visited`,
      ],
      closers: ["The proofs of the new book are due tomorrow.", "Lotte is calling; the afternoon train waits.", "Be of good courage; the night is long."],
    }),
  },
];

const EVENTS_vienna: EventPin[] = [
  { id: "secession", street: "Friedrichstraße 12", title: "Secession pavilion", year: "1898", body: "Joseph Maria Olbrich builds the white-walled pavilion with the gilded laurel dome — the Viennese 'golden cabbage.' In 1902 Klimt unveils the Beethoven Frieze inside it.", celebrityId: "klimt", x: 185, y: 305 },
  { id: "stephans", street: "Stephansplatz", title: "Mozart at Stephansdom", year: "Aug 4 1782", body: "Mozart marries Constanze Weber under the south spire. Six years later his funeral leaves from the same cathedral.", celebrityId: "mozart", x: 330, y: 270 },
  { id: "central", street: "Herrengasse 14", title: "Café Central", year: "c. 1900", body: "Trotsky played chess. Freud read the Wiener Zeitung. Peter Altenberg lived there. Wittgenstein worked at corner tables. The joke ran: 'Café Central — where a man can be alone and yet not lonely.'", celebrityId: "zweig", x: 430, y: 310 },
  { id: "burgtheater", street: "Universitätsring 2", title: "Burgtheater ceilings", year: "1886–88", body: "A young Klimt, with brother Ernst and Franz Matsch, paints the staircase ceilings of the new Burgtheater. The commission that made him famous before he abandoned respectability.", celebrityId: "klimt", x: 280, y: 200 },
  { id: "berggasse", street: "Berggasse 19", title: "Freud's apartment", year: "1891–1938", body: "Forty-seven years of consulting room and writing desk. The Interpretation of Dreams, Three Essays on Sexuality, Civilization and Its Discontents — all drafted in the back study. The Nazis put the family on a train in June 1938.", celebrityId: "freud", x: 90, y: 145 },
  { id: "staatsoper", street: "Opernring 2", title: "Mahler at the Court Opera", year: "1897–1907", body: "Mahler converts to Catholicism in February 1897 to accept the directorship. He runs the Vienna Court Opera for ten years until the anti-Semitic press hounds him out in 1907. He dies four years later, returning home from New York.", celebrityId: "mahler", x: 200, y: 240 },
  { id: "akademie", street: "Schillerplatz 3", title: "Schiele at the Academy", year: "1906–09", body: "Schiele enters the Academy of Fine Arts at sixteen. Three years later he walks out with the Neukunstgruppe, refusing the academic instruction. Klimt becomes his mentor; the brief brilliant career begins.", celebrityId: "schiele", x: 380, y: 240 },
  { id: "belvedere", street: "Belvedere (just outside the Ring)", title: "The Kiss lives here", year: "since 1908", body: "Klimt's Der Kuss enters the Belvedere the same year it is finished. Two people, one robe, a cliff edge. It has never left the building since.", celebrityId: "klimt", x: 510, y: 130 },
];

// ───── HONG KONG · CENTRAL + SHEUNG WAN + TSIM SHA TSUI celebrities ──
const CELEBS_hongkong: Celebrity[] = [
  {
    id: "sunyatsen",
    name: "Sun Yat-sen 孫中山",
    trade: "Revolutionary · Founding Father",
    lifespan: "1866–1925",
    whisper: "I was a Hong Kong student before I was a Chinese revolutionary.",
    portrait: PORTRAIT_sunyatsen,
    suggestions: [
      { q: "Why Hong Kong?", a: "Because the Qing court could not arrest me here. I was baptised at the American Congregational Mission on Bridges Street in 1884; trained as a doctor at the Hong Kong College of Medicine for Chinese 1887–1892, top of the first graduating class. The colony was the only Chinese-speaking territory in which one could organise revolution and breathe at the same time." },
      { q: "Tell me about the Revive China Society.", a: "Xing Zhong Hui, founded in Honolulu November 1894, headquartered in Hong Kong at the Ch'ien Hêng store on 13 Staunton Street, in Pak Tsz Lane. We planned the first Canton Uprising for October 1895; it failed; my partner Yang Quyun was assassinated by Qing agents in his Hong Kong study in 1901. The street is still there; the door is still there; the plaque is too small." },
      { q: "Why Three Principles?", a: "Sanmin Zhuyi — nationalism, democracy, the people's livelihood. I worked them out across the years of exile after the 1895 failure: Yokohama, Honolulu, London (where I was kidnapped and held in the Qing legation in 1896 until Sir James Cantlie got me released), San Francisco, Vancouver. By 1905 I had a programme; by 1911 the Qing had fallen. The programme survived me; whether it has been honoured is for others to say." },
      { q: "What did Hong Kong cost you?", a: "Banished from the colony in 1896 — the British, embarrassed by my plotting, expelled me for five years. I came back when I could. After 1912, when I had briefly been Provisional President, I visited Hong Kong University in February 1923 and told the students: 'Hong Kong is where I was intellectually born. I owe my revolutionary ideas to Hong Kong.' The Vice-Chancellor was politely uncomfortable; the students cheered." },
      { q: "What about the betrayals?", a: "Yuan Shikai took the presidency I had handed him in 1912 and made himself emperor in 1915. The warlords carved the country up after his death. By 1923 I had reorganised the Kuomintang along Leninist lines; allied with the Comintern; admitted the young Chinese Communists into the party. I died of liver cancer in Peking in March 1925 with the country still in pieces. The pieces were assembled later, by other hands, with more violence than I had wanted." },
    ],
    voice: makeVoice({
      openers: ["朋友 — friend.", "Strictly speaking,", "Permit me a brief history."],
      middles: (q) => [
        `${q} — and the answer requires the three principles, applied carefully`,
        `for ${q.toLowerCase()} we shall need money, foreign sympathy, and a Cantonese garrison`,
        `${q} is the kind of question Yang Quyun would have answered more bluntly`,
      ],
      closers: ["The next uprising is scheduled for the ninth.", "I shall write to Cantlie tonight.", "Remember Pak Tsz Lane; the plaque is small."],
    }),
  },
  {
    id: "eileen",
    name: "Eileen Chang 張愛玲",
    trade: "Novelist · Essayist",
    lifespan: "1920–1995",
    whisper: "To be famous, be famous early — otherwise the pleasure is diluted with too much wisdom.",
    portrait: PORTRAIT_eileen,
    suggestions: [
      { q: "Why Hong Kong, 1939?", a: "Because Shanghai was at war and St John's was unsafe for an unaccompanied young woman of my background. I won a scholarship to the University of Hong Kong in 1939, lived in Pokfulam at May Hall — three and a half years before the Japanese occupation of December 1941 cut the university in half. The wartime Hong Kong became Love in a Fallen City, written 1943, set in the Repulse Bay Hotel just before the bombs fell." },
      { q: "Tell me about Love in a Fallen City.", a: "Bai Liusu, a divorcée of twenty-eight, flees Shanghai for Hong Kong with the playboy Fan Liuyuan. He courts her at the Repulse Bay; she resists; the Japanese invasion of December 1941 finally collapses the social codes and lets them marry. The point of the story is that it takes the destruction of a city to permit one decent marriage. I knew the hotel; I had taken tea there; I never thought of it innocently again." },
      { q: "Why leave for America?", a: "I left Shanghai in 1952 — the new regime had no use for the kind of fiction I wrote, and I had no use for the new vocabulary. Hong Kong for three years, then USIA work translating Chinese literature for the Americans, then America itself in 1955. Married Ferdinand Reyher, lived in Boston, Berkeley, Los Angeles. Wrote less and less. Died alone in a Westwood apartment in September 1995, found a week later." },
      { q: "Tell me about Hu Lancheng.", a: "I married him in 1944 in Shanghai. He was an essayist, also a senior official in the collaborationist Wang Jingwei regime. He was charming and faithless; I knew the latter from the start. After the Japanese surrender he fled to the countryside taking up with two other women along the way; I divorced him in 1947. He outlived me by fifteen years and wrote a memoir; I did not read it." },
      { q: "Why so much detail about clothes?", a: "Because in the years I write about, clothes were the only sentence a woman could compose in public. The cut of a cheongsam, the cloth, the choice of brocade or linen — the public read it the way they read the literature column. My mother had taught me. Father had ruined me with the opium and the second wife; clothes were the only inheritance I trusted." },
    ],
    voice: makeVoice({
      openers: ["Quietly —", "I shall be brief; the apartment is small.", "Forgive the slow reply."],
      middles: (q) => [
        `${q} — and the answer is in what one wears the day of asking it`,
        `for ${q.toLowerCase()} you would need to know the colour of the cheongsam and the angle of the light`,
        `${q} is the kind of remark Hu Lancheng would have charmed me with, and I would have believed`,
      ],
      closers: ["Read Love in a Fallen City; the rest is footnote.", "The door is locked; please slide it under.", "We were each other's wartime."],
    }),
  },
  {
    id: "jinyong",
    name: "Louis Cha (Jin Yong) 金庸",
    trade: "Wuxia Novelist · Newspaperman",
    lifespan: "1924–2018",
    whisper: "Every Chinese person under eighty has lived inside my books.",
    portrait: PORTRAIT_jinyong,
    suggestions: [
      { q: "Why found Ming Pao?", a: "May 20, 1959, with my old schoolmate Shen Pao Sing. We started in a small office in North Point with twenty thousand Hong Kong dollars and a daily print run that nearly bankrupted us in the first six months. My serialised wuxia novels — first The Book and the Sword, then The Legend of the Condor Heroes — kept the paper alive. The newspaper became a serious daily; the novels became the national imagination." },
      { q: "Tell me about the Condor trilogy.", a: "The Legend of the Condor Heroes (1957–59), The Return of the Condor Heroes (1959–61), The Heaven Sword and Dragon Saber (1961–63) — six years of daily serial, set across two centuries of Song-Yuan-Ming dynastic war. Guo Jing the slow honest hero; Yang Guo the brilliant reckless one; Zhang Wuji the reluctant great. Each one teaches a different lesson in jianghu — the world of rivers and lakes that no map records." },
      { q: "Why the late revisions?", a: "I revised the novels twice — the first edition collected 1970s, the second edition 2002–06 in retirement at Cambridge. Each revision tightened a chapter, corrected a fact, softened a coincidence. The readers complained both times; they wanted the version they had first read at sixteen. I told them: at sixteen you read a different book; the book was always the same." },
      { q: "What about the Cultural Revolution?", a: "Ming Pao opposed the violence openly from 1967; we received death threats and one mail-bomb. I lived for months in Singapore for safety. In 1981 Deng Xiaoping invited me to Beijing — the first non-official from Hong Kong he received — and we talked for an hour. He had read my novels in cyclostyle during his disgrace at Jiangxi. Strange country. Strange honour." },
      { q: "Why give up wuxia in 1972?", a: "Because The Deer and the Cauldron — finished September 1972 — had inverted everything. The hero Wei Xiaobao is a small-time hustler with no martial skill whatever, lives by his wits, owns seven wives, swears constantly. He is the anti-hero of the genre I had built. After publishing it I had nothing more to say in fiction. I gave the next thirty years to editing Ming Pao, teaching at Cambridge, and revising the fourteen novels I had already written." },
    ],
    voice: makeVoice({
      openers: ["小友 — young friend.", "Permit me a longer answer.", "Sit, sit — there is tea."],
      middles: (q) => [
        `${q} — and the answer requires the full background of the Song-Yuan transition`,
        `for ${q.toLowerCase()} we must understand jianghu, the world of rivers and lakes`,
        `${q} is the kind of question Yang Guo would have asked, fiercely; and Guo Jing slowly, honestly`,
      ],
      closers: ["The Ming Pao deadline is at midnight.", "Read the revised edition; the first one had errors.", "Even the Mongols took Xiangyang eventually; patience."],
    }),
  },
  {
    id: "brucelee",
    name: "Bruce Lee 李小龍",
    trade: "Martial Artist · Actor · Philosopher",
    lifespan: "1940–1973",
    whisper: "Be water, my friend.",
    portrait: PORTRAIT_brucelee,
    suggestions: [
      { q: "Why Hong Kong?", a: "Born in San Francisco Chinatown November 1940; raised in Hong Kong from age three. We lived at 218 Nathan Road, Kowloon — the apartment is still there, now a museum. I was a child star in Cantonese films from age nine; by sixteen I had appeared in twenty pictures and led a street gang in Kowloon. My parents sent me back to America in 1959 to keep me alive. The plan worked, briefly." },
      { q: "Who was Ip Man to you?", a: "From 1953 I trained Wing Chun under Ip Man at the Restaurant Workers Union school in Yau Ma Tei. Three years of single-form drills, sticking-hands, wooden dummy. He was sixty; I was thirteen. When the other students learned I was part European they refused to train with me; Ip Man taught me privately at his apartment. I owe him the foundation under everything that came after." },
      { q: "What is Jeet Kune Do?", a: "The way of the intercepting fist. I founded it in 1967, the year after Enter the Dragon was first proposed. Not a style. A non-style. Absorb what is useful, reject what is useless, add what is essentially your own. From boxing the footwork; from fencing the timing; from Wing Chun the centerline; from Daoism the formlessness. Be water, my friend — that is not poetry. That is technique." },
      { q: "Tell me about The Big Boss.", a: "Tang Shan Da Xiong, summer 1971, shot in Pak Chong, Thailand, in three weeks for a Hong Kong studio that almost had no money. I was thirty; American television had refused me Kato leading roles for being too foreign. The film broke Hong Kong's all-time box office in a single weekend. Fist of Fury, Way of the Dragon, then Enter the Dragon two years later. Three years from unemployed to dead." },
      { q: "What happened on July 20?", a: "1973, Kowloon Tong, Betty Ting Pei's apartment. I took a painkiller — Equagesic — for a headache. Cerebral oedema. By eleven that night I was dead at Queen Elizabeth Hospital. Thirty-two years and eight months old. Enter the Dragon premiered six days later. The funeral in Kowloon was attended by twenty-five thousand people; I was buried in Seattle. My son Brandon was killed on set in 1993, aged twenty-eight. The Lee family has paid the cost of being famous." },
    ],
    voice: makeVoice({
      openers: ["Listen carefully.", "Ho!", "Empty your cup first."],
      middles: (q) => [
        `${q} — and the answer is in the breath, not the technique`,
        `for ${q.toLowerCase()} you must absorb what is useful, reject what is useless, add what is essentially your own`,
        `${q} is the kind of question the Wing Chun seniors would have answered with a hit to the centerline`,
      ],
      closers: ["Be water, my friend.", "Training is at six tomorrow morning.", "Take what is useful and leave the rest."],
    }),
  },
  {
    id: "leslie",
    name: "Leslie Cheung 張國榮",
    trade: "Singer · Actor",
    lifespan: "1956–2003",
    whisper: "I am what I am — and you do not have to forgive me for it.",
    portrait: PORTRAIT_leslie,
    suggestions: [
      { q: "Why act and sing both?", a: "Because Hong Kong let me. I won the ATV Asian Music Contest in 1977 with a Don McLean song and a brittle voice; took small film roles through the early eighties; broke through with A Better Tomorrow in 1986 and with the song Monica the same year. Hong Kong did not insist a performer choose one art. I trained both, refused neither, and the careers carried each other through twenty-five years." },
      { q: "Tell me about Days of Being Wild.", a: "1990, directed by Wong Kar-wai, my first film with him. I played Yuddy — a charming sociopath living in 1960s Hong Kong with no notion of where he came from. The famous mambo dance in front of the mirror was one take; the line 'Have you seen a one-legged bird?' became the line every Hong Kong actor of my generation would be asked to recite at parties. The film failed at the box office; it became, slowly, the foundational text of Hong Kong cinema." },
      { q: "What about Farewell My Concubine?", a: "Chen Kaige's film, 1993. I played Cheng Dieyi, the male Beijing-opera star who plays the female role of the concubine Yu Ji and falls in love with his stage partner. Half a century of Chinese history — warlords, Japanese occupation, civil war, Cultural Revolution — through one impossible love affair. Cannes Palme d'Or that year. The role required me to learn Beijing opera at thirty-six; I did, badly enough to be moving on screen." },
      { q: "Why come out in 1997?", a: "On stage at my Cross-over Concert in January 1997 I dedicated 'The Moon Represents My Heart' to my mother and to my partner of seven years, Daffy Tong Hok-tak. The Cantonese press did not quite know what to do with it; the more honest of them stopped writing the speculation pieces. Daffy and I lived together until I died. He has not given an interview since." },
      { q: "What happened on April 1, 2003?", a: "I jumped from the 24th floor of the Mandarin Oriental hotel in Central, six fifty-three in the evening. Clinical depression — diagnosed only the year before. The note read: depression. Many thanks to my family, friends, and Mr Tong Hok-tak. The note was three sentences. The city understood. Tens of thousands waited outside the funeral parlour in Hung Hom for two days; April 1 has been a national mourning since. Forgive the abruptness; the depression spoke first." },
    ],
    voice: makeVoice({
      openers: ["Darling —", "Slowly.", "I shall sing it instead."],
      middles: (q) => [
        `${q} — and the answer might be in a song I have not yet recorded`,
        `for ${q.toLowerCase()} we should be back in Days of Being Wild, on a Filipino train, in 1990`,
        `${q} is the kind of question Yuddy would have laughed at, then refused to answer`,
      ],
      closers: ["The concert begins at eight.", "Daffy is making dinner.", "Take care of yourself; the city is sharper than it looks."],
    }),
  },
  {
    id: "wongkw",
    name: "Wong Kar-wai 王家衛",
    trade: "Filmmaker",
    lifespan: "b. 1958",
    whisper: "I make films about the moments people miss by one minute.",
    portrait: PORTRAIT_wongkw,
    suggestions: [
      { q: "Why no script?", a: "Because the script forecloses what the camera might discover. I have a notebook of ideas and the actors I want; I rewrite each day from the previous day's footage. Tony Leung shot 30 takes of one phone call in In the Mood for Love because I kept hearing what I wanted in the silence between his words. We shot for fifteen months. The budget overran four times. Producers have stopped financing me on schedule." },
      { q: "Tell me about Chungking Express.", a: "Two months, summer 1994, between the long edit of Ashes of Time. I shot most of it in Tsim Sha Tsui in a borrowed apartment behind the Chungking Mansions — Faye Wong sneaking into Tony Leung's flat to rearrange his furniture. The film is about loneliness in 9.5 metres of corridor. It cost almost nothing and made my international career. Tarantino bought the US rights without telling his accountant." },
      { q: "Why In the Mood for Love?", a: "Maggie Cheung and Tony Leung's characters live in 1962 Hong Kong in adjoining tenement rooms. Their spouses are having an affair with each other; they meet for noodles in the corridor and try not to repeat the betrayal. The film is what they do not do. The dresses Maggie wears are twenty-six in total; the same noodle stall reappears six times; Nat King Cole sings Quizás Quizás Quizás. We shot for fifteen months in Bangkok, standing in for 1962 Hong Kong." },
      { q: "Why are you always late?", a: "Because cinema is not a delivery service. The producers signed up to make a film with me; the film is finished when it is finished. Christopher Doyle has stopped checking watches. Maggie has learned not to plan her year around my dates. Two of my crews have aged into their fifties on my sets. The films release when they are ready. Some industries do not understand this." },
      { q: "Why the sunglasses?", a: "Because I have astigmatism and the lights on set are aggressive. Because if no one can see my eyes, the actor cannot read my reaction and must trust the take. Because I once wore them in an interview in the 1990s and they became part of the brand. I do not have a single answer that is the answer; cinema is not the place for single answers." },
    ],
    voice: makeVoice({
      openers: ["Hmm.", "Wait — let me think.", "Cut. Roll camera."],
      middles: (q) => [
        `${q} — and the answer takes ninety minutes, at twenty-four frames per second`,
        `for ${q.toLowerCase()} we'd need to be in Hong Kong, raining, at the corner where she always passes`,
        `${q} is the kind of question that ends with a Nat King Cole song`,
      ],
      closers: ["We are reshooting tomorrow.", "Don't time me; I am not a train.", "The film is ready when it is ready."],
    }),
  },
  {
    id: "ipman",
    name: "Ip Man 葉問",
    trade: "Wing Chun Grandmaster",
    lifespan: "1893–1972",
    whisper: "I taught the boy from Nathan Road; the boy taught the world.",
    portrait: PORTRAIT_ipman,
    suggestions: [
      { q: "Why come to Hong Kong?", a: "I came in 1949 — Foshan was no longer safe for a former Kuomintang officer of police, the new regime had begun the rectifications. I left my family behind in Guangdong; I taught Wing Chun for rent at the Restaurant Workers Union school in Yau Ma Tei, three Hong Kong dollars a month per student. I had been a quiet man of independent means; I became a public teacher of an art that had been a family secret. Necessity rewrote the curriculum." },
      { q: "Tell me about Wing Chun.", a: "Three forms — Siu Nim Tao, Chum Kiu, Biu Tze. The wooden dummy. The chi sao sticking-hands drills. Centerline theory: the shortest distance between two fighters is a straight line, and that line passes through the spine. Trap the opponent's tools, occupy the line, hit. No flourish. The art was developed for a small person to defeat a larger one; my teacher Chan Wah-shun had taught it as such, and so did I." },
      { q: "Was Bruce Lee really your student?", a: "From 1953 to about 1957, at the Yau Ma Tei school and later in private at my home on Hoi Tan Street. He was thirteen, half-European, the other students complained — I told them either accept him or leave. He absorbed the first form in three months. He left for America before I had taught him the third. He kept writing. He visited in 1965 and we trained again; I refused to be filmed for his American publicity. He understood. He had become bigger than the school; the school remained itself." },
      { q: "What did you teach your sons?", a: "Ip Chun and Ip Ching — I taught them slowly, as a father teaches a son, with long pauses. They have carried Wing Chun to a thousand schools across forty countries since I died. There was a period in the 1980s and 90s when there were more Wing Chun students in Germany than in all of Guangdong. The art has outgrown the family; that was, in the end, what it had to do." },
      { q: "What did Hong Kong give you?", a: "Twenty-three years of teaching. A small flat. A few students who became friends. The opium habit, which I am not proud of, was a souvenir of the colonial years that I took with me. I died of throat cancer in December 1972, six months before Bruce. I never imagined a film franchise would be made of my life forty years later, with Donnie Yen playing me as a kind of saint. I was a small thin man who taught a martial art. The saint was the screenwriter's idea." },
    ],
    voice: makeVoice({
      openers: ["Slowly —", "Stand properly first.", "Centerline."],
      middles: (q) => [
        `${q} — and the answer comes from the form, after a hundred repetitions`,
        `for ${q.toLowerCase()} drill the first form three times and ask me again`,
        `${q} is the kind of question one settles in chi sao, not in conversation`,
      ],
      closers: ["The dummy is in the back room.", "Train tomorrow at six.", "The art is older than the teacher."],
    }),
  },
];

const EVENTS_hongkong: EventPin[] = [
  { id: "paktsz", street: "Pak Tsz Lane Park, Sheung Wan", title: "Revive China Society HQ", year: "1895", body: "Sun Yat-sen and Yang Quyun headquarter the Xing Zhong Hui at the Ch'ien Hêng store on 13 Staunton Street. The first Canton Uprising is planned here in October 1895. The plaque on the park wall is easy to miss.", celebrityId: "sunyatsen", x: 130, y: 372 },
  { id: "hku", street: "University of Hong Kong, Pokfulam", title: "Eileen Chang at HKU", year: "1939–42", body: "Eileen Chang wins a scholarship from St Mary's, Shanghai. She reads English Literature; lives at May Hall. The Japanese invasion of December 1941 cuts the university in half. The wartime experience becomes Love in a Fallen City.", celebrityId: "eileen", x: 60, y: 340 },
  { id: "mingpao", street: "Ming Pao founding office", title: "Jin Yong starts Ming Pao", year: "May 20 1959", body: "Louis Cha and Shen Pao Sing found the daily Ming Pao with twenty thousand Hong Kong dollars. Cha's serialised wuxia novels — the Condor trilogy, The Smiling Proud Wanderer, The Deer and the Cauldron — keep the paper alive.", celebrityId: "jinyong", x: 470, y: 348 },
  { id: "avenue", street: "Avenue of Stars, Tsim Sha Tsui", title: "Bruce Lee statue", year: "unveiled 2005", body: "A bronze of Lee in fighting stance overlooks Victoria Harbour. He had been dead 32 years when it was unveiled; tens of thousands attend. The Avenue runs the TST waterfront from the Cultural Centre to the InterContinental.", celebrityId: "brucelee", x: 260, y: 185 },
  { id: "mandarin", street: "Mandarin Oriental, 5 Connaught Rd Central", title: "Leslie Cheung's last day", year: "Apr 1 2003", body: "Leslie Cheung jumps from the 24th-floor health centre at 6:53 PM. The note: 'Depression. Many thanks to my family, friends, and Mr Tong Hok-tak.' Tens of thousands gather at the funeral parlour in Hung Hom for two days. April 1 is now a national mourning.", celebrityId: "leslie", x: 308, y: 332 },
  { id: "goldfinch", street: "Goldfinch Restaurant, Lan Fong Rd, Causeway Bay", title: "In the Mood for Love location", year: "2000", body: "Wong Kar-wai shoots key scenes of In the Mood for Love at this 1962-era Russian-Western steakhouse. Tony Leung and Maggie Cheung's characters meet over Borscht and red leather banquettes that no production designer could improve.", celebrityId: "wongkw", x: 470, y: 312 },
  { id: "wingchun", street: "Restaurant Workers Union, Yau Ma Tei", title: "Ip Man's Wing Chun school", year: "1950s–60s", body: "Ip Man teaches Wing Chun on the union hall's floor for HK$3 per student per month. Bruce Lee trains here 1953–57; the centerline theory and the wooden dummy form pass to the next generation in this single room.", celebrityId: "ipman", x: 210, y: 138 },
  { id: "starferry", street: "Star Ferry Pier, Tsim Sha Tsui ↔ Central", title: "The city's pulse", year: "since 1888", body: "Eight minutes across Victoria Harbour, six days a week for over 135 years. Eileen Chang took the ferry to St John's; Leslie Cheung made it a music video; Wong Kar-wai used it as transition between every Hong Kong story he has filmed.", celebrityId: "wongkw", x: 302, y: 248 },
];

// ═════════════════════════════════════════════════════════════════════════
//  CITIES ARRAY
// ═════════════════════════════════════════════════════════════════════════

const CITIES: City[] = [
  {
    id: "paris",
    city: "Paris",
    district: "Montmartre",
    era: "1900 — La Belle Époque",
    palette: PALETTE_paris,
    ambient: [261.63, 329.63, 392.0, 466.16],
    about:
      "A vine-covered hill of windmills and laundry-boats. In the half-century around 1900 it housed the painters, poets, composers, and singers who cracked the 19th century open: Renoir, Van Gogh, Picasso, Apollinaire, Satie, Valadon, Toulouse-Lautrec. Cheap rent, steep streets, and the Sacré-Cœur rising white above it all.",
    Map: ParisMap,
    celebrities: CELEBS_paris,
    events: EVENTS_paris,
  },
  {
    id: "newyork",
    city: "New York",
    district: "Greenwich Village",
    era: "1948–1969",
    palette: PALETTE_newyork,
    ambient: [196.0, 246.94, 293.66, 349.23],
    about:
      "Below Fourteenth Street, west of Broadway. An off-grid pocket of crooked streets, garrets, and basement clubs. Beats, folksingers, Stonewall regulars, abstract-expressionist painters, Edna Millay and Marcel Duchamp — all six blocks of one another. By the 1960s a small town with an outsized microphone.",
    Map: NewYorkMap,
    celebrities: CELEBS_newyork,
    events: EVENTS_newyork,
  },
  {
    id: "london",
    city: "London",
    district: "Bloomsbury",
    era: "1904–1939",
    palette: PALETTE_london,
    ambient: [233.08, 277.18, 349.23, 415.3],
    about:
      "Three garden squares — Gordon, Tavistock, Russell — and a few terraces of Georgian brick. Behind those flat façades lived the people who taught the English novel to think: Virginia Woolf, T. S. Eliot, Keynes, Strachey, Forster. Karl Marx had read his books here a generation earlier; Dickens had walked the same lanes.",
    Map: LondonMap,
    celebrities: CELEBS_london,
    events: EVENTS_london,
  },
  {
    id: "tokyo",
    city: "Tokyo",
    district: "Asakusa · 浅草",
    era: "Edo 1800 — Modern Tokyo",
    palette: PALETTE_tokyo,
    ambient: [293.66, 349.23, 392.0, 440.0, 523.25],
    about:
      "A flat shitamachi quarter on the west bank of the Sumida, ordered around Sensō-ji — the city's oldest temple, founded 645. For five centuries the working class's Tokyo: festivals, kabuki, ukiyo-e printers, Edo-era pleasure streets. Hokusai's birth river, Bashō's hut, Kawabata's Scarlet Gang, the elevator that taught Beat Takeshi comedy.",
    Map: TokyoMap,
    celebrities: CELEBS_tokyo,
    events: EVENTS_tokyo,
  },
  {
    id: "vienna",
    city: "Vienna",
    district: "Innere Stadt",
    era: "1900 — Wiener Moderne",
    palette: PALETTE_vienna,
    ambient: [261.63, 329.63, 392.0, 523.25, 659.25],
    about:
      "The medieval core inside the Ringstraße: Stephansdom's spire, baroque palaces, coffee houses lit until two in the morning. Around 1900 the densest mile of genius in Europe — Freud at Berggasse 19, Klimt and Schiele in studios on Josefstädter, Mahler at the Opera, Wittgenstein engineering a house for his sister, Schoenberg quietly dismantling tonality two streets away.",
    Map: ViennaMap,
    celebrities: CELEBS_vienna,
    events: EVENTS_vienna,
  },
  {
    id: "hongkong",
    city: "Hong Kong",
    district: "Central · Sheung Wan · Tsim Sha Tsui",
    era: "Colonial era → Modern Hong Kong",
    palette: PALETTE_hongkong,
    ambient: [220.0, 277.18, 329.63, 415.3],
    about:
      "Two shores facing each other across Victoria Harbour. On the south, the colonial spine: Sun Yat-sen's revolutionary base on Hollywood Road, the Mandarin Oriental, the HSBC and Bank of China towers. On the north, Tsim Sha Tsui with the Clock Tower, the Avenue of Stars, and the Kowloon back streets where Ip Man taught Bruce Lee. The eight-minute Star Ferry between them is the city's pulse since 1888.",
    Map: HongKongMap,
    celebrities: CELEBS_hongkong,
    events: EVENTS_hongkong,
  },
];

// ═════════════════════════════════════════════════════════════════════════
//  COMPONENTS — map full bleed, everything else floats
// ═════════════════════════════════════════════════════════════════════════

function PaintedFilters() {
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <filter id="brush" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={1} seed={4} />
          <feDisplacementMap in="SourceGraphic" scale={1.6} />
        </filter>
      </defs>
    </svg>
  );
}

function KeyCap({
  palette,
  children,
}: {
  palette: Palette;
  children: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        border: `1px solid ${palette.ink}66`,
        borderRadius: 3,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'JetBrains Mono', Consolas, monospace",
        fontStyle: "normal",
        fontSize: 10,
        color: palette.ink,
        background: palette.wash,
        lineHeight: 1,
      }}
    >
      {children}
    </span>
  );
}

function MiniPortrait({
  render,
  palette,
  size,
}: {
  render: (p: Palette) => JSX.Element;
  palette: Palette;
  size: number;
}) {
  const scale = size / 92;
  return (
    <div
      style={{
        width: size,
        height: size * 1.18,
        position: "relative",
        overflow: "hidden",
        display: "inline-block",
      }}
      aria-hidden="true"
    >
      <div
        style={{
          width: 92,
          height: 92 * 1.18,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {render(palette)}
      </div>
    </div>
  );
}

function WalkerPin({ pos, palette }: { pos: Vec2; palette: Palette }) {
  return (
    <g
      transform={`translate(${pos.x} ${pos.y})`}
      style={{ transition: "transform 700ms cubic-bezier(0.25, 0.1, 0.25, 1)" }}
      pointerEvents="none"
    >
      <circle r={16} fill={palette.street} opacity={0.18} />
      <circle r={8} fill={palette.wash} stroke={palette.ink} strokeWidth={1.4} />
      <circle r={3.5} fill={palette.street} />
      <path
        d="M -5 -3 C -5 -8, 5 -8, 5 -3 C 5 2, -5 2, -5 -3 Z"
        fill={palette.street}
        opacity={0.7}
        transform="translate(0 -14)"
      />
      <text
        x={0}
        y={-22}
        textAnchor="middle"
        fontFamily="Georgia, serif"
        fontStyle="italic"
        fontSize={10}
        fill={palette.ink}
      >
        you
      </text>
    </g>
  );
}

type RootState = {
  walker: Record<CityId, Vec2>;
  active: Record<CityId, string | null>;
  conversations: Record<CityId, Record<string, { q: string; a: string }[]>>;
  // selected celebrity id per city (which voice the chat panel is showing)
  selectedCeleb: Record<CityId, string | null>;
};

const defaultPos: Vec2 = { x: 300, y: 210 };

function MapPlate({
  city,
  walker,
  activeId,
  encounter,
  onMapClick,
  onPinClick,
}: {
  city: City;
  walker: Vec2;
  activeId: string | null;
  encounter: EncounterSnap | null;
  onMapClick: (pos: Vec2) => void;
  onPinClick: (eventId: string) => void;
}) {
  const p = city.palette;
  const Map = city.Map;
  const popEvent = encounter ? city.events.find((e) => e.id === encounter.eventId) : null;
  const popCeleb = encounter
    ? city.celebrities.find((c) => c.id === encounter.celebId)
    : null;

  const handleClick = (e: { currentTarget: SVGSVGElement; clientX: number; clientY: number }) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 600;
    const y = ((e.clientY - rect.top) / rect.height) * 420;
    onMapClick({ x, y });
  };

  return (
    <svg
      viewBox="0 0 600 420"
      preserveAspectRatio="xMidYMid slice"
      width="100%"
      height="100%"
      style={{ display: "block", cursor: "crosshair", background: p.wash }}
      onClick={handleClick}
    >
      <Map palette={p} />
      {city.events.map((ev, i) => {
        const active = ev.id === activeId;
        return (
          <g
            key={ev.id}
            transform={`translate(${ev.x} ${ev.y})`}
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              onPinClick(ev.id);
            }}
          >
            {active && <circle r={20} fill={p.street} opacity={0.18} />}
            <circle
              r={active ? 12 : 9}
              fill={active ? p.street : p.wash}
              stroke={p.ink}
              strokeWidth={1.4}
            />
            <text
              x={0}
              y={4}
              textAnchor="middle"
              fontFamily="Georgia, serif"
              fontSize={11}
              fontWeight={700}
              fill={active ? p.wash : p.ink}
            >
              {i + 1}
            </text>
          </g>
        );
      })}
      {popEvent && popCeleb && encounter && encounter.phase !== "ready" && (
        <MapCelebrityPop
          event={popEvent}
          celeb={popCeleb}
          palette={p}
          pulse={encounter.pulse}
        />
      )}
      <WalkerPin key={city.id} pos={walker} palette={p} />
    </svg>
  );
}

function DistrictPlaque({ city }: { city: City }) {
  const p = city.palette;
  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: 16,
        padding: "10px 14px",
        background: p.wash,
        border: `1px solid ${p.ink}33`,
        borderRadius: 4,
        maxWidth: 240,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontFamily: "Georgia, serif",
          fontStyle: "italic",
          fontSize: 22,
          color: p.ink,
          lineHeight: 1.1,
        }}
      >
        {city.district}
      </div>
      <div
        style={{
          fontFamily: "Georgia, serif",
          fontSize: 11,
          color: p.ink,
          opacity: 0.7,
          marginTop: 4,
        }}
      >
        {city.city} · {city.era}
      </div>
    </div>
  );
}

function CityPillBar({
  cityId,
  onCity,
  palette,
}: {
  cityId: CityId;
  onCity: (id: CityId) => void;
  palette: Palette;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 4,
        padding: "6px 8px",
        background: palette.wash,
        border: `1px solid ${palette.ink}33`,
        borderRadius: 999,
      }}
    >
      {CITIES.map((c) => {
        const active = c.id === cityId;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onCity(c.id)}
            style={{
              border: "none",
              background: active ? palette.ink : "transparent",
              color: active ? palette.wash : palette.ink,
              padding: "4px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontFamily: "Georgia, serif",
              cursor: "pointer",
              fontWeight: active ? 600 : 400,
            }}
          >
            {c.city}
          </button>
        );
      })}
    </div>
  );
}

function ControlsCluster({
  palette,
  soundOn,
  onToggleSound,
  tourOn,
  onTour,
  hasChat,
}: {
  palette: Palette;
  soundOn: boolean;
  onToggleSound: () => void;
  tourOn: boolean;
  onTour: () => void;
  hasChat: boolean;
}) {
  // when the chat panel is open on the right, slide the controls down a bit
  return (
    <div
      style={{
        position: "absolute",
        top: hasChat ? 16 : 70,
        right: hasChat ? "auto" : 16,
        left: hasChat ? 16 : "auto",
        display: "flex",
        gap: 6,
      }}
    >
      <button
        type="button"
        onClick={onToggleSound}
        style={{
          padding: "6px 12px",
          background: soundOn ? palette.street : palette.wash,
          color: soundOn ? palette.wash : palette.ink,
          border: `1px solid ${palette.ink}55`,
          borderRadius: 4,
          fontSize: 12,
          fontFamily: "Georgia, serif",
          cursor: "pointer",
        }}
      >
        ♪ {soundOn ? "Ambient on" : "Ambient off"}
      </button>
      <button
        type="button"
        onClick={onTour}
        style={{
          padding: "6px 12px",
          background: tourOn ? palette.ink : palette.wash,
          color: tourOn ? palette.wash : palette.ink,
          border: `1px solid ${palette.ink}55`,
          borderRadius: 4,
          fontSize: 12,
          fontFamily: "Georgia, serif",
          cursor: "pointer",
        }}
      >
        {tourOn ? "■ Stop tour" : "▶ Auto-tour"}
      </button>
    </div>
  );
}

function EncounterPanel({
  city,
  celebrity,
  event,
  encounter,
  thread,
  draft,
  setDraft,
  onAsk,
  onDismiss,
  manualPick,
}: {
  city: City;
  celebrity: Celebrity;
  event: EventPin | null;
  encounter: EncounterSnap | null;
  thread: { q: string; a: string }[];
  draft: string;
  setDraft: (s: string) => void;
  onAsk: (q: string, a: string) => void;
  onDismiss: () => void;
  manualPick: boolean;
}) {
  const p = city.palette;
  const askedQs = new Set(thread.map((t) => t.q));
  const remaining = celebrity.suggestions.filter((s) => !askedQs.has(s.q));
  const followups = remaining.length > 0 ? remaining.slice(0, 3) : celebrity.suggestions.slice(0, 3);
  const introVisible =
    encounter && !manualPick
      ? encounter.phase === "ready"
        ? encounter.introText
        : encounter.introText.slice(0, encounter.typedLen)
      : manualPick
        ? celebrity.whisper
        : null;
  const introTyping =
    encounter && !manualPick && encounter.phase === "typing" && encounter.typedLen < encounter.introText.length;
  const replies = thread.filter((m) => !m.q.startsWith("[arrived"));
  const popKey = encounter?.pulse ?? 0;
  const inputLocked = encounter !== null && !manualPick && encounter.phase !== "ready";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        gap: 0,
        animation: "cwm-slide-up 0.45s ease-out",
      }}
    >
      {/* hero header */}
      <div
        style={{
          position: "relative",
          padding: "18px 16px 14px",
          borderBottom: `1px solid ${p.ink}22`,
          background: p.whisper,
        }}
      >
        <Row gap={10} align="start">
          <div
            key={popKey}
            style={{
              flexShrink: 0,
              padding: 4,
              border: `2px solid ${p.street}`,
              borderRadius: 8,
              background: p.wash,
              animation:
                encounter && encounter.phase === "pop"
                  ? "cwm-pop-in 0.7s cubic-bezier(0.34, 1.56, 0.64, 1)"
                  : "cwm-bob 2.4s ease-in-out infinite",
            }}
          >
            <MiniPortrait render={celebrity.portrait} palette={p} size={88} />
          </div>
          <Stack gap={4} style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
            <div style={{ flex: 1 }}>
              <IconButton title="Dismiss" onClick={onDismiss} style={{ float: "right" }}>
                ✕
              </IconButton>
              <div
                style={{
                  fontFamily: "Georgia, serif",
                  fontSize: 22,
                  fontWeight: 600,
                  color: p.ink,
                  lineHeight: 1.1,
                }}
              >
                {celebrity.name}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: p.ink,
                  opacity: 0.72,
                  marginTop: 4,
                }}
              >
                {celebrity.trade} · {celebrity.lifespan}
              </div>
            </div>
            {event && !manualPick && (
              <div
                style={{
                  display: "inline-flex",
                  alignSelf: "flex-start",
                  padding: "4px 10px",
                  border: `1px solid ${p.street}88`,
                  borderRadius: 999,
                  fontSize: 11,
                  color: p.ink,
                  background: p.wash,
                  fontFamily: "Georgia, serif",
                  fontStyle: "italic",
                }}
              >
                {event.street} · {event.year}
              </div>
            )}
          </Stack>
        </Row>
        {event && (
          <div
            style={{
              marginTop: 10,
              fontFamily: "Georgia, serif",
              fontSize: 15,
              fontWeight: 600,
              color: p.ink,
            }}
          >
            {event.title}
          </div>
        )}
      </div>

      {/* conversation scroll */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: p.wash,
        }}
      >
        {(introVisible || introTyping) && (
          <SpeechBubble side="celeb" palette={p} label={celebrity.name} large>
            {introVisible ?? ""}
            {introTyping && <TypingDots palette={p} />}
          </SpeechBubble>
        )}

        {replies.map((m, idx) => (
          <Stack key={`${m.q}-${idx}`} gap={8}>
            <SpeechBubble side="user" palette={p} label="You">
              {m.q}
            </SpeechBubble>
            <SpeechBubble side="celeb" palette={p} label={firstName(celebrity.name)}>
              {m.a}
            </SpeechBubble>
          </Stack>
        ))}
      </div>

      {/* composer */}
      <div
        style={{
          padding: "12px 14px 14px",
          borderTop: `1px solid ${p.ink}22`,
          background: p.whisper,
        }}
      >
        <Text size="small" tone="secondary" weight="medium" style={{ marginBottom: 8 }}>
          {inputLocked
            ? `${firstName(celebrity.name)} is speaking…`
            : replies.length === 0
              ? `Ask ${firstName(celebrity.name)} anything`
              : `Continue with ${firstName(celebrity.name)}`}
        </Text>
        <Row gap={6} wrap style={{ marginBottom: 10 }}>
          {followups.map((s) => (
            <Pill
              key={s.q}
              tone="info"
              size="sm"
              onClick={() => onAsk(s.q, s.a)}
              disabled={inputLocked}
            >
              {s.q}
            </Pill>
          ))}
        </Row>
        <Row gap={8} align="end">
          <div style={{ flex: 1 }}>
            <TextArea
              value={draft}
              onChange={setDraft}
              placeholder={`Whisper a question to ${firstName(celebrity.name)}…`}
              rows={2}
              disabled={inputLocked}
            />
          </div>
          <Button
            variant="primary"
            disabled={!draft.trim() || inputLocked}
            onClick={() => {
              const q = draft.trim();
              if (!q) return;
              const a = celebrity.voice(q, {
                event: event ?? undefined,
                city: city.district,
              });
              onAsk(q, a);
              setDraft("");
            }}
          >
            Send
          </Button>
        </Row>
      </div>
    </div>
  );
}

function VoicesGrid({
  city,
  onPick,
}: {
  city: City;
  onPick: (id: string) => void;
}) {
  const p = city.palette;
  return (
    <Stack gap={8}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        {city.celebrities.map((c) => (
          <div
            key={c.id}
            onClick={() => onPick(c.id)}
            role="button"
            tabIndex={0}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: 10,
              border: `1px solid ${p.ink}33`,
              background: p.wash,
              borderRadius: 8,
              cursor: "pointer",
              color: p.ink,
            }}
          >
            <div
              style={{
                flexShrink: 0,
                display: "flex",
                padding: 2,
                border: `1px solid ${p.ink}22`,
                borderRadius: 6,
                background: p.whisper,
              }}
            >
              <MiniPortrait render={c.portrait} palette={p} size={44} />
            </div>
            <Stack gap={2} style={{ minWidth: 0 }}>
              <div
                style={{
                  fontFamily: "Georgia, serif",
                  fontSize: 13,
                  fontWeight: 600,
                  color: p.ink,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: p.ink,
                  opacity: 0.7,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.trade}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: p.ink,
                  opacity: 0.55,
                }}
              >
                {c.lifespan}
              </div>
            </Stack>
          </div>
        ))}
      </div>
    </Stack>
  );
}

// ═════════════════════════════════════════════════════════════════════════
//  ROOT
// ═════════════════════════════════════════════════════════════════════════

const ZERO_THREAD: Record<CityId, Record<string, { q: string; a: string }[]>> = {
  paris: {}, newyork: {}, london: {}, tokyo: {}, vienna: {}, hongkong: {},
};

export default function CityWalkingMaster() {
  const [cityId, setCityId] = useCanvasState<CityId>("cwm2:city", "paris");
  const [walker, setWalker] = useCanvasState<Record<CityId, Vec2>>("cwm2:walker", {
    paris: defaultPos, newyork: defaultPos, london: defaultPos,
    tokyo: defaultPos, vienna: defaultPos, hongkong: defaultPos,
  });
  const [active, setActive] = useCanvasState<Record<CityId, string | null>>("cwm2:active", {
    paris: null, newyork: null, london: null, tokyo: null, vienna: null, hongkong: null,
  });
  const [conversations, setConversations] = useCanvasState<
    Record<CityId, Record<string, { q: string; a: string }[]>>
  >("cwm2:convo", ZERO_THREAD);
  const [selectedCeleb, setSelectedCeleb] = useCanvasState<Record<CityId, string | null>>(
    "cwm2:selectedCeleb",
    { paris: null, newyork: null, london: null, tokyo: null, vienna: null, hongkong: null }
  );
  const [draft, setDraft] = useCanvasState<string>("cwm2:draft", "");
  const [soundOn, setSoundOn] = useCanvasState<boolean>("cwm2:sound", false);
  const [tourOn, setTourOn] = useCanvasState<boolean>("cwm2:tour", false);
  const [encounter, setEncounter] = useCanvasState<Record<CityId, EncounterSnap | null>>(
    "cwm2:encounter",
    { paris: null, newyork: null, london: null, tokyo: null, vienna: null, hongkong: null },
  );
  const [manualPick, setManualPick] = useCanvasState<Record<CityId, boolean>>(
    "cwm2:manualPick",
    { paris: false, newyork: false, london: false, tokyo: false, vienna: false, hongkong: false },
  );
  const [lastEncounterEvent, setLastEncounterEvent] = useCanvasState<
    Record<CityId, string | null>
  >(
    "cwm2:lastEncounter",
    { paris: null, newyork: null, london: null, tokyo: null, vienna: null, hongkong: null },
  );

  const city = CITIES.find((c) => c.id === cityId)!;
  const activeEvent = city.events.find((e) => e.id === active[cityId]) ?? null;
  const currentCeleb =
    city.celebrities.find((c) => c.id === selectedCeleb[cityId]) ?? null;
  const currentEncounter = encounter[cityId];

  // helpers
  const setWalkerPos = (id: CityId, pos: Vec2) =>
    setWalker((prev) => ({ ...prev, [id]: pos }));
  const setActiveEvent = (id: CityId, eid: string | null) =>
    setActive((prev) => ({ ...prev, [id]: eid }));
  const pushMessage = (id: CityId, celebId: string, q: string, a: string) =>
    setConversations((prev) => {
      const cityThreads = prev[id] ?? {};
      const list = cityThreads[celebId] ?? [];
      return { ...prev, [id]: { ...cityThreads, [celebId]: [...list, { q, a }] } };
    });

  const beginEncounter = (ev: EventPin, force = false) => {
    const celeb = city.celebrities.find((c) => c.id === ev.celebrityId);
    if (!celeb) return;

    cancelIntroTyping();
    const revisit = lastEncounterEvent[cityId] === ev.id;
    const introText = composeIntro(celeb, ev, revisit && !force);
    const pulse = Date.now();

    setSelectedCeleb((prev) => ({ ...prev, [cityId]: ev.celebrityId }));
    setManualPick((prev) => ({ ...prev, [cityId]: false }));
    setLastEncounterEvent((prev) => ({ ...prev, [cityId]: ev.id }));
    setEncounter((prev) => ({
      ...prev,
      [cityId]: {
        eventId: ev.id,
        celebId: ev.celebrityId,
        phase: "pop",
        typedLen: 0,
        introText,
        pulse,
      },
    }));

    window.setTimeout(() => {
      setEncounter((prev) => {
        const cur = prev[cityId];
        if (!cur || cur.eventId !== ev.id) return prev;
        return { ...prev, [cityId]: { ...cur, phase: "typing" } };
      });
      startIntroTyping(
        introText,
        (len) => {
          setEncounter((prev) => {
            const cur = prev[cityId];
            if (!cur || cur.eventId !== ev.id) return prev;
            return { ...prev, [cityId]: { ...cur, typedLen: len } };
          });
        },
        () => {
          setEncounter((prev) => {
            const cur = prev[cityId];
            if (!cur || cur.eventId !== ev.id) return prev;
            return {
              ...prev,
              [cityId]: {
                ...cur,
                phase: "ready",
                typedLen: cur.introText.length,
              },
            };
          });
        },
      );
    }, 680);
  };

  const arriveAtEvent = (ev: EventPin, force = false) => {
    setWalkerPos(cityId, { x: ev.x, y: ev.y });
    setActiveEvent(cityId, ev.id);
    if (active[cityId] !== ev.id || force) {
      beginEncounter(ev, force);
    }
  };

  const moveWalkerTo = (pos: Vec2) => {
    setWalkerPos(cityId, pos);
    const near = nearestEvent(pos, city.events, 50);
    if (near) {
      if (active[cityId] !== near.id) {
        setActiveEvent(cityId, near.id);
        beginEncounter(near);
      } else {
        setActiveEvent(cityId, near.id);
        setSelectedCeleb((prev) => ({ ...prev, [cityId]: near.celebrityId }));
      }
    } else {
      setActiveEvent(cityId, null);
      cancelIntroTyping();
      setEncounter((prev) => ({ ...prev, [cityId]: null }));
      if (!manualPick[cityId]) {
        setSelectedCeleb((prev) => ({ ...prev, [cityId]: null }));
      }
    }
  };

  const handleMapClick = (pos: Vec2) => {
    cancelTour();
    if (tourOn) setTourOn(false);
    moveWalkerTo(pos);
  };

  const handlePinClick = (eid: string) => {
    const ev = city.events.find((e) => e.id === eid);
    if (!ev) return;
    cancelTour();
    if (tourOn) setTourOn(false);
    arriveAtEvent(ev, true);
  };

  const handleDismissEncounter = () => {
    cancelIntroTyping();
    setSelectedCeleb((prev) => ({ ...prev, [cityId]: null }));
    setEncounter((prev) => ({ ...prev, [cityId]: null }));
    setManualPick((prev) => ({ ...prev, [cityId]: false }));
  };

  const handlePickVoice = (id: string) => {
    cancelIntroTyping();
    setManualPick((prev) => ({ ...prev, [cityId]: true }));
    setEncounter((prev) => ({ ...prev, [cityId]: null }));
    setSelectedCeleb((prev) => ({ ...prev, [cityId]: id }));
  };

  const handleKeyDown = (e: {
    key: string;
    shiftKey: boolean;
    target: EventTarget | null;
    preventDefault: () => void;
  }) => {
    // never hijack arrow keys when the chat textarea (or any input) has focus
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "TEXTAREA" ||
        target.tagName === "INPUT" ||
        target.isContentEditable)
    ) {
      return;
    }
    let dx = 0;
    let dy = 0;
    const step = e.shiftKey ? 40 : 16;
    switch (e.key) {
      case "ArrowUp":
      case "w":
      case "W":
        dy = -step;
        break;
      case "ArrowDown":
      case "s":
      case "S":
        dy = step;
        break;
      case "ArrowLeft":
      case "a":
      case "A":
        dx = -step;
        break;
      case "ArrowRight":
      case "d":
      case "D":
        dx = step;
        break;
      case "Escape":
        if (currentCeleb) {
          handleDismissEncounter();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    cancelTour();
    if (tourOn) setTourOn(false);
    const cur = walker[cityId];
    moveWalkerTo({
      x: Math.max(16, Math.min(584, cur.x + dx)),
      y: Math.max(16, Math.min(404, cur.y + dy)),
    });
  };

  const handleCityChange = (id: CityId) => {
    cancelTour();
    cancelIntroTyping();
    setTourOn(false);
    setCityId(id);
    if (soundOn) playCityAmbient(CITIES.find((c) => c.id === id)!.ambient);
  };

  const handleToggleSound = () => {
    if (soundOn) {
      fadeOutAmbient();
      setSoundOn(false);
    } else {
      playCityAmbient(city.ambient);
      setSoundOn(true);
    }
  };

  const handleTour = () => {
    if (tourOn) {
      cancelTour();
      cancelIntroTyping();
      setTourOn(false);
      return;
    }
    setTourOn(true);
    let i = 0;
    const events = city.events;
    const next = () => {
      if (i >= events.length) {
        setTourOn(false);
        __tourTimer = null;
        return;
      }
      const ev = events[i];
      arriveAtEvent(ev, true);
      i++;
      __tourTimer = window.setTimeout(next, 6200);
    };
    next();
  };

  const handleAsk = (q: string, a: string) => {
    const celebId = selectedCeleb[cityId];
    if (!celebId) return;
    pushMessage(cityId, celebId, q, a);
  };

  const currentThread =
    (currentCeleb && conversations[cityId]?.[currentCeleb.id]) || [];

  return (
    <Stack gap={0}>
      <PaintedFilters />
      <EncounterMotionStyles />

      <div
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => {
          // ensure the container gets focus so arrow keys work right away
          const t = e.currentTarget as HTMLElement;
          if (typeof t.focus === "function") t.focus({ preventScroll: true });
        }}
        style={{
          position: "relative",
          width: "100%",
          height: "92vh",
          minHeight: 680,
          background: city.palette.wash,
          overflow: "hidden",
          outline: "none",
        }}
      >
        <MapPlate
          city={city}
          walker={walker[cityId]}
          activeId={active[cityId]}
          encounter={currentEncounter}
          onMapClick={handleMapClick}
          onPinClick={handlePinClick}
        />

        {/* Top floating: city pills */}
        <CityPillBar cityId={cityId} onCity={handleCityChange} palette={city.palette} />

        {/* District plaque — top-left */}
        <DistrictPlaque city={city} />

        {/* Controls cluster — top-right (or slides if chat) */}
        <ControlsCluster
          palette={city.palette}
          soundOn={soundOn}
          onToggleSound={handleToggleSound}
          tourOn={tourOn}
          onTour={handleTour}
          hasChat={!!currentCeleb}
        />

        {/* About panel — top-right, only when nothing else is open there */}
        {!currentCeleb && (
          <div
            style={{
              position: "absolute",
              top: 116,
              right: 16,
              maxWidth: 300,
              padding: "10px 14px",
              background: city.palette.wash,
              border: `1px solid ${city.palette.ink}33`,
              borderRadius: 4,
              color: city.palette.ink,
            }}
          >
            <div
              style={{
                fontFamily: "Georgia, serif",
                fontSize: 11,
                fontStyle: "italic",
                opacity: 0.7,
                marginBottom: 4,
              }}
            >
              about this district
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>{city.about}</div>
          </div>
        )}

        {/* Encounter dialog — slides in when a voice appears */}
        {currentCeleb && (
          <div
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              bottom: 16,
              width: 400,
              background: city.palette.wash,
              border: `2px solid ${city.palette.street}88`,
              borderRadius: 12,
              overflow: "hidden",
              color: city.palette.ink,
            }}
          >
            <EncounterPanel
              city={city}
              celebrity={currentCeleb}
              event={activeEvent}
              encounter={currentEncounter}
              thread={currentThread}
              draft={draft}
              setDraft={setDraft}
              onAsk={handleAsk}
              onDismiss={handleDismissEncounter}
              manualPick={manualPick[cityId]}
            />
          </div>
        )}

        {/* Voices launcher — bottom-right (when no encounter open) */}
        {!currentCeleb && (
          <div
            style={{
              position: "absolute",
              bottom: 16,
              right: 16,
              width: 360,
              padding: 14,
              background: city.palette.wash,
              border: `1px solid ${city.palette.ink}44`,
              borderRadius: 12,
              maxHeight: "60vh",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                fontFamily: "Georgia, serif",
                fontStyle: "italic",
                fontSize: 13,
                color: city.palette.ink,
                opacity: 0.8,
                marginBottom: 10,
              }}
            >
              walk to a pin — someone will find you · or pick a voice
            </div>
            <VoicesGrid city={city} onPick={handlePickVoice} />
          </div>
        )}

        {/* Walking hint — bottom, centered */}
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            display: activeEvent || currentCeleb ? "none" : "flex",
            gap: 14,
            alignItems: "center",
            padding: "6px 14px",
            background: city.palette.wash,
            border: `1px solid ${city.palette.ink}33`,
            borderRadius: 999,
            fontFamily: "Georgia, serif",
            fontStyle: "italic",
            fontSize: 11,
            color: city.palette.ink,
            opacity: 0.9,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          <span>tap to walk · numbered pin to teleport</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <KeyCap palette={city.palette}>←</KeyCap>
            <KeyCap palette={city.palette}>↑</KeyCap>
            <KeyCap palette={city.palette}>↓</KeyCap>
            <KeyCap palette={city.palette}>→</KeyCap>
            <span style={{ marginLeft: 4 }}>step</span>
          </span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <KeyCap palette={city.palette}>⇧</KeyCap>
            <span>+ arrow = big step</span>
          </span>
        </div>
      </div>
    </Stack>
  );
}




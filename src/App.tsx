import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import catIdleUrl from "./assets/cat-idle.png";
import "./App.css";

// ── Canvas constants ──────────────────────────────────────────────────────
const S     = 5;   // still used by wobble offset in updateState
const WIN_W = 200;
const WIN_H = 200;

// ── Sprite constants ───────────────────────────────────────────────────────
const SPRITE_SCALE    = 3;
const SPRITE_FRAME_W  = 32;
const SPRITE_FRAMES   = 10;
const SPRITE_FRAME_MS = 1000 / 6;   // ~6fps frame advance

const CAT_W = SPRITE_FRAME_W * SPRITE_SCALE; // 96
const CAT_H = SPRITE_FRAME_W * SPRITE_SCALE; // 96
const CAT_X = Math.round((WIN_W - CAT_W) / 2); // 52
const CAT_Y = WIN_H - CAT_H - 4;               // 100

// ── Colors ────────────────────────────────────────────────────────────────
const CREAM = "#f2ece0";
const PINK  = "#f09dac";

// ── Timing constants ──────────────────────────────────────────────────────
const WALK_SPEED     = 80;
const ARRIVE_DIST    = 4;
const SLEEP_AFTER    = 120_000;
const MAX_PUPIL      = 3;      // px max pupil offset from eye center
const HUNT_VEL       = 600;    // px/s to start hunt
const HUNT_VEL_DUR   = 300;    // ms sustained velocity before HUNT
const HEAD_FRAC      = 0.4;    // top 40% of cat = head hitbox
const PET_DELAY      = 500;    // ms hover before petting
const PET_EXIT_DELAY = 1000;   // ms after leaving head before exiting PET
const SHAKE_COUNT    = 4;      // direction reversals to trigger dizzy
const SHAKE_WINDOW   = 500;    // ms window for shake detection

// ── Pixel-art glyphs ─────────────────────────────────────────────────────
const Z_GLYPH = [
  [1, 1, 1], [0, 0, 1], [0, 1, 0], [1, 0, 0], [1, 1, 1],
];
const HEART_GLYPH = [
  [0, 1, 0, 1, 0],
  [1, 1, 1, 1, 1],
  [0, 1, 1, 1, 0],
  [0, 0, 1, 0, 0],
];

// ── State type ────────────────────────────────────────────────────────────
type CatState =
  | "IDLE" | "WALKING" | "CURIOUS" | "SLEEPING" | "WAKING_UP"
  | "SITTING" | "TAIL_FLICK" | "GROOMING"
  | "DRAG" | "DRAG_LAND" | "DRAG_DIZZY"
  | "HUNT" | "HUNT_POUNCE"
  | "PET" | "KNEAD" | "PAPER_UNROLL";

interface Heart   { x: number; phase: number; }
interface VSample { x: number; y: number; t: number; }

// ── Mutable per-frame game state ──────────────────────────────────────────
interface GS {
  // core
  state: CatState; stateStart: number; nextEvent: number;
  screenW: number; screenH: number; dpr: number;
  winX: number; winY: number; tgtX: number; tgtY: number; walkDir: number;
  mouseX: number; mouseY: number; lastActivity: number;
  // sprite
  spriteFrame: number; lastFrameTime: number;
  // phase animation
  walkPhase: number; tailPhase: number; zzzPhase: number;
  wakeT: number; groomPhase: number;
  midWalkGroom: boolean; midWalkGroomEnd: number;
  // blinking
  eyesClosed: boolean; nextBlink: number; blinkEnd: number;
  // window sync
  sentX: number; sentY: number;
  // P2 — eye follow
  pupilOffX: number; pupilOffY: number;
  // P2 — drag
  isDragging: boolean;
  dragOffX: number; dragOffY: number;
  dragStretch: number; dragScaleX: number; dragScaleY: number;
  dragPrevX: number; dragPrevY: number;
  shakeHistory: number[]; lastShakeDir: number; lastShakeX: number;
  wobblePhase: number; wobbleOffX: number; dragLandT: number;
  // P2 — hunt
  velHistory: VSample[]; huntingStart: number;
  pounceStartX: number; pounceStartY: number;
  pounceTargetX: number; pounceTargetY: number;
  // P2 — pet
  isOverHead: boolean; headHoverStart: number; petLeaveTime: number;
  hearts: Heart[]; lastHeartSpawn: number;
  tailWagPhase: number;
  purrActive: boolean;
  purrCtx: AudioContext | null;
  purrOsc: OscillatorNode | null;
  purrGain: GainNode | null;
  // Phase 3 — keyboard reactions
  lastKeyPressTime: number;
  kneadPhase: number;
  prevStateBeforeKnead: CatState;
  keyPressTimestamps: number[];
  highWpmStart: number;
  lowWpmStart: number;
  isOverheated: boolean;
  overheatIntensity: number;
  steamPhase: number;
  // Phase 4 — scroll reaction
  lastScrollTime: number;
  scrollLength: number;
  prevStateBeforePaper: CatState;
}

// ── Z-glyph + ZZZ (Phase 1, unchanged) ───────────────────────────────────
function drawZ(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number, alpha: number) {
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.fillStyle = "#999";
  for (let r = 0; r < Z_GLYPH.length; r++)
    for (let c = 0; c < Z_GLYPH[r].length; c++)
      if (Z_GLYPH[r][c]) ctx.fillRect(x + c * sz, y + r * sz, sz, sz);
  ctx.globalAlpha = 1;
}

function drawZzz(ctx: CanvasRenderingContext2D, ox: number, oy: number, phase: number) {
  const specs = [
    { dx: CAT_W * 0.50, dy: -10, sz: 3, maxFloat: 20, p: phase },
    { dx: CAT_W * 0.65, dy: -20, sz: 4, maxFloat: 28, p: (phase + 0.33) % 1 },
    { dx: CAT_W * 0.80, dy: -30, sz: 5, maxFloat: 36, p: (phase + 0.66) % 1 },
  ];
  for (const z of specs) {
    const floatY = z.p * z.maxFloat;
    const alpha  = z.p < 0.15 ? z.p / 0.15 : z.p > 0.65 ? (1 - z.p) / 0.35 : 1;
    drawZ(ctx, ox + z.dx, oy + z.dy - floatY, z.sz, alpha * 0.85);
  }
}

// ── Floating hearts (PET state) ───────────────────────────────────────────
function drawHearts(ctx: CanvasRenderingContext2D, ox: number, oy: number, hearts: Heart[]) {
  ctx.fillStyle = PINK;
  for (const h of hearts) {
    const alpha  = h.phase < 0.2 ? h.phase / 0.2 : 1 - (h.phase - 0.2) / 0.8;
    const floatY = h.phase * 40;
    ctx.globalAlpha = Math.max(0, alpha);
    const px = 2;
    for (let r = 0; r < HEART_GLYPH.length; r++)
      for (let c = 0; c < HEART_GLYPH[r].length; c++)
        if (HEART_GLYPH[r][c])
          ctx.fillRect(ox + h.x + c * px, oy - 15 - floatY + r * px, px, px);
  }
  ctx.globalAlpha = 1;
}

// ── Steam puffs (OVERHEAT visual) ─────────────────────────────────────────
function drawSteam(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  phase: number, intensity: number,
) {
  ctx.fillStyle = "#d0d0d0";
  for (let i = 0; i < 3; i++) {
    const p     = (phase + i / 3) % 1;
    const alpha = p < 0.2 ? p / 0.2 : p > 0.7 ? (1 - p) / 0.3 : 1;
    const riseY = p * 30;
    const r     = 3 + p * 2;
    ctx.globalAlpha = Math.max(0, alpha * intensity * 0.85);
    ctx.beginPath();
    ctx.arc(ox + CAT_W * (0.30 + i * 0.20), oy - 8 - riseY, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ── Paper scroll (PAPER_UNROLL state) ────────────────────────────────────
function drawPaperScroll(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  scrollLength: number,
) {
  const pw   = 12;                                   // paper width px
  const px   = ox + Math.round((CAT_W - pw) / 2);   // horizontally centered on cat
  const py   = oy + Math.round(CAT_H * 0.72);        // near paw area
  const cylH = 8;                                    // rolled cylinder height

  // Unrolled paper body (drawn first, behind cylinder)
  if (scrollLength > 0) {
    const paperH = Math.round(scrollLength);
    const bodyY  = py + cylH;

    ctx.fillStyle = "#f8f5ef";
    ctx.fillRect(px + 1, bodyY, pw - 2, paperH);

    ctx.fillStyle = "#c0b8a8";
    ctx.fillRect(px, bodyY, 1, paperH);
    ctx.fillRect(px + pw - 1, bodyY, 1, paperH);

    ctx.fillStyle = "#e0dbd0";
    for (let lineY = bodyY + 3; lineY < bodyY + paperH - 1; lineY += 4) {
      ctx.fillRect(px + 1, lineY, pw - 2, 1);
    }

    ctx.fillStyle = "#c0b8a8";
    ctx.fillRect(px + 1, bodyY + paperH, pw - 2, 1);
  }

  // Rolled cylinder (drawn on top)
  ctx.fillStyle = "#7a5c28";
  ctx.fillRect(px, py, pw, 2);
  ctx.fillRect(px, py + cylH - 2, pw, 2);

  ctx.fillStyle = "#f2ece0";
  ctx.fillRect(px, py + 2, pw, cylH - 4);

  ctx.fillStyle = "#faf8f2";
  ctx.fillRect(px + 2, py + 2, 2, cylH - 4);

  ctx.fillStyle = "#d8d0c0";
  ctx.fillRect(px + pw - 3, py + 2, 1, cylH - 4);
}

// ── Purr audio (Web Audio API) ────────────────────────────────────────────
function startPurr(gs: GS) {
  if (gs.purrActive) return;
  try {
    const actx = new AudioContext();
    const osc  = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(25, actx.currentTime);
    gain.gain.setValueAtTime(0, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, actx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(actx.destination);
    osc.start();
    gs.purrCtx = actx; gs.purrOsc = osc; gs.purrGain = gain;
    gs.purrActive = true;
  } catch {}
}

function stopPurr(gs: GS) {
  if (!gs.purrActive || !gs.purrCtx || !gs.purrGain || !gs.purrOsc) return;
  const { purrGain: gain, purrCtx: actx, purrOsc: osc } = gs;
  try {
    gain.gain.setValueAtTime(gain.gain.value, actx.currentTime);
    gain.gain.linearRampToValueAtTime(0, actx.currentTime + 0.3);
  } catch {}
  setTimeout(() => { try { osc.stop(); } catch {} try { actx.close(); } catch {} }, 350);
  gs.purrActive = false; gs.purrCtx = null; gs.purrOsc = null; gs.purrGain = null;
}

// ── WPM from rolling keypress timestamp buffer ────────────────────────────
function calculateWPM(gs: GS, now: number): number {
  gs.keyPressTimestamps = gs.keyPressTimestamps.filter(t => now - t <= 10_000);
  const n = gs.keyPressTimestamps.length;
  if (n < 5) return 0;
  const elapsed = (now - gs.keyPressTimestamps[0]) / 1000;
  if (elapsed < 1) return 0;
  return (n / 5) / elapsed * 60;
}

// ── Mouse speed (logical CSS px/s) from recent velHistory samples ─────────
function cursorSpeed(gs: GS): number {
  const h = gs.velHistory;
  if (h.length < 2) return 0;
  const dt = h[h.length - 1].t - h[0].t;
  if (dt < 30) return 0;
  return Math.hypot(h[h.length - 1].x - h[0].x, h[h.length - 1].y - h[0].y) / dt * 1000;
}

// ── Head hitbox check (top 40% of cat in screen coords) ──────────────────
function checkOverHead(gs: GS): boolean {
  return (
    gs.mouseX >= gs.winX + CAT_X &&
    gs.mouseX <= gs.winX + CAT_X + CAT_W &&
    gs.mouseY >= gs.winY + CAT_Y &&
    gs.mouseY <= gs.winY + CAT_Y + CAT_H * HEAD_FRAC
  );
}

// ── Shared mouse-position update (called from both event sources) ─────────
function onCursorUpdate(gs: GS, lx: number, ly: number, now: number) {
  gs.mouseX = lx;
  gs.mouseY = ly;
  gs.lastActivity = now;

  const wasOver = gs.isOverHead;
  gs.isOverHead = checkOverHead(gs);
  if (gs.isOverHead && !wasOver) {
    gs.headHoverStart = now;
  } else if (!gs.isOverHead && wasOver && gs.state !== "PET") {
    gs.headHoverStart = 0;
  }

  gs.velHistory.push({ x: lx, y: ly, t: now });
  while (gs.velHistory.length > 0 && now - gs.velHistory[0].t > 600) gs.velHistory.shift();
}

// ── Core cat drawing — sprite sheet ───────────────────────────────────────
function drawCat(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  gs: GS, _now: number,
  sprite: HTMLImageElement,
) {
  const fw = SPRITE_FRAME_W;
  const dw = fw * SPRITE_SCALE;
  const dh = fw * SPRITE_SCALE;

  ctx.imageSmoothingEnabled = false;
  if (sprite.complete && sprite.naturalWidth > 0) {
    ctx.drawImage(sprite, gs.spriteFrame * fw, 0, fw, fw, ox, oy, dw, dh);
  } else {
    // fallback while sprite loads
    ctx.fillStyle = CREAM;
    ctx.fillRect(ox, oy, dw, dh);
  }

  // ── ZZZ overlay ───────────────────────────────────────────────────────
  if (gs.state === "SLEEPING") drawZzz(ctx, ox, oy, gs.zzzPhase);

  // ── Hearts overlay ────────────────────────────────────────────────────
  if (gs.state === "PET" && gs.hearts.length > 0) drawHearts(ctx, ox, oy, gs.hearts);
}

// ── Schedule next idle personality event ─────────────────────────────────
function scheduleIdle(gs: GS, now: number) {
  gs.nextEvent = now + 8_000 + Math.random() * 14_000;
}

// ── Pick a random walk destination ────────────────────────────────────────
function pickDest(gs: GS): { x: number; y: number } {
  const pad = 15;
  const minX = pad, maxX = gs.screenW - WIN_W - pad;
  const minY = 30,  maxY = gs.screenH - WIN_H - 70;
  const roll = Math.random();
  if (roll < 0.35) return { x: maxX, y: maxY };
  if (roll < 0.55 && gs.mouseX > 0) {
    return {
      x: Math.max(minX, Math.min(maxX, gs.mouseX - CAT_X - CAT_W / 2 + (Math.random() - 0.5) * 200)),
      y: Math.max(minY, Math.min(maxY, gs.mouseY - CAT_Y - CAT_H / 2 + (Math.random() - 0.5) * 200)),
    };
  }
  return { x: minX + Math.random() * (maxX - minX), y: minY + Math.random() * (maxY - minY) };
}

// ── State transition ──────────────────────────────────────────────────────
function transition(gs: GS, next: CatState, now: number) {
  gs.state      = next;
  gs.stateStart = now;

  switch (next) {
    case "IDLE":
    case "SITTING":
      scheduleIdle(gs, now);
      gs.eyesClosed   = false;
      gs.midWalkGroom = false;
      break;
    case "WALKING": {
      const d = pickDest(gs);
      gs.tgtX = d.x; gs.tgtY = d.y;
      gs.walkPhase = 0;
      gs.walkDir   = d.x >= gs.winX ? 1 : -1;
      break;
    }
    case "TAIL_FLICK": gs.tailPhase  = 0; break;
    case "GROOMING":   gs.groomPhase = 0; break;
    case "WAKING_UP":  gs.wakeT = 0; gs.eyesClosed = true; break;
    case "SLEEPING":   gs.zzzPhase = 0; break;
    case "CURIOUS":    break;
    case "DRAG":
      gs.dragPrevX    = gs.mouseX;
      gs.dragPrevY    = gs.mouseY;
      gs.shakeHistory = [];
      gs.lastShakeDir = 0;
      gs.lastShakeX   = gs.mouseX;
      gs.dragStretch  = 0;
      gs.dragScaleX   = 1;
      gs.dragScaleY   = 1;
      break;
    case "DRAG_LAND":
      gs.dragLandT  = 0;
      gs.isDragging = false;
      gs.dragScaleX = 1;
      gs.dragScaleY = 1;
      break;
    case "DRAG_DIZZY":
      gs.wobblePhase = 0;
      gs.wobbleOffX  = 0;
      gs.isDragging  = false;
      gs.dragScaleX  = 1;
      gs.dragScaleY  = 1;
      break;
    case "HUNT":
      gs.huntingStart = 0;
      gs.walkPhase    = 0;
      gs.walkDir      = gs.mouseX > gs.winX + CAT_X + CAT_W / 2 ? 1 : -1;
      break;
    case "HUNT_POUNCE": {
      gs.pounceStartX  = gs.winX;
      gs.pounceStartY  = gs.winY;
      const dx   = gs.mouseX - (gs.winX + CAT_X + CAT_W / 2);
      const dy   = gs.mouseY - (gs.winY + CAT_Y + CAT_H / 2);
      const dist = Math.hypot(dx, dy) || 1;
      const lunge = Math.min(50, dist * 0.3);
      gs.pounceTargetX = gs.winX + (dx / dist) * lunge;
      gs.pounceTargetY = gs.winY + (dy / dist) * lunge;
      break;
    }
    case "PET":
      gs.tailWagPhase  = 0;
      gs.hearts        = [];
      gs.lastHeartSpawn = 0;
      gs.petLeaveTime  = 0;
      startPurr(gs);
      break;
    case "KNEAD":
      gs.kneadPhase = 0;
      break;
    case "PAPER_UNROLL":
      break;
  }
}

// ── Per-frame state machine — priority: DRAG > PET > HUNT > Phase1 ────────
function updateState(gs: GS, now: number, dt: number) {

  // ── DRAG (highest priority) ───────────────────────────────────────────
  if (gs.isDragging) {
    if (gs.state !== "DRAG") transition(gs, "DRAG", now);
    gs.winX = gs.mouseX - gs.dragOffX;
    gs.winY = gs.mouseY - gs.dragOffY;
    const ddx = gs.mouseX - gs.dragPrevX;
    const ddy = gs.mouseY - gs.dragPrevY;
    const spd = dt > 0 ? Math.hypot(ddx, ddy) / dt * 1000 : 0;
    const tgt = Math.min(spd / 2000, 0.4);
    gs.dragStretch = gs.dragStretch * 0.85 + tgt * 0.15;
    gs.dragScaleX  = 1 - gs.dragStretch * 0.5;
    gs.dragScaleY  = 1 + gs.dragStretch;
    gs.dragPrevX   = gs.mouseX;
    gs.dragPrevY   = gs.mouseY;
    return;
  }

  // ── Terminal drag / pounce states (no interruption) ──────────────────
  if (gs.state === "DRAG_LAND") {
    const e = now - gs.stateStart;
    gs.dragLandT  = Math.min(e / 350, 1);
    const squish  = Math.sin(gs.dragLandT * Math.PI);
    gs.dragScaleX = 1 + squish * 0.35;
    gs.dragScaleY = 1 - squish * 0.25;
    if (e >= 350) { gs.dragScaleX = 1; gs.dragScaleY = 1; transition(gs, "IDLE", now); }
    return;
  }
  if (gs.state === "DRAG_DIZZY") {
    gs.wobblePhase = (gs.wobblePhase + dt / 300) % 1;
    gs.wobbleOffX  = Math.sin(gs.wobblePhase * Math.PI * 2) * S * 1.5;
    if (now - gs.stateStart >= 2000) { gs.wobbleOffX = 0; transition(gs, "IDLE", now); }
    return;
  }
  if (gs.state === "HUNT_POUNCE") {
    const e    = now - gs.stateStart;
    const t    = Math.min(e / 500, 1);
    const ease = t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6;
    gs.winX = gs.pounceStartX + (gs.pounceTargetX - gs.pounceStartX) * ease;
    gs.winY = gs.pounceStartY + (gs.pounceTargetY - gs.pounceStartY) * ease;
    if (e >= 500) transition(gs, "IDLE", now);
    return;
  }

  // ── PET check (priority 2) — not during sleep / drag terminal states ──
  const awake = gs.state !== "SLEEPING" && gs.state !== "WAKING_UP";
  if (awake && gs.isOverHead && gs.headHoverStart > 0 &&
      now - gs.headHoverStart >= PET_DELAY && gs.state !== "PET") {
    transition(gs, "PET", now);
  }

  if (gs.state === "PET") {
    if (!gs.isOverHead) {
      if (gs.petLeaveTime === 0) gs.petLeaveTime = now;
      if (now - gs.petLeaveTime >= PET_EXIT_DELAY) {
        stopPurr(gs);
        gs.petLeaveTime   = 0;
        gs.headHoverStart = 0;
        transition(gs, "IDLE", now);
        return;
      }
    } else {
      gs.petLeaveTime = 0;
    }
    // Purr frequency wobble 23–27 Hz
    if (gs.purrOsc && gs.purrCtx) {
      try { gs.purrOsc.frequency.setValueAtTime(25 + Math.sin(now / 500) * 2, gs.purrCtx.currentTime); } catch {}
    }
    gs.tailWagPhase = (gs.tailWagPhase + dt / 150) % 1;
    // Spawn hearts ~every 800ms
    if (now - gs.lastHeartSpawn > 800) {
      gs.hearts.push({ x: CAT_W * (0.15 + Math.random() * 0.7), phase: 0 });
      gs.lastHeartSpawn = now;
    }
    for (const h of gs.hearts) h.phase += dt / 2000;
    gs.hearts = gs.hearts.filter(h => h.phase < 1);
    return;
  }

  // ── HUNT check (priority 3) ───────────────────────────────────────────
  const huntOk = !["SLEEPING","WAKING_UP","PET","DRAG","DRAG_LAND","DRAG_DIZZY","HUNT","HUNT_POUNCE"].includes(gs.state);
  const speed  = cursorSpeed(gs);
  if (huntOk && speed > HUNT_VEL) {
    if (gs.huntingStart === 0) gs.huntingStart = now;
    else if (now - gs.huntingStart >= HUNT_VEL_DUR) {
      gs.huntingStart = 0;
      transition(gs, "HUNT", now);
      return;
    }
  } else if (speed < HUNT_VEL * 0.5) {
    gs.huntingStart = 0;
  }

  if (gs.state === "HUNT") {
    const tgtX = gs.mouseX - CAT_X - CAT_W / 2;
    const tgtY = gs.mouseY - CAT_Y - CAT_H / 2;
    const dx   = tgtX - gs.winX;
    const dy   = tgtY - gs.winY;
    const dist = Math.hypot(dx, dy);
    gs.walkDir   = dx > 0 ? 1 : -1;
    gs.walkPhase = (gs.walkPhase + dt / 800) % 1;
    if (dist > 15) {
      const step = 30 * dt / 1000;
      gs.winX += (dx / dist) * step;
      gs.winY += (dy / dist) * step;
    }
    if (speed < 100)                        { transition(gs, "HUNT_POUNCE", now); return; }
    if (now - gs.stateStart >= 4000)        { transition(gs, "IDLE", now); }
    return;
  }

  // ── KNEAD check (priority 4) — system-wide keypress detection ─────────
  const kneadActive  = gs.lastKeyPressTime > 0 && now - gs.lastKeyPressTime < 1000;
  const kneadBlocked = ["DRAG","DRAG_LAND","DRAG_DIZZY","PET","HUNT","HUNT_POUNCE",
                         "SLEEPING","WAKING_UP"].includes(gs.state);
  if (!kneadBlocked && kneadActive && gs.state !== "KNEAD") {
    gs.prevStateBeforeKnead = gs.state;
    transition(gs, "KNEAD", now);
  }
  if (gs.state === "KNEAD") {
    if (!kneadActive) { transition(gs, gs.prevStateBeforeKnead, now); }
    else              { gs.kneadPhase = (gs.kneadPhase + dt / 250) % 1; }
  }

  // ── OVERHEAT tracking (visual modifier, independent of state machine) ──
  const wpm = calculateWPM(gs, now);
  if (wpm > 80) {
    if (gs.highWpmStart === 0) gs.highWpmStart = now;
    gs.lowWpmStart = 0;
    if (!gs.isOverheated && now - gs.highWpmStart >= 5000) gs.isOverheated = true;
  } else {
    gs.highWpmStart = 0;
    if (wpm < 40 && gs.isOverheated) {
      if (gs.lowWpmStart === 0) gs.lowWpmStart = now;
      if (now - gs.lowWpmStart >= 3000) { gs.isOverheated = false; gs.lowWpmStart = 0; }
    } else {
      gs.lowWpmStart = 0;
    }
  }
  if (gs.isOverheated) {
    gs.overheatIntensity = Math.min(1, gs.overheatIntensity + dt / 500);
    gs.steamPhase = (gs.steamPhase + dt / 800) % 1;
  } else {
    gs.overheatIntensity = Math.max(0, gs.overheatIntensity - dt / 500);
    if (gs.overheatIntensity > 0) gs.steamPhase = (gs.steamPhase + dt / 800) % 1;
  }

  if (gs.state === "KNEAD") return;

  // ── PAPER_UNROLL check (priority 5) ──────────────────────────────────
  const scrollActive  = gs.lastScrollTime > 0 && now - gs.lastScrollTime < 1500;
  const paperBlocked  = ["DRAG","DRAG_LAND","DRAG_DIZZY","PET","HUNT","HUNT_POUNCE",
                         "KNEAD","SLEEPING","WAKING_UP"].includes(gs.state);
  if (!paperBlocked && scrollActive && gs.state !== "PAPER_UNROLL") {
    gs.prevStateBeforePaper = gs.state;
    transition(gs, "PAPER_UNROLL", now);
  }
  if (gs.state === "PAPER_UNROLL") {
    if (!scrollActive) {
      gs.scrollLength = Math.max(0, gs.scrollLength - dt * 30 / 1000);
      if (gs.scrollLength <= 0) {
        gs.scrollLength = 0;
        transition(gs, gs.prevStateBeforePaper, now);
      }
    }
    return;
  }

  // ── Phase 1 state machine ─────────────────────────────────────────────
  switch (gs.state) {
    case "IDLE":
    case "SITTING": {
      if (now - gs.lastActivity > SLEEP_AFTER) { transition(gs, "SLEEPING", now); return; }
      if (now >= gs.nextEvent) {
        const r = Math.random();
        if      (r < 0.30) transition(gs, "WALKING",    now);
        else if (r < 0.45) transition(gs, "CURIOUS",    now);
        else if (r < 0.60) transition(gs, "SITTING",    now);
        else if (r < 0.78) transition(gs, "TAIL_FLICK", now);
        else                transition(gs, "GROOMING",   now);
      }
      break;
    }
    case "WALKING": {
      const dx = gs.tgtX - gs.winX, dy = gs.tgtY - gs.winY;
      const dist = Math.hypot(dx, dy);
      if (dist <= ARRIVE_DIST) { gs.winX = gs.tgtX; gs.winY = gs.tgtY; transition(gs, "IDLE", now); break; }
      gs.walkDir = dx > 0 ? 1 : -1;
      if (gs.midWalkGroom) { if (now >= gs.midWalkGroomEnd) gs.midWalkGroom = false; break; }
      if (Math.random() < 0.0005) { gs.midWalkGroom = true; gs.midWalkGroomEnd = now + 1200 + Math.random() * 1000; break; }
      const step = Math.min(WALK_SPEED * dt / 1000, dist);
      gs.winX += (dx / dist) * step; gs.winY += (dy / dist) * step;
      gs.walkPhase = (gs.walkPhase + dt / 500) % 1;
      break;
    }
    case "CURIOUS": if (now - gs.stateStart >= 3000) transition(gs, "IDLE", now); break;
    case "SLEEPING":
      gs.zzzPhase = (gs.zzzPhase + dt / 3000) % 1;
      if (gs.lastActivity > gs.stateStart && now - gs.lastActivity < 1000) transition(gs, "WAKING_UP", now);
      break;
    case "WAKING_UP": {
      const e = now - gs.stateStart;
      gs.wakeT = Math.min(e / 2000, 1);
      if (e >= 2000) transition(gs, "IDLE", now);
      break;
    }
    case "TAIL_FLICK": {
      const e = now - gs.stateStart;
      gs.tailPhase = e / 800;
      if (e >= 800) transition(gs, "IDLE", now);
      break;
    }
    case "GROOMING": {
      const e = now - gs.stateStart;
      gs.groomPhase = Math.min(e / 1800, 1);
      if (e >= 1800) transition(gs, "IDLE", now);
      break;
    }
  }
}

// ── Main React component ──────────────────────────────────────────────────
export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);
  const gsRef     = useRef<GS | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const spriteImg = new Image();
    spriteImg.src = catIdleUrl;

    const dpr = window.devicePixelRatio || 1;
    const SW  = window.screen.width;
    const SH  = window.screen.height;

    canvas.width        = WIN_W * dpr;
    canvas.height       = WIN_H * dpr;
    canvas.style.width  = `${WIN_W}px`;
    canvas.style.height = `${WIN_H}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.scale(dpr, dpr);

    const now0  = performance.now();
    const initX = SW - WIN_W - 20;
    const initY = SH - WIN_H - 80;

    const gs: GS = {
      state: "IDLE", stateStart: now0,
      nextEvent: now0 + 5000 + Math.random() * 5000,
      screenW: SW, screenH: SH, dpr,
      winX: initX, winY: initY, tgtX: initX, tgtY: initY, walkDir: -1,
      mouseX: 0, mouseY: 0, lastActivity: now0,
      spriteFrame: 0, lastFrameTime: now0,
      walkPhase: 0, tailPhase: 0, zzzPhase: 0, wakeT: 0, groomPhase: 0,
      midWalkGroom: false, midWalkGroomEnd: 0,
      eyesClosed: false, nextBlink: now0 + 3000 + Math.random() * 3000, blinkEnd: 0,
      sentX: initX, sentY: initY,
      // Phase 2
      pupilOffX: 0, pupilOffY: 0,
      isDragging: false, dragOffX: 0, dragOffY: 0,
      dragStretch: 0, dragScaleX: 1, dragScaleY: 1,
      dragPrevX: 0, dragPrevY: 0,
      shakeHistory: [], lastShakeDir: 0, lastShakeX: 0,
      wobblePhase: 0, wobbleOffX: 0, dragLandT: 0,
      velHistory: [], huntingStart: 0,
      pounceStartX: 0, pounceStartY: 0, pounceTargetX: 0, pounceTargetY: 0,
      isOverHead: false, headHoverStart: 0, petLeaveTime: 0,
      hearts: [], lastHeartSpawn: 0, tailWagPhase: 0,
      purrActive: false, purrCtx: null, purrOsc: null, purrGain: null,
      // Phase 3
      lastKeyPressTime: 0, kneadPhase: 0, prevStateBeforeKnead: "IDLE",
      keyPressTimestamps: [], highWpmStart: 0, lowWpmStart: 0,
      isOverheated: false, overheatIntensity: 0, steamPhase: 0,
      // Phase 4
      lastScrollTime: 0, scrollLength: 0, prevStateBeforePaper: "IDLE",
    };
    gsRef.current = gs;

    invoke("update_hitbox", {
      x: Math.round(CAT_X * dpr), y: Math.round(CAT_Y * dpr),
      w: Math.round(CAT_W * dpr), h: Math.round(CAT_H * dpr),
    }).catch(() => {});

    // ── Tauri key event (global — fires even when Oreo window is unfocused) ─
    let unlistenKeyboard: (() => void) | undefined;
    listen<void>("key-pressed", () => {
      const g = gsRef.current;
      if (!g) return;
      const now = performance.now();
      g.lastKeyPressTime = now;
      g.keyPressTimestamps.push(now);
      g.lastActivity = now;
      if (g.state === "SLEEPING") transition(g, "WAKING_UP", now);
    }).then(fn => { unlistenKeyboard = fn; }).catch(() => {});

    // ── Tauri scroll event (global — throttled to 50ms in Rust) ──────────
    let unlistenScroll: (() => void) | undefined;
    listen<number>("scroll-wheel", (ev) => {
      const g = gsRef.current;
      if (!g) return;
      const now = performance.now();
      g.lastScrollTime = now;
      g.lastActivity   = now;
      g.scrollLength   = Math.min(40, g.scrollLength + Math.min(ev.payload, 30) * 0.2 + 4);
      if (g.state === "SLEEPING") transition(g, "WAKING_UP", now);
    }).then(fn => { unlistenScroll = fn; }).catch(() => {});

    // ── Tauri cursor event (global tracking, physical px → logical) ───────
    let unlistenCursor: (() => void) | undefined;
    listen<{ x: number; y: number }>("cursor-moved", (ev) => {
      const g = gsRef.current;
      if (!g) return;
      const now = performance.now();
      onCursorUpdate(g, ev.payload.x / g.dpr, ev.payload.y / g.dpr, now);
      if (g.state === "SLEEPING") transition(g, "WAKING_UP", now);
    }).then(fn => { unlistenCursor = fn; }).catch(() => {});

    // ── DOM events ────────────────────────────────────────────────────────
    function onMouseMove(e: MouseEvent) {
      const g = gsRef.current;
      if (!g) return;
      const now = performance.now();
      onCursorUpdate(g, e.screenX, e.screenY, now);
      if (g.state === "SLEEPING") transition(g, "WAKING_UP", now);

      // Shake detection during drag
      if (g.isDragging && g.state === "DRAG") {
        const dx = e.screenX - g.lastShakeX;
        if (Math.abs(dx) > 8) {
          const dir = dx > 0 ? 1 : -1;
          if (g.lastShakeDir !== 0 && dir !== g.lastShakeDir) {
            g.shakeHistory.push(now);
            g.shakeHistory = g.shakeHistory.filter(t => now - t < SHAKE_WINDOW);
            if (g.shakeHistory.length >= SHAKE_COUNT) {
              g.isDragging = false;
              invoke("set_drag_mode", { active: false }).catch(() => {});
              transition(g, "DRAG_DIZZY", now);
              g.shakeHistory = [];
              return;
            }
          }
          g.lastShakeDir = dir;
          g.lastShakeX   = e.screenX;
        }
      }
    }

    function onMouseDown(e: MouseEvent) {
      const g = gsRef.current;
      if (!g || g.state === "SLEEPING" || g.state === "WAKING_UP") return;
      // Only start drag if click lands on the cat bounding box
      const relX = e.screenX - g.winX;
      const relY = e.screenY - g.winY;
      if (relX < CAT_X || relX > CAT_X + CAT_W || relY < CAT_Y || relY > CAT_Y + CAT_H) return;
      if (g.state === "PET") stopPurr(g);
      g.isDragging   = true;
      g.dragOffX     = e.screenX - g.winX;
      g.dragOffY     = e.screenY - g.winY;
      g.dragPrevX    = e.screenX;
      g.dragPrevY    = e.screenY;
      g.lastShakeX   = e.screenX;
      g.lastShakeDir = 0;
      g.shakeHistory = [];
      g.walkDir      = 1;
      invoke("set_drag_mode", { active: true }).catch(() => {});
    }

    function onMouseUp() {
      const g = gsRef.current;
      if (!g || !g.isDragging) return;
      g.isDragging = false;
      invoke("set_drag_mode", { active: false }).catch(() => {});
      transition(g, "DRAG_LAND", performance.now());
    }

    function onKeyDown() {
      const g = gsRef.current;
      if (!g) return;
      const now = performance.now();
      g.lastActivity     = now;
      g.lastKeyPressTime = now;
      if (g.state === "SLEEPING") transition(g, "WAKING_UP", now);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup",   onMouseUp);
    document.addEventListener("keydown",   onKeyDown);

    // ── Animation loop ────────────────────────────────────────────────────
    let lastMs = 0;

    function tick(now: number) {
      const dt = lastMs === 0 ? 16 : Math.min(now - lastMs, 100);
      lastMs   = now;
      const g  = gsRef.current!;

      // ── Eye follow: lerp pupils toward cursor ───────────────────────
      const canFollow = !g.eyesClosed && !g.isDragging
        && g.state !== "SLEEPING" && g.state !== "WAKING_UP"
        && g.state !== "PET" && g.state !== "DRAG_DIZZY"
        && g.mouseX > 0;
      if (canFollow) {
        const eyeScreenX = g.winX + CAT_X + 4.5 * S;
        const eyeScreenY = g.winY + CAT_Y + 6.5 * S;
        const angle = Math.atan2(g.mouseY - eyeScreenY, g.mouseX - eyeScreenX);
        g.pupilOffX += (Math.cos(angle) * MAX_PUPIL - g.pupilOffX) * 0.15;
        g.pupilOffY += (Math.sin(angle) * MAX_PUPIL - g.pupilOffY) * 0.15;
      } else {
        g.pupilOffX *= 0.9;
        g.pupilOffY *= 0.9;
      }

      // ── Blinking ─────────────────────────────────────────────────────
      if (g.state !== "SLEEPING" && g.state !== "WAKING_UP" && !g.isDragging) {
        if (!g.eyesClosed && now >= g.nextBlink) { g.eyesClosed = true; g.blinkEnd = now + 120; }
        if (g.eyesClosed  && now >= g.blinkEnd)  { g.eyesClosed = false; g.nextBlink = now + 3000 + Math.random() * 3000; }
      }

      // ── State machine ─────────────────────────────────────────────────
      updateState(g, now, dt);

      // ── Clamp window (skip while actively dragging) ───────────────────
      if (!g.isDragging) {
        g.winX = Math.max(0, Math.min(g.screenW - WIN_W, g.winX));
        g.winY = Math.max(0, Math.min(g.screenH - WIN_H, g.winY));
      }

      // ── IPC: move window ──────────────────────────────────────────────
      const nx = Math.round(g.winX), ny = Math.round(g.winY);
      if (nx !== g.sentX || ny !== g.sentY) {
        g.sentX = nx; g.sentY = ny;
        invoke("set_window_position", { x: nx, y: ny }).catch(() => {});
      }

      // ── Sprite frame advance (~6fps) ─────────────────────────────────
      if (now - g.lastFrameTime >= SPRITE_FRAME_MS) {
        g.spriteFrame    = (g.spriteFrame + 1) % SPRITE_FRAMES;
        g.lastFrameTime  = now;
      }

      // ── Draw ──────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, WIN_W, WIN_H);

      const hasScale  = g.dragScaleX !== 1 || g.dragScaleY !== 1;
      const hasWobble = g.wobbleOffX !== 0;
      const hasKnead  = g.state === "KNEAD";
      const needsXform = hasScale || hasWobble || hasKnead;
      if (needsXform) {
        ctx.save();
        if (hasScale) {
          const cx = CAT_X + CAT_W / 2;
          const cy = CAT_Y + CAT_H;
          ctx.translate(cx, cy);
          ctx.scale(g.dragScaleX, g.dragScaleY);
          ctx.translate(-cx, -cy);
        }
        if (hasWobble) ctx.translate(g.wobbleOffX, 0);
        if (hasKnead) {
          // Rock the whole sprite around the bottom-center (feet stay fixed)
          const tilt = Math.sin(g.kneadPhase * Math.PI * 2) * 0.06;
          const cx   = CAT_X + CAT_W / 2;
          const cy   = CAT_Y + CAT_H;
          ctx.translate(cx, cy);
          ctx.transform(1, 0, tilt, 1, 0, 0); // skewX
          ctx.translate(-cx, -cy);
        }
      }

      drawCat(ctx, CAT_X, CAT_Y, g, now, spriteImg);

      if (needsXform) ctx.restore();

      // ── Paper scroll (drawn in front of cat, after transform restore) ──
      if (g.state === "PAPER_UNROLL") {
        drawPaperScroll(ctx, CAT_X, CAT_Y, g.scrollLength);
      }

      // ── Overheat overlay (drawn after transforms are restored) ─────────
      if (g.overheatIntensity > 0) {
        // Red/pink tint — source-atop tints only where cat pixels exist
        ctx.save();
        ctx.globalCompositeOperation = "source-atop";
        ctx.globalAlpha = 0.38 * g.overheatIntensity;
        ctx.fillStyle   = "#ff5050";
        ctx.fillRect(0, 0, WIN_W, WIN_H);
        ctx.restore();
        // Steam puffs above head (drawn in normal source-over, no tinting)
        drawSteam(ctx, CAT_X, CAT_Y, g.steamPhase, g.overheatIntensity);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      unlistenScroll?.();
      unlistenCursor?.();
      unlistenKeyboard?.();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup",   onMouseUp);
      document.removeEventListener("keydown",   onKeyDown);
      const g = gsRef.current;
      if (g) stopPurr(g);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", top: 0, left: 0 }}
    />
  );
}

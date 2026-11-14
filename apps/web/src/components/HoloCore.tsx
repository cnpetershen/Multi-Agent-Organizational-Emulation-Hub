import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { NetworkTone } from '../network';

/**
 * The 3D holographic core — a decorative visualization that is also a pointer shortcut.
 *
 * Three layers fail independently and cheaply:
 *
 * - **CSS 3D** `transform-style: preserve-3d` rings: a wireframe globe (meridians + latitudes),
 *   three orbital rings on different axes, a radar sweep plane and a projector base. Real
 *   perspective, no WebGL context, no dependency.
 * - **A 2D canvas** of depth-projected dust and agent beacons. The projection is the whole trick:
 *   points live on a sphere, rotate around Y, and are divided by `1 + z` before drawing. The agent
 *   beads orbit on a tilted circle, so a seat moves behind the core (smaller, dimmer) and in front
 *   of it (larger, brighter) — the depth cue is position, not decoration.
 * - **A light beam** from the projector base to the nucleus.
 *
 * The core is hover-to-pause: while the pointer is inside it, time stops for the CSS animations and
 * for the canvas clock, so a moving beacon can be clicked. A beacon is a transparent DOM button
 * drawn over the canvas; it only calls the page's existing `select(agentId)` path. The component
 * stays `aria-hidden` — keyboard and screen-reader users use the real Agent cards on the left, and
 * the same facts remain readable in the deck and inspector.
 *
 * Both the canvas and the CSS animations honour `prefers-reduced-motion`: the orbit settles and the
 * dust draws one static frame.
 */

export interface HoloAgent {
  readonly id: string;
  readonly name: string;
  readonly tone: NetworkTone;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join('');
}

const MERIDIANS = [0, 30, 60, 90, 120, 150] as const;

/** Horizontal circles of a unit sphere: `--lat-d` is the ring diameter, `--lat-y` its height. */
const LATITUDES = [
  { d: '78%', y: '-32%' },
  { d: '100%', y: '0%' },
  { d: '78%', y: '32%' },
] as const;

const TONE_COLOR: Record<NetworkTone, readonly [number, number, number]> = {
  ok: [105, 192, 146],
  info: [103, 212, 232],
  warn: [233, 173, 97],
  bad: [224, 122, 122],
  neutral: [154, 168, 181],
};

interface Particle {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly size: number;
  readonly cool: boolean;
}

interface Beacon {
  /** Index in the rendered beacon list, so the matching DOM hit target can follow it. */
  readonly index: number;
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly scale: number;
  readonly dot: number;
  readonly tone: NetworkTone;
  readonly initials: string;
}

export function HoloCore({
  agents,
  label,
  className = '',
  motion = true,
  selectedId = null,
  onSelectAgent,
  onClearSelection,
}: {
  readonly agents: readonly HoloAgent[];
  /** The company mark drawn in the nucleus. */
  readonly label: string;
  readonly className?: string;
  /** `false` draws the particle volume once and stops the loop (the page's motion toggle). */
  readonly motion?: boolean;
  /** The agent whose beacon should carry the selection ring. */
  readonly selectedId?: string | null;
  /** A beacon was clicked: hand the existing page selection the agent id. */
  readonly onSelectAgent?: (id: string) => void;
  /** The empty part of the hologram was clicked: return to the live orchestration inspector. */
  readonly onClearSelection?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const beaconRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The draw loop is created once per motion change; agent changes are read from this ref so a
  // live snapshot update never restarts the random dust field.
  const agentsRef = useRef<readonly HoloAgent[]>(agents);
  agentsRef.current = agents;
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  // Hovering freezes the clock but keeps rendering, so a click can paint the selection ring on the
  // very next frame even while the scene is paused.
  const hoveredRef = useRef(false);
  const [hovered, setHovered] = useState(false);

  const setHoveredState = (value: boolean): void => {
    hoveredRef.current = value;
    setHovered(value);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext('2d');
    if (context === null) return;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 1;
    let height = 1;
    let frame = 0;
    let clock = 0;
    let lastFrame = 0;
    const running = motion && !reduced;

    const particles: Particle[] = Array.from({ length: 108 }, (_, index) => {
      // A spherical shell, not a cube: dust reads as a volume around the globe rather than a
      // square of noise. `y` is uniform on the sphere, which keeps the poles from clumping.
      const y = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const radial = Math.sqrt(Math.max(0, 1 - y * y));
      const shell = 0.45 + Math.pow(Math.random(), 0.7) * 0.78;
      return {
        x: Math.cos(theta) * radial * shell,
        y: y * shell * 0.94,
        z: Math.sin(theta) * radial * shell,
        size: 0.5 + Math.random() * 1.6,
        cool: index % 9 === 0,
      };
    });

    const resize = (): void => {
      // `getBoundingClientRect` would include the canvas's world zoom: at 145 % the backing store
      // would grow while the CSS box stayed 400 px, and every beacon would shrink relative to the
      // rings. The layout box is the coordinate space the projection is defined in.
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, canvas.clientWidth || rect.width);
      height = Math.max(1, canvas.clientHeight || rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!running) draw(performance.now());
    };

    const draw = (now: number): void => {
      // Accumulate time instead of subtracting a start stamp: pausing for a hover must not make
      // the orbit jump forward by the pause length when the pointer leaves.
      if (hoveredRef.current) {
        lastFrame = 0;
      } else if (reduced) {
        clock = 0;
      } else {
        if (lastFrame === 0) lastFrame = now;
        clock += (now - lastFrame) / 1000;
        lastFrame = now;
      }
      const time = clock;
      context.clearRect(0, 0, width, height);

      const radius = Math.min(width, height) / 2;
      const centerX = width / 2;
      const centerY = height / 2;
      const spin = time * 0.16;
      const cosSpin = Math.cos(spin);
      const sinSpin = Math.sin(spin);

      // --- Dust: additive so overlapping motes read as light, not paint ---------------------
      context.globalCompositeOperation = 'lighter';
      for (const particle of particles) {
        const rotatedX = particle.x * cosSpin - particle.z * sinSpin;
        const rotatedZ = particle.x * sinSpin + particle.z * cosSpin;
        const perspective = 1 / (1 + rotatedZ * 0.34);
        const screenX = centerX + rotatedX * radius * 0.99 * perspective;
        const screenY = centerY + particle.y * radius * 0.9 * perspective;
        if (screenX < -10 || screenX > width + 10 || screenY < -10 || screenY > height + 10) continue;
        const alpha = (0.08 + ((1 - rotatedZ) / 2) * 0.34).toFixed(3);
        const color = particle.cool ? '136, 224, 244' : '125, 231, 178';
        context.beginPath();
        context.arc(screenX, screenY, particle.size * (0.7 + perspective * 0.9), 0, Math.PI * 2);
        context.fillStyle = `rgba(${color}, ${alpha})`;
        context.fill();
      }
      context.globalCompositeOperation = 'source-over';

      // --- Agent beacons on one tilted orbit -------------------------------------------------
      // Projection order is far-to-near so a beacon in front of the core draws over one behind it.
      const seats = agentsRef.current.slice(0, 6);
      const beacons: Beacon[] = seats.map((agent, index) => {
        const phase = (index / Math.max(1, seats.length)) * Math.PI * 2 + 0.5;
        const angle = time * 0.3 + phase;
        const inclination = 0.34 + (index % 3) * 0.07;
        const x = Math.cos(angle);
        const z = Math.sin(angle);
        const depth = z * Math.cos(inclination);
        const perspective = 1 / (1 + depth * 0.35);
        const orbit = radius * 0.82;
        const near = Math.max(0, -depth);
        return {
          index,
          id: agent.id,
          x: centerX + x * orbit * perspective,
          y: centerY + z * Math.sin(inclination) * orbit * perspective,
          depth,
          scale: perspective,
          dot: (7.5 + near * 4) * perspective,
          tone: agent.tone,
          initials: initialsOf(agent.name),
        };
      });
      beacons.sort((left, right) => right.depth - left.depth);

      for (const beacon of beacons) {
        const near = Math.max(0, -beacon.depth);
        const alpha = 0.34 + near * 0.62;
        const dot = beacon.dot;
        const [red, green, blue] = TONE_COLOR[beacon.tone] ?? TONE_COLOR.neutral;

        // The transparent DOM button follows the same projected point: it owns the click and the
        // native tooltip, and a nearer beacon stacks above a farther one.
        const hit = beaconRefs.current[beacon.index];
        if (hit !== null && hit !== undefined) {
          hit.style.transform = `translate(${beacon.x.toFixed(1)}px, ${beacon.y.toFixed(1)}px) translate(-50%, -50%)`;
          hit.style.zIndex = String(10 + Math.round((1 - beacon.depth) * 10));
        }

        context.beginPath();
        context.arc(beacon.x, beacon.y, dot * 1.7, 0, Math.PI * 2);
        context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${(alpha * 0.11).toFixed(3)})`;
        context.fill();

        context.beginPath();
        context.arc(beacon.x, beacon.y, dot, 0, Math.PI * 2);
        context.fillStyle = `rgba(7, 14, 19, ${(0.5 + near * 0.35).toFixed(3)})`;
        context.fill();
        context.lineWidth = 1.2;
        context.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
        context.stroke();

        if (beacon.id === selectedRef.current) {
          context.beginPath();
          context.arc(beacon.x, beacon.y, dot + 5.5, 0, Math.PI * 2);
          context.strokeStyle = 'rgba(232, 255, 245, 0.9)';
          context.lineWidth = 1.5;
          context.stroke();
        }

        // Every seat keeps its initials; the far side is dimmer and smaller, never blank.
        if (beacon.scale > 0.7) {
          context.font = `700 ${Math.max(6, Math.round(8.5 * beacon.scale))}px ui-sans-serif, system-ui, sans-serif`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillStyle = `rgba(232, 255, 245, ${Math.min(1, alpha + 0.15).toFixed(3)})`;
          context.fillText(beacon.initials, beacon.x, beacon.y + 0.5);
        }
      }

      if (running) frame = requestAnimationFrame(draw);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [motion]);

  return (
    <div
      className={`holo-core${hovered ? ' hovered' : ''}${className === '' ? '' : ` ${className}`}`}
      aria-hidden="true"
    >
      <div className="holo-stage">
        <div className="holo-globe">
          {MERIDIANS.map((longitude) => (
            <i
              key={longitude}
              className="holo-meridian"
              style={{ ['--lon' as string]: `${longitude}deg` } as CSSProperties}
            />
          ))}
          {LATITUDES.map((latitude) => (
            <i
              key={latitude.y}
              className="holo-latitude"
              style={{ ['--lat-d' as string]: latitude.d, ['--lat-y' as string]: latitude.y } as CSSProperties}
            />
          ))}
        </div>
        <div className="holo-ring ring-outer" />
        <div className="holo-ring ring-mid" />
        <div className="holo-ring ring-inner" />
        <div className="holo-sweep" />
        <div className="holo-nucleus">
          <span>{label.slice(0, 1).toUpperCase()}</span>
        </div>
      </div>
      <div className="holo-beam" />
      <div className="holo-base">
        <i />
        <i />
        <i />
      </div>
      <canvas className="holo-particles" ref={canvasRef} />
      <div
        className="holo-hover"
        onPointerEnter={() => setHoveredState(true)}
        onPointerLeave={() => setHoveredState(false)}
        onClick={(event) => {
          event.stopPropagation();
          onClearSelection?.();
        }}
      >
        {agents.slice(0, 6).map((agent, index) => (
          <button
            key={agent.id}
            type="button"
            className="holo-beacon-hit"
            data-testid="holo-beacon"
            data-agent-id={agent.id}
            data-selected={selectedId === agent.id}
            title={agent.name}
            tabIndex={-1}
            ref={(element) => {
              beaconRefs.current[index] = element;
            }}
            // A pointer shortcut must not steal keyboard focus into the aria-hidden hologram;
            // screen-reader users select the same agent from the left-hand card.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onSelectAgent?.(agent.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

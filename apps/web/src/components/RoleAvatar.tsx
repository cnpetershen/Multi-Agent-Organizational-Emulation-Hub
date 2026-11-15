import type { ReactNode } from 'react';
import { roleIdentityOf, type RoleGlyph } from '../roles';

/**
 * The role mark worn by an agent.
 *
 * A monogram tells an operator nothing until they read the name; a role mark tells them who
 * they are looking at first and lets the name confirm it. The glyph is the work (code, shield,
 * palette, megaphone…) and the tone is the family from `roles.ts`; status is a dot, so the
 * same badge can still say "on duty" without losing its identity.
 *
 * The mark is decorative: every surface that shows one already prints the role beside it.
 * The native tooltip is where the full "Name · Role" identity lives for a pointer.
 */

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

/** The states a badge can tell apart without repainting its role colour. */
export type AvatarStatus = 'idle' | 'working' | 'paused' | 'archived' | 'vacant';

/**
 * The badge status behind one work-state kind (`derive.ts` `AgentStateKind`).
 *
 * A presence (`present`) is not a badge state: the badge only distinguishes the conditions an
 * operator acts on — someone working, someone paused, someone archived.
 */
export function avatarStatusOf(kind: string): AvatarStatus {
  if (kind === 'working') return 'working';
  if (kind === 'paused') return 'paused';
  if (kind === 'archived') return 'archived';
  return 'idle';
}

const GLYPHS: Readonly<Record<RoleGlyph, ReactNode>> = {
  crown: (
    <>
      <path d="M3.6 8.4 8.2 11 12 5.2 15.8 11l4.6-2.6-1.6 9.2H5.2L3.6 8.4Z" />
      <path d="M5.4 20.4h13.2" />
    </>
  ),
  chip: (
    <>
      <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.2" />
      <rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1" />
      <path d="M9.6 2.9v3.5M14.4 2.9v3.5M9.6 17.6v3.5M14.4 17.6v3.5M2.9 9.6h3.5M2.9 14.4h3.5M17.6 9.6h3.5M17.6 14.4h3.5" />
    </>
  ),
  code: (
    <>
      <path d="M9.3 7.7 5 12l4.3 4.3" />
      <path d="M14.7 7.7 19 12l-4.3 4.3" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="6.3" rx="1.9" />
      <rect x="4" y="13.7" width="16" height="6.3" rx="1.9" />
      <circle cx="7.3" cy="7.15" r="1" fill="currentColor" stroke="none" />
      <circle cx="7.3" cy="16.85" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2 18.4 5.6v5.8c0 4.1-2.7 7-6.4 8.4-3.7-1.4-6.4-4.3-6.4-8.4V5.6L12 3.2Z" />
      <path d="M9.4 11.9l1.8 1.8 3.4-3.5" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.4a8.6 8.6 0 1 0 0 17.2h1.5a2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.3h1.6a2.8 2.8 0 0 0 2.7-3.4A8.6 8.6 0 0 0 12 3.4Z" />
      <circle cx="7.9" cy="10.1" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.1" cy="9.7" r="1" fill="currentColor" stroke="none" />
      <circle cx="8.6" cy="14.7" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M15.4 8.6l-2.2 5L8.6 15.4l2.2-5 4.6-1.8Z" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5.4" y="4.6" width="13.2" height="16" rx="2.2" />
      <path d="M9.2 4.6V3.3h5.6v1.3" />
      <path d="M8.8 10h6.4M8.8 13.4h6.4M8.8 16.8h4" />
    </>
  ),
  flask: (
    <>
      <path d="M9.6 3.2h4.8" />
      <path d="M10.8 3.2v6.2l-4.3 7.3a2 2 0 0 0 1.7 3.1h7.6a2 2 0 0 0 1.7-3.1l-4.3-7.3V3.2" />
      <path d="M8.4 15.6h7.2" />
    </>
  ),
  megaphone: (
    <>
      <path d="M3.6 10.2v3.4a1.6 1.6 0 0 0 1.6 1.6H7l4 4V4.6l-4 4H5.2a1.6 1.6 0 0 0-1.6 1.6Z" />
      <path d="M14.6 8.6a4.8 4.8 0 0 1 0 6.8" />
      <path d="M17.6 6.1a8.3 8.3 0 0 1 0 11.8" />
    </>
  ),
  trend: (
    <>
      <path d="M4 17.4 9.2 12l3.4 3.4L20 8.2" />
      <path d="M14.7 8.2H20v5.3" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.3" />
      <path d="M12 2.8v2.5M12 18.7v2.5M2.8 12h2.5M18.7 12h2.5M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" />
    </>
  ),
  users: (
    <>
      <circle cx="9.2" cy="8" r="3.2" />
      <path d="M3.4 19.7a5.8 5.8 0 0 1 11.6 0" />
      <path d="M16 5.2a3.1 3.1 0 0 1 0 5.9" />
      <path d="M17.4 14.6a5.8 5.8 0 0 1 3.2 5.1" />
    </>
  ),
  wallet: (
    <>
      <rect x="3.5" y="6.2" width="17" height="12.2" rx="2.4" />
      <path d="M3.5 9.4h17" />
      <path d="M15.8 13.8h2.2" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M4.8 20.4a7.2 7.2 0 0 1 14.4 0" />
    </>
  ),
};

export function AgentAvatar({
  name,
  positionId,
  positionTitle,
  capabilities,
  expertise,
  kind,
  status = 'idle',
  size = 'md',
}: {
  /** The person's name — tooltip copy only; the role is what the mark stands for. */
  readonly name?: string | undefined;
  readonly positionId?: string | undefined;
  readonly positionTitle?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
  readonly expertise?: readonly string[] | undefined;
  /** `human` marks the seats a person actually holds (HAI 3.0), not the AI employees. */
  readonly kind?: string | null | undefined;
  readonly status?: AvatarStatus;
  readonly size?: AvatarSize;
}) {
  const identity = roleIdentityOf({ positionId, positionTitle, capabilities, expertise });
  const title = [name, positionTitle]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' · ') || undefined;
  return (
    <span
      className="agent-avatar"
      data-family={identity.family}
      data-glyph={identity.glyph}
      data-size={size}
      data-status={status}
      data-kind={kind === 'human' ? 'human' : 'agent'}
      title={title}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        {GLYPHS[identity.glyph]}
      </svg>
    </span>
  );
}

/** Small presentational building blocks shared by the screens. */
import type { ReactNode } from 'react';
import type { Tone } from '../../../bff/src/contract.ts';

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const toneClass = (t: Tone) => `tone-${t}`;
export const toneColor = (t: Tone) => `var(--${t})`;

export function Segmented<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  inline?: boolean;
}) {
  return (
    <div className={props.inline ? 'segmented inline' : 'segmented'} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chips<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="chips" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" className="chip" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="error" role="alert">
      {message}
    </div>
  );
}

export function Skeleton({ height, width = '100%' }: { height: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width, maxWidth: '100%' }} aria-hidden />;
}

export function Loading({ label = 'Loading forecast…' }: { label?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} aria-busy="true" aria-label={label}>
      <Skeleton height={20} width={260} />
      <Skeleton height={40} width={420} />
      <Skeleton height={230} />
      <Skeleton height={160} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Station combobox (WAI-ARIA 1.2 pattern) backed by /bff/stations. */
import { useId, useState } from 'react';
import type { StationOption } from '../../../bff/src/contract.ts';
import { useStations } from '../api.ts';

export function StationPicker(props: { label: string; value: StationOption | null; onChange: (s: StationOption) => void }) {
  const id = useId();
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const query = text ?? '';
  const { data = [] } = useStations(query);
  const options = text === null ? [] : data;
  const expanded = open && options.length > 0;

  const choose = (s: StationOption) => {
    props.onChange(s);
    setText(null);
    setOpen(false);
  };

  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        role="combobox"
        aria-expanded={expanded}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={expanded ? `${id}-${active}` : undefined}
        value={text ?? props.value?.name ?? ''}
        placeholder="Station"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          setText(null);
        }}
        onKeyDown={(e) => {
          if (!expanded) return;
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, options.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter') choose(options[active]!);
          else if (e.key === 'Escape') setOpen(false);
          else return;
          e.preventDefault();
        }}
      />
      {expanded && (
        <ul className="combo-list" role="listbox" id={`${id}-list`}>
          {options.map((s, i) => (
            <li
              key={s.eva}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {s.name}
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}

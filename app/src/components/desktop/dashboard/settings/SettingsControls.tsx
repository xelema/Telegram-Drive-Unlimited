import type { ReactNode } from 'react';

interface SettingsRowProps {
  icon: ReactNode;
  title: string;
  description: string;
  control: ReactNode;
}

export function SettingsRow({ icon, title, description, control }: SettingsRowProps) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <p className="text-sm font-medium text-telegram-text">{title}</p>
          <p className="text-xs text-telegram-subtext">{description}</p>
        </div>
      </div>
      {control}
    </div>
  );
}

interface SettingsToggleProps {
  checked: boolean;
  label: string;
  onChange: () => void;
}

export function SettingsToggle({ checked, label, onChange }: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-6 w-11 rounded-full transition-colors duration-200 ${checked ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
    >
      <span className={`absolute start-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

interface SettingsStepperProps {
  value: number;
  minimum: number;
  maximum: number;
  label: string;
  onChange: (value: number) => void;
}

export function SettingsStepper({ value, minimum, maximum, label, onChange }: SettingsStepperProps) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => onChange(Math.max(minimum, value - 1))}
        disabled={value <= minimum}
        aria-label={`Decrease ${label}`}
        className="flex h-7 w-7 items-center justify-center rounded-md bg-telegram-bg text-sm font-medium text-telegram-subtext transition hover:bg-telegram-border hover:text-telegram-text disabled:opacity-40"
      >
        -
      </button>
      <span className="w-5 text-center text-sm font-medium text-telegram-text">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(maximum, value + 1))}
        disabled={value >= maximum}
        aria-label={`Increase ${label}`}
        className="flex h-7 w-7 items-center justify-center rounded-md bg-telegram-bg text-sm font-medium text-telegram-subtext transition hover:bg-telegram-border hover:text-telegram-text disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
